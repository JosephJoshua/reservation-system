import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { idempotencyKeys, students } from './db/schema'
import { idempotency } from './idempotency'
import { startCoachSession } from './services/auth'
import { MAX_PHOTO_BYTES } from './services/feedback'
import { ADMIN_PASSWORD, type Harness, setup } from './test/harness'

/** Every row of every table that holds one of `needles`. */
function scan(h: Harness, needles: string[]) {
  const raw = h.db.$client
  const hits: string[] = []
  const tables = raw.prepare("select name from sqlite_master where type='table'").all() as {
    name: string
  }[]
  for (const { name } of tables) {
    for (const row of raw.prepare(`select * from "${name}"`).all()) {
      const text = JSON.stringify(row)
      for (const n of needles) if (text.includes(n)) hits.push(`${name} [${n}]`)
    }
  }
  return hits
}

function boundCoach(h: Harness, coachId: number) {
  h.db.$client.prepare('update coaches set openid = ? where id = ?').run('coach-openid', coachId)
  return startCoachSession(h.deps, coachId)
}

describe('answers kept for repeats and erased students', () => {
  it('drops what a coach and staff were answered about a student who deletes their account', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const coachToken = boundCoach(h, coach.id)
    const admin = await h.admin()
    const s = await h.student('A')
    await h.call('PUT', '/me', { name: '甲某某', phone: '13800000001' }, s)
    const studentId = (await h.call('GET', '/me', undefined, s)).json.id
    const slot = h.slot(coach.id, '2026-10-25', 10)
    const made = await h.call(
      'POST',
      '/admin/bookings',
      {
        studentId,
        slotId: slot.id,
        lessonTypeId: lesson.id,
        payWith: 'offline',
        amount: 20000,
        method: 'cash',
      },
      admin,
    )
    const id = made.json.bookingId
    const note = await h.call(
      'PUT',
      `/coach/lessons/${id}/note`,
      { note: '左手持拍' },
      coachToken,
      {
        'Idempotency-Key': 'c1',
      },
    )
    expect(note.status).toBe(200)
    expect(JSON.stringify(note.json)).toContain('甲某某')
    const profile = await h.call(
      'PUT',
      `/admin/students/${studentId}/profile`,
      { level: null, grip: null, tags: ['膝伤'], note: '膝盖旧伤保密备注' },
      admin,
      { 'Idempotency-Key': 'a1' },
    )
    expect(profile.status).toBe(200)

    h.clock.now = new Date('2026-10-26T02:00:00Z')
    expect((await h.call('DELETE', '/me', undefined, s)).status).toBe(204)
    expect(scan(h, ['甲某某', '13800000001', '膝盖旧伤保密备注', '左手持拍'])).toEqual([])
    // Kept as done: a repeat is not run again, and is told to reload.
    expect(
      h.db
        .select()
        .from(idempotencyKeys)
        .all()
        .map((r) => r.status),
    ).toEqual([200, 200])
    const again = await h.call(
      'PUT',
      `/coach/lessons/${id}/note`,
      { note: '左手持拍' },
      coachToken,
      { 'Idempotency-Key': 'c1' },
    )
    expect(again.status).toBe(409)
    expect(again.json.error.code).toBe('in_progress')
  })

  it('drops what staff were answered about a desk student they then delete', async () => {
    const h = setup()
    h.seed()
    const a = await h.admin()
    const made = await h.call(
      'POST',
      '/admin/students',
      { name: '独特名字', phone: '13912345678' },
      a,
      { 'Idempotency-Key': 'k1' },
    )
    expect(made.status).toBe(201)
    const id = made.json.id
    const put = await h.call(
      'PUT',
      `/admin/students/${id}/profile`,
      { level: null, grip: null, tags: ['怕球'], note: '膝盖旧伤保密备注' },
      a,
      { 'Idempotency-Key': 'k2' },
    )
    expect(put.status).toBe(200)
    const del = await h.call('DELETE', `/admin/students/${id}`, undefined, a, {
      'Idempotency-Key': 'k3',
    })
    expect(del.status).toBe(204)
    const rows = h.db.select().from(idempotencyKeys).all()
    expect(rows.every((r) => !r.body)).toBe(true)
    expect(JSON.stringify(rows)).not.toMatch(/独特名字|13912345678|膝盖旧伤/)
    // The deletion's own repeat still answers as it did.
    const again = await h.call('DELETE', `/admin/students/${id}`, undefined, a, {
      'Idempotency-Key': 'k3',
    })
    expect(again.status).toBe(204)
  })

  it('keeps answers for a WeChat account that joins a desk student with the joined student', async () => {
    const h = setup()
    const admin = await h.admin()
    const w = await h.student('W')
    await h.call('PUT', '/me', { name: '王五', phone: '13912345678' }, w, {
      'Idempotency-Key': 'k-me-1',
    })
    const desk = await h.call(
      'POST',
      '/admin/students',
      { name: '王五', phone: '13912345678', force: true },
      admin,
    )
    const code = (
      await h.call('POST', `/admin/students/${desk.json.id}/bind-code`, undefined, admin)
    ).json.code
    const linked = await h.call('POST', '/me/link', { code }, w, { 'Idempotency-Key': 'k-link-1' })
    expect(linked.status).toBe(204)
    const own = h.db
      .select()
      .from(idempotencyKeys)
      .all()
      .filter((r) => r.studentId !== null)
    expect(own.map((r) => r.studentId)).toEqual([desk.json.id, desk.json.id])
    expect((await h.call('DELETE', '/me', undefined, w)).status).toBe(204)
    expect(JSON.stringify(h.db.select().from(idempotencyKeys).all())).not.toContain('13912345678')
  })
})

describe('answers given before a student changed their details', () => {
  it('are dropped on erasure too, with the old name, phone, note and 档案', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const ct = boundCoach(h, coach.id)
    const admin = await h.admin()
    const s = await h.student('A')
    await h.call('PUT', '/me', { name: '甲某某', phone: '13800000001' }, s)
    const studentId = (await h.call('GET', '/me', undefined, s)).json.id
    const slot = h.slot(coach.id, '2026-10-25', 10)
    const made = await h.call(
      'POST',
      '/admin/bookings',
      {
        studentId,
        slotId: slot.id,
        lessonTypeId: lesson.id,
        payWith: 'offline',
        amount: 20000,
        method: 'cash',
      },
      admin,
    )
    const id = made.json.bookingId
    const note = await h.call('PUT', `/coach/lessons/${id}/note`, { note: '左手持拍旧备注' }, ct, {
      'Idempotency-Key': 'c1',
    })
    expect(note.status).toBe(200)
    const profile = await h.call(
      'PUT',
      `/admin/students/${studentId}/profile`,
      { level: null, grip: null, tags: ['旧标签膝伤'], note: '旧档案备注' },
      admin,
      { 'Idempotency-Key': 'a1' },
    )
    expect(profile.status).toBe(200)
    // Changed before the account is deleted.
    await h.call('PUT', '/me', { name: '乙某某', phone: '13900000002' }, s)
    await h.call('PUT', `/coach/lessons/${id}/note`, { note: '' }, ct)
    await h.call(
      'PUT',
      `/admin/students/${studentId}/profile`,
      { level: null, grip: null, tags: [], note: '' },
      admin,
    )
    h.clock.now = new Date('2026-10-26T02:00:00Z')
    expect((await h.call('DELETE', '/me', undefined, s)).status).toBe(204)
    expect(
      scan(h, ['甲某某', '13800000001', '左手持拍旧备注', '旧档案备注', '旧标签膝伤']),
    ).toEqual([])
  })
})

describe('a student erased while a staff answer is still being sent', () => {
  it('drops that answer, even when the erasure lands while its body is read', async () => {
    const h = setup()
    const s = await h.student('A')
    const studentId = (await h.call('GET', '/me', undefined, s)).json.id as number
    const admin = await h.admin()
    const app = new Hono()
    app.use('/api/*', idempotency(h.deps))
    app.post('/api/slow', () => {
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            // The student deletes their account while the answer is read out.
            h.db
              .update(students)
              .set({ deletedAt: h.deps.now() })
              .where(eq(students.id, studentId))
              .run()
            controller.enqueue(new TextEncoder().encode('{"name":"甲某某"}'))
            controller.close()
          },
          // Nothing is pulled before the answer is read.
        },
        { highWaterMark: 0 },
      )
      return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    const res = await app.request('/api/slow', {
      method: 'POST',
      headers: { Authorization: `Bearer ${admin}`, 'Idempotency-Key': 'slow-1' },
    })
    expect(await res.text()).toBe('{"name":"甲某某"}')
    expect(h.db.select().from(idempotencyKeys).all()).toMatchObject([
      { status: 200, body: null, contentType: null },
    ])
  })
})

describe('credential endpoints are never kept for repeats', () => {
  it('keeps no row for a login sent with a session and a key', async () => {
    const h = setup()
    const a = await h.admin()
    const res = await h.call(
      'POST',
      '/admin/login',
      { username: 'admin', password: ADMIN_PASSWORD },
      a,
      { 'Idempotency-Key': 'relogin-1' },
    )
    expect(res.status).toBe(200)
    expect(res.json.token).toBeTruthy()
    const changed = await h.call(
      'PUT',
      '/admin/me/password',
      { current: ADMIN_PASSWORD, password: 'new-password-1' },
      a,
      { 'Idempotency-Key': 'pw-1' },
    )
    expect(changed.status).toBeLessThan(500)
    const s = await h.student('A')
    await h.call('POST', '/auth/student', { code: 'dev:A' }, s, { 'Idempotency-Key': 'st-1' })
    // A new staff login carries its password.
    const staffMade = await h.call(
      'POST',
      '/admin/staff',
      { name: '前台小王', username: 'desk1', password: 'desk-password-1', roles: ['front_desk'] },
      a,
      { 'Idempotency-Key': 'staff-1' },
    )
    expect(staffMade.status).toBe(201)
    expect(h.db.select().from(idempotencyKeys).all()).toEqual([])
  })
})

describe('coach photo upload', () => {
  const CHUNK = 64 * 1024

  /**
   * Sends `bytes` of a form as a stream with no Content-Length, as a client may, and counts what
   * the server pulled from it.
   */
  async function streamed(h: Harness, token: string, bookingId: number, bytes: number) {
    let pulled = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= bytes) return controller.close()
        pulled += CHUNK
        controller.enqueue(new Uint8Array(CHUNK))
      },
    })
    const res = await h.app.request(`/api/coach/lessons/${bookingId}/photos`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': 'up-1',
        'Content-Type': 'multipart/form-data; boundary=x',
      },
      body,
      duplex: 'half',
    } as RequestInit)
    return { status: res.status, pulled }
  }

  async function lessonOf(h: Harness, { taught = false } = {}) {
    const { coach, lesson } = h.seed()
    const token = boundCoach(h, coach.id)
    const admin = await h.admin()
    const s = await h.student('A')
    const studentId = (await h.call('GET', '/me', undefined, s)).json.id
    const slot = h.slot(coach.id, '2026-10-25', 10)
    const made = await h.call(
      'POST',
      '/admin/bookings',
      {
        studentId,
        slotId: slot.id,
        lessonTypeId: lesson.id,
        payWith: 'offline',
        amount: 20000,
        method: 'cash',
      },
      admin,
    )
    const bookingId = made.json.bookingId as number
    if (taught) {
      h.clock.now = new Date('2026-10-25T03:05:00Z')
      const marked = await h.call(
        'PUT',
        `/coach/lessons/${bookingId}/attendance`,
        { attendance: 'attended' },
        token,
      )
      expect(marked.status).toBe(200)
    }
    return { token, bookingId }
  }

  it('stops reading one too large at the photo limit, before idempotency reads it', async () => {
    const h = setup()
    const { token, bookingId } = await lessonOf(h, { taught: true })
    const res = await streamed(h, token, bookingId, 9 * 1024 * 1024)
    expect(res.status).toBe(413)
    expect(res.pulled).toBeLessThanOrEqual(MAX_PHOTO_BYTES + 4 * CHUNK)
    expect(h.db.select().from(idempotencyKeys).all()).toEqual([])
  })

  it('refuses one for a lesson that takes no photos yet without reading it', async () => {
    const h = setup()
    // Not yet taught: no feedback can be written.
    const { token, bookingId } = await lessonOf(h)
    const res = await streamed(h, token, bookingId, 4 * 1024 * 1024)
    expect(res.status).toBe(409)
    expect(res.pulled).toBeLessThanOrEqual(4 * CHUNK)
    expect(h.db.select().from(idempotencyKeys).all()).toEqual([])
  })
})
