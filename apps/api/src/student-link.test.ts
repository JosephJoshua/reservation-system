import { POLICY_VERSION } from '@rs/shared'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { bookings, packageProducts, slots, studentProfiles, students } from './db/schema'
import { type Harness, setup } from './test/harness'

async function deskStudent(h: Harness, admin: string, name = '张三', phone = '13800000001') {
  const res = await h.call('POST', '/admin/students', { name, phone }, admin)
  expect(res.status).toBe(201)
  return res.json.id as number
}

async function bindCode(h: Harness, admin: string, id: number) {
  const res = await h.call('POST', `/admin/students/${id}/bind-code`, undefined, admin)
  expect(res.status).toBe(201)
  return res.json.code as string
}

function product(h: Harness, lessonTypeId: number) {
  return h.db
    .insert(packageProducts)
    .values({ name: '10节私教', lessonTypeId, lessonCount: 10, price: 180000, validityDays: 90 })
    .returning()
    .get()
}

async function sell(h: Harness, admin: string, studentId: number, productId: number) {
  const res = await h.call(
    'POST',
    '/admin/packages/offline-sale',
    { studentId, productId, amount: 180000, method: 'cash' },
    admin,
  )
  expect(res.status).toBe(201)
  return res.json.packageId as number
}

async function deskBooking(h: Harness, admin: string, studentId: number, slotId: number) {
  const res = await h.call(
    'POST',
    '/admin/bookings',
    { studentId, slotId, lessonTypeId: 1, payWith: 'package' },
    admin,
  )
  expect(res.status).toBe(201)
  return res.json.bookingId as number
}

describe('front-desk students', () => {
  it('books and sells to a student who never opened the mini program', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const admin = await h.admin()
    const id = await deskStudent(h, admin)
    await sell(h, admin, id, product(h, lesson.id).id)
    await deskBooking(h, admin, id, h.slot(coach.id).id)

    const detail = await h.call('GET', `/admin/students/${id}`, undefined, admin)
    expect(detail.json).toMatchObject({ name: '张三', phone: '13800000001', wechatBound: false })
    expect(detail.json.bookings).toHaveLength(1)
    expect(detail.json.packages[0].lessonsRemaining).toBe(9)

    const desk = await h.call('GET', '/admin/students?desk=1', undefined, admin)
    expect(desk.json.map((s: { id: number }) => s.id)).toEqual([id])
    const log = await h.call('GET', `/admin/actions?studentId=${id}`, undefined, admin)
    expect(log.json.map((e: { action: string }) => e.action)).toContain('student.create')
  })

  it('warns about a phone another student has, and adds them when the desk insists', async () => {
    const h = setup()
    const admin = await h.admin()
    const token = await h.student('a')
    await h.call('PUT', '/me', { name: '李四', phone: '13800000001' }, token)

    const refused = await h.call(
      'POST',
      '/admin/students',
      { name: '张三', phone: '13800000001' },
      admin,
    )
    expect(refused.status).toBe(409)
    expect(refused.json.error).toMatchObject({ code: 'phone_exists' })
    expect(refused.json.error.message).toContain('李四')

    const forced = await h.call(
      'POST',
      '/admin/students',
      { name: '张三', phone: '13800000001', force: true },
      admin,
    )
    expect(forced.status).toBe(201)

    // Both are flagged, and the desk finds each by 学员编号.
    const list = (await h.call('GET', '/admin/students', undefined, admin)).json
    expect(list.map((s: { phoneShared: boolean }) => s.phoneShared)).toEqual([true, true])
    const detail = (await h.call('GET', `/admin/students/${forced.json.id}`, undefined, admin)).json
    expect(detail.samePhone).toEqual([{ id: 1, name: '李四' }])
    const byId = (await h.call('GET', `/admin/students?q=${forced.json.id}`, undefined, admin)).json
    expect(byId.map((s: { id: number }) => s.id)).toEqual([forced.json.id])
  })

  it('refuses a bad name or phone', async () => {
    const h = setup()
    const admin = await h.admin()
    for (const body of [
      { name: '', phone: '13800000001' },
      { name: '张三', phone: '1380000000' },
      { name: '张三', phone: '23800000001' },
    ]) {
      expect((await h.call('POST', '/admin/students', body, admin)).status).toBe(400)
    }
  })

  it('never sends a WeChat message to a front-desk student', async () => {
    const h = setup()
    const sent: string[] = []
    h.deps.notifier = {
      template: (kind) => ({ id: `t-${kind}`, fields: { thing1: 'lesson' } }),
      send: async (openid) => {
        sent.push(openid)
        return 'sent'
      },
    }
    const { coach, lesson } = h.seed()
    const admin = await h.admin()
    const id = await deskStudent(h, admin)
    await sell(h, admin, id, product(h, lesson.id).id)
    await deskBooking(h, admin, id, h.slot(coach.id).id)
    const { notifyStudents } = await import('./services/student-notices')
    await notifyStudents(h.deps)
    expect(sent).toEqual([])

    // Once linked, the booking message gets another try.
    const token = await h.student('wx')
    await h.call('POST', '/me/link', { code: await bindCode(h, admin, id) }, token)
    await notifyStudents(h.deps)
    expect(sent).toEqual(['dev_wx'])
  })
})

describe('linking a front-desk student to their WeChat', () => {
  it('moves the desk records onto the WeChat account and keeps the desk student id', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const admin = await h.admin()
    const id = await deskStudent(h, admin)
    const pkg = await sell(h, admin, id, product(h, lesson.id).id)
    const booking = await deskBooking(h, admin, id, h.slot(coach.id).id)
    const code = await bindCode(h, admin, id)

    const token = await h.student('wx')
    const linked = await h.call('POST', '/me/link', { code: code.toLowerCase() }, token)
    expect(linked.status).toBe(204)

    // The same session now is the desk student.
    const me = await h.call('GET', '/me', undefined, token)
    expect(me.json).toMatchObject({ id, name: '张三', phone: '13800000001', agreedPolicies: true })
    const packages = await h.call('GET', '/packages', undefined, token)
    expect(packages.json.map((p: { id: number }) => p.id)).toEqual([pkg])
    const bookings = await h.call('GET', '/bookings', undefined, token)
    expect(JSON.stringify(bookings.json)).toContain(`"id":${booking}`)
    expect((await h.call('GET', `/admin/students/${id}`, undefined, admin)).json.wechatBound).toBe(
      true,
    )

    // Logging in again finds the same student.
    const again = await h.student('wx')
    expect((await h.call('GET', '/me', undefined, again)).json.id).toBe(id)
    // The code is used up for anyone else.
    const other = await h.student('other')
    expect((await h.call('POST', '/me/link', { code }, other)).status).toBe(400)
    // No new code for a linked student.
    const more = await h.call('POST', `/admin/students/${id}/bind-code`, undefined, admin)
    expect(more.json.error).toMatchObject({ code: 'already_bound' })
  })

  it('answers a repeated link from the same WeChat the same way', async () => {
    const h = setup()
    const admin = await h.admin()
    const id = await deskStudent(h, admin)
    const code = await bindCode(h, admin, id)
    const token = await h.student('wx')
    const [a, b] = await Promise.all([
      h.call('POST', '/me/link', { code }, token),
      h.call('POST', '/me/link', { code }, token),
    ])
    expect([a.status, b.status]).toEqual([204, 204])
    expect((await h.call('POST', '/me/link', { code }, token)).status).toBe(204)
    expect((await h.call('GET', '/me', undefined, token)).json.id).toBe(id)
  })

  it('joins a WeChat account that already has its own records', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const admin = await h.admin()
    const token = await h.student('wx')
    await h.call('PUT', '/me', { name: '小张', phone: '13900000000' }, token)
    const wxId = (await h.call('GET', '/me', undefined, token)).json.id
    const own = await sell(h, admin, wxId, product(h, lesson.id).id)
    h.db
      .insert(studentProfiles)
      .values({ studentId: wxId, note: 'old', updatedAt: new Date('2026-10-01') })
      .run()

    const id = await deskStudent(h, admin)
    const desk = await sell(h, admin, id, product(h, lesson.id).id)
    await deskBooking(h, admin, id, h.slot(coach.id).id)
    h.db
      .insert(studentProfiles)
      .values({ studentId: id, note: 'new', updatedAt: new Date('2026-10-20') })
      .run()

    const code = await bindCode(h, admin, id)
    // The student is asked first, since one WeChat is one student.
    const asked = await h.call('POST', '/me/link', { code }, token)
    expect(asked.json.error.code).toBe('confirm_merge')
    expect((await h.call('GET', '/me', undefined, token)).json.id).toBe(wxId)
    expect((await h.call('POST', '/me/link', { code, merge: true }, token)).status).toBe(204)
    const me = (await h.call('GET', '/me', undefined, token)).json
    // The desk wrote down the person who comes to class.
    expect(me).toMatchObject({ id, name: '张三', phone: '13800000001' })
    const pkgs = (await h.call('GET', '/packages', undefined, token)).json
    expect(pkgs.map((p: { id: number }) => p.id).sort()).toEqual([own, desk].sort())
    expect(h.db.select().from(students).where(eq(students.id, wxId)).get()).toBeUndefined()
    const profile = (await h.call('GET', `/admin/students/${id}`, undefined, admin)).json.profile
    expect(profile.note).toBe('new')
    const orders = (await h.call('GET', '/admin/orders', undefined, admin)).json
    expect(JSON.stringify(orders)).not.toContain(`"studentId":${wxId}`)
  })

  it('refuses when both accounts have a lesson at the same time', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const other = h.db
      .insert((await import('./db/schema')).coaches)
      .values({ name: '李教练' })
      .returning()
      .get()
    const admin = await h.admin()
    const token = await h.student('wx')
    const wxId = (await h.call('GET', '/me', undefined, token)).json.id
    await sell(h, admin, wxId, product(h, lesson.id).id)
    const id = await deskStudent(h, admin)
    await sell(h, admin, id, product(h, lesson.id).id)
    await deskBooking(h, admin, wxId, h.slot(coach.id).id)
    const { coachLessonTypes } = await import('./db/schema')
    h.db.insert(coachLessonTypes).values({ coachId: other.id, lessonTypeId: lesson.id }).run()
    await deskBooking(h, admin, id, h.slot(other.id).id)

    const res = await h.call(
      'POST',
      '/me/link',
      // Refused before the student is asked to confirm the merge.
      { code: await bindCode(h, admin, id) },
      token,
    )
    expect(res.status).toBe(409)
    expect(res.json.error.code).toBe('lesson_clash')
    expect((await h.call('GET', '/me', undefined, token)).json.id).toBe(wxId)
  })

  it('refuses when both accounts hold a seat in one group session, even after it ended', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const admin = await h.admin()
    const token = await h.student('wx')
    const wxId = (await h.call('GET', '/me', undefined, token)).json.id
    const id = await deskStudent(h, admin)
    const slot = h.slot(coach.id)
    h.db
      .update(slots)
      .set({ lessonTypeId: lesson.id, capacity: 4 })
      .where(eq(slots.id, slot.id))
      .run()
    for (const [studentId, seat] of [
      [wxId, 1],
      [id, 2],
    ]) {
      h.db
        .insert(bookings)
        .values({
          slotId: slot.id,
          seat,
          studentId,
          lessonTypeId: lesson.id,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          status: 'confirmed',
          paidWith: 'order',
          price: 0,
        })
        .run()
    }
    // The session is over by now.
    h.clock.now = new Date(slot.endsAt.getTime() + 3_600_000)
    const res = await h.call(
      'POST',
      '/me/link',
      { code: await bindCode(h, await h.admin(), id), merge: true },
      token,
    )
    expect(res.status).toBe(409)
    expect(res.json.error.code).toBe('lesson_clash')
  })

  it('needs consent, a live code and limits guesses', async () => {
    const h = setup()
    const admin = await h.admin()
    const id = await deskStudent(h, admin)
    const code = await bindCode(h, admin, id)

    const fresh = await h.student('wx', { agreed: false })
    expect((await h.call('POST', '/me/link', { code }, fresh)).json.error.code).toBe(
      'consent_required',
    )
    await h.call('POST', '/me/consent', { version: POLICY_VERSION }, fresh)

    // A day later the code is gone.
    h.clock.now = new Date(h.clock.now.getTime() + 24 * 3_600_000 + 1)
    expect((await h.call('POST', '/me/link', { code }, fresh)).json.error.code).toBe(
      'bad_bind_code',
    )

    for (let i = 0; i < 9; i++) await h.call('POST', '/me/link', { code: 'AAAAAAAA' }, fresh)
    const fresh2 = await bindCode(h, await h.admin(), id)
    expect((await h.call('POST', '/me/link', { code: fresh2 }, fresh)).status).toBe(429)
  })

  it('lets staff delete a desk student who never linked, but not a linked one', async () => {
    const h = setup()
    const { lesson } = h.seed()
    const admin = await h.admin()
    const id = await deskStudent(h, admin)
    const pkg = await sell(h, admin, id, product(h, lesson.id).id)
    const blocked = await h.call('DELETE', `/admin/students/${id}`, undefined, admin)
    expect(blocked.json.error.code).toBe('account_in_use')
    expect(blocked.json.error.message).toContain('该学员')

    void pkg
    const empty = await deskStudent(h, admin, '王五', '13800000002')
    expect((await h.call('DELETE', `/admin/students/${empty}`, undefined, admin)).status).toBe(204)
    const gone = (await h.call('GET', `/admin/students/${empty}`, undefined, admin)).json
    expect(gone).toMatchObject({ name: '', phone: '' })
    expect(gone.deletedAt).not.toBeNull()

    const token = await h.student('wx')
    const linked = await deskStudent(h, admin, '赵六', '13800000003')
    await h.call('POST', '/me/link', { code: await bindCode(h, admin, linked) }, token)
    const res = await h.call('DELETE', `/admin/students/${linked}`, undefined, admin)
    expect(res.json.error.code).toBe('already_bound')
  })
})
