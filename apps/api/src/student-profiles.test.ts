import { versionOf } from '@rs/shared'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
  actionLog,
  bookings,
  coaches,
  coachLessonTypes,
  lessonFeedback,
  studentProfiles,
} from './db/schema'
import { type Harness, setup } from './test/harness'

// The harness clock is 2026-10-23 10:00 at the venue.

const NOTE = '反手推挡偏慢，下次多练步法'

const profile = (over: Record<string, unknown> = {}) => ({
  level: 'intermediate',
  grip: 'penhold',
  tags: ['反手弱', '比赛型'],
  note: NOTE,
  ...over,
})

async function bindCoach(h: Harness, coachId: number, wx = 'coach') {
  const admin = await h.admin()
  const { code } = (await h.call('POST', `/admin/coaches/${coachId}/bind-code`, {}, admin)).json
  const res = await h.call('POST', '/coach/bind', { code: `dev:${wx}`, bindCode: code })
  return res.json.token as string
}

/** A student with a paid lesson on 10-25 at 10:00. */
async function booked(h: Harness) {
  const { coach, lesson } = h.seed()
  const t = await h.student('a')
  await h.call('PUT', '/me', { name: '张三', phone: '13800000000' }, t)
  const res = await h.call(
    'POST',
    '/bookings',
    { slotId: h.slot(coach.id, '2026-10-25', 10).id, lessonTypeId: lesson.id },
    t,
  )
  await h.call('POST', `/dev/fake-pay/${res.json.orderId}`)
  const studentId = (await h.call('GET', '/me', undefined, t)).json.id as number
  return { coach, lesson, t, studentId, bookingId: res.json.bookingId as number }
}

describe('学员档案', () => {
  it('is empty until staff fill it, and saves cleaned tags', async () => {
    const h = setup()
    const { studentId } = await booked(h)
    const admin = await h.admin()
    const before = await h.call('GET', `/admin/students/${studentId}`, undefined, admin)
    expect(before.json.profile).toEqual({
      level: null,
      grip: null,
      tags: [],
      note: '',
      lessons: 0,
      noShows: 0,
      feedbackCount: 0,
      updatedBy: null,
      updatedAt: null,
    })

    const saved = await h.call(
      'PUT',
      `/admin/students/${studentId}/profile`,
      profile({ tags: [' 反手弱 ', '', '比赛型', '反手弱'], note: `  ${NOTE}\n` }),
      admin,
    )
    expect(saved.status).toBe(200)
    expect(saved.json).toMatchObject({ tags: ['反手弱', '比赛型'], note: NOTE })
    const after = await h.call('GET', `/admin/students/${studentId}`, undefined, admin)
    expect(after.json.profile).toMatchObject(profile())
  })

  it('logs which fields changed but never what was written, and a repeat logs nothing', async () => {
    const h = setup()
    const { studentId } = await booked(h)
    const admin = await h.admin()
    const put = () => h.call('PUT', `/admin/students/${studentId}/profile`, profile(), admin)
    expect((await put()).status).toBe(200)
    expect((await put()).status).toBe(200)
    await h.call('PUT', `/admin/students/${studentId}/profile`, profile({ grip: null }), admin)
    const entries = h.db.select().from(actionLog).all()
    expect(entries.map((e) => [e.action, e.summary, e.studentId])).toEqual([
      ['student.update', '修改档案：水平、握拍、标签、备注', studentId],
      ['student.update', '修改档案：握拍', studentId],
    ])
    expect(JSON.stringify(entries)).not.toContain('反手弱')
  })

  it('refuses bad values', async () => {
    const h = setup()
    const { studentId } = await booked(h)
    const admin = await h.admin()
    for (const body of [
      profile({ level: 'pro' }),
      profile({ grip: 'both' }),
      profile({ tags: Array.from({ length: 9 }, (_, i) => `标签${i}`) }),
      profile({ tags: ['一二三四五六七八九十一'] }),
      profile({ note: 'x'.repeat(501) }),
      { level: null, grip: null, tags: [] },
    ]) {
      const res = await h.call('PUT', `/admin/students/${studentId}/profile`, body, admin)
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
    expect(
      (await h.call('PUT', '/admin/students/999/profile', profile(), admin)).json.error.code,
    ).toBe('not_found')
    expect(h.db.select().from(studentProfiles).all()).toHaveLength(0)
  })

  it('says what is wrong with the tags in product copy', async () => {
    const h = setup()
    const { studentId } = await booked(h)
    const admin = await h.admin()
    const put = (tags: string[]) =>
      h.call('PUT', `/admin/students/${studentId}/profile`, profile({ tags }), admin)
    const nine = await put(Array.from({ length: 9 }, (_, i) => `标签${i}`))
    expect(nine.json.error.message).toBe('最多 8 个标签')
    const long = await put(['正手拉球发力不足需要重点练习'])
    expect(long.json.error.message).toBe('每个标签不超过 10 个字')
  })

  it('counts characters as people do, and tags after repeats and blanks are dropped', async () => {
    const h = setup()
    const { studentId } = await booked(h)
    const admin = await h.admin()
    const eight = Array.from({ length: 8 }, (_, i) => `标签${i}`)
    const res = await h.call(
      'PUT',
      `/admin/students/${studentId}/profile`,
      // An emoji is two UTF-16 units but one character, as the admin's counter shows it.
      profile({
        tags: [...eight, '标签0', ' ', '🏓'.repeat(10)].slice(0, 11),
        note: '🏓'.repeat(500),
      }),
      admin,
    )
    expect(res.status).toBe(400)
    const ok = await h.call(
      'PUT',
      `/admin/students/${studentId}/profile`,
      profile({
        tags: [...eight.slice(0, 7), '标签0', ' ', '🏓'.repeat(10)],
        note: '🏓'.repeat(500),
      }),
      admin,
    )
    expect(ok.status).toBe(200)
    expect(ok.json.tags).toEqual([...eight.slice(0, 7), '🏓'.repeat(10)])
    expect(ok.json.note).toBe('🏓'.repeat(500))
    const long = await h.call(
      'PUT',
      `/admin/students/${studentId}/profile`,
      profile({ tags: [], note: '🏓'.repeat(501) }),
      admin,
    )
    expect(long.status).toBe(400)
  })

  it('refuses a save on top of a change made since the editor loaded it', async () => {
    const h = setup()
    const { studentId } = await booked(h)
    const admin = await h.admin()
    const loaded = (await h.call('GET', `/admin/students/${studentId}`, undefined, admin)).json
      .profile
    const ifMatch = { 'If-Match': versionOf({ level: null, grip: null, tags: [], note: '' }) }
    expect(loaded).toMatchObject({ level: null, grip: null, tags: [], note: '' })
    const path = `/admin/students/${studentId}/profile`
    expect((await h.call('PUT', path, profile(), admin, ifMatch)).status).toBe(200)
    // The same save again, as a double click without a key would send it, goes through.
    expect((await h.call('PUT', path, profile(), admin, ifMatch)).status).toBe(200)
    // A second editor who loaded the empty profile is refused.
    const other = await h.call('PUT', path, profile({ note: '别的' }), admin, ifMatch)
    expect(other.json.error.code).toBe('edited_elsewhere')
    expect(h.db.select().from(studentProfiles).get()?.note).toBe(NOTE)
  })

  it('counts lessons and no-shows across the venue', async () => {
    const h = setup()
    const { coach, lesson, t, studentId, bookingId } = await booked(h)
    const book = async (date: string, hour: number) => {
      const res = await h.call(
        'POST',
        '/bookings',
        { slotId: h.slot(coach.id, date, hour).id, lessonTypeId: lesson.id },
        t,
      )
      await h.call('POST', `/dev/fake-pay/${res.json.orderId}`)
      return res.json.bookingId as number
    }
    const missed = await book('2026-10-24', 10)
    const unmarked = await book('2026-10-24', 14)
    const cancelled = await book('2026-10-27', 10)
    await h.call('POST', `/bookings/${cancelled}/cancel`, {}, t)
    await book('2026-10-28', 10)
    h.clock.now = new Date('2026-10-25T03:30:00Z') // 10-25 11:30, the first lesson is over
    h.db.update(bookings).set({ attendance: 'attended' }).where(eq(bookings.id, bookingId)).run()
    h.db.update(bookings).set({ attendance: 'no_show' }).where(eq(bookings.id, missed)).run()

    const admin = await h.admin()
    const p = (await h.call('GET', `/admin/students/${studentId}`, undefined, admin)).json.profile
    // Attended and unmarked ended lessons count; the no-show, the cancel and the future one do not.
    expect(p).toMatchObject({ lessons: 2, noShows: 1 })
    expect(unmarked).toBeGreaterThan(0)
  })

  it('shows the coach the profile, and never the student', async () => {
    const h = setup()
    const { coach, t, studentId, bookingId } = await booked(h)
    const admin = await h.admin()
    await h.call('PUT', `/admin/students/${studentId}/profile`, profile(), admin)
    const ct = await bindCoach(h, coach.id)
    const lessonView = await h.call('GET', `/coach/lessons/${bookingId}`, undefined, ct)
    expect(lessonView.json.profile).toEqual({
      ...profile(),
      lessons: 0,
      noShows: 0,
      feedbackCount: 0,
      // Coaches see the venue, not which staff member saved it.
      updatedBy: { kind: 'staff', name: '场馆' },
      updatedAt: '2026-10-23T02:00:00.000Z',
    })
    expect(JSON.stringify(lessonView.json)).not.toContain('管理员')

    // Once the lesson is cancelled the coach no longer sees it.
    await h.call('POST', `/bookings/${bookingId}/cancel`, {}, t)
    const cancelled = await h.call('GET', `/coach/lessons/${bookingId}`, undefined, ct)
    expect(cancelled.json.status).toBe('cancelled')
    expect(cancelled.json.profile).toBeNull()

    for (const path of ['/me', '/bookings', `/bookings/${bookingId}`, '/feedback', '/home']) {
      const res = await h.call('GET', path, undefined, t)
      expect(res.status, path).toBe(200)
      const text = JSON.stringify(res.json)
      expect(text, path).not.toContain(NOTE)
      expect(text, path).not.toContain('比赛型')
    }
  })

  it('stays on a lesson for a week after it ends, then leaves it', async () => {
    const h = setup()
    const { coach, studentId, bookingId } = await booked(h)
    await h.call('PUT', `/admin/students/${studentId}/profile`, profile(), await h.admin())
    // The lesson ends 10-25 11:00 at the venue.
    h.clock.now = new Date('2026-11-01T02:59:00Z')
    let ct = await bindCoach(h, coach.id)
    const week = await h.call('GET', `/coach/lessons/${bookingId}`, undefined, ct)
    expect(week.json.profile).toMatchObject({ note: NOTE, lessons: 1 })
    h.clock.now = new Date('2026-11-01T03:01:00Z')
    ct = await bindCoach(h, coach.id)
    const later = await h.call('GET', `/coach/lessons/${bookingId}`, undefined, ct)
    expect(later.status).toBe(200)
    expect(later.json.profile).toBeNull()
  })

  it('goes with the account when the student deletes it', async () => {
    const h = setup()
    const { coach, t, studentId, bookingId } = await booked(h)
    let admin = await h.admin()
    await h.call('PUT', `/admin/students/${studentId}/profile`, profile(), admin)
    h.clock.now = new Date('2026-10-25T04:00:00Z') // after the lesson, which stays confirmed
    expect((await h.call('DELETE', '/me', undefined, t)).status).toBe(204)

    expect(h.db.select().from(studentProfiles).all()).toHaveLength(0)
    admin = await h.admin()
    const detail = await h.call('GET', `/admin/students/${studentId}`, undefined, admin)
    expect(detail.json.profile).toMatchObject({ level: null, grip: null, tags: [], note: '' })
    const put = await h.call('PUT', `/admin/students/${studentId}/profile`, profile(), admin)
    expect(put.json.error.code).toBe('account_deleted')
    const ct = await bindCoach(h, coach.id)
    const view = await h.call('GET', `/coach/lessons/${bookingId}`, undefined, ct)
    expect(view.json.profile).toBeNull()
  })
})

describe('学员档案 kept by coaches', () => {
  const path = (bookingId: number) => `/coach/lessons/${bookingId}/profile`
  const EMPTY = versionOf({ level: null, grip: null, tags: [], note: '' })

  it('saves from the lesson page, says which coach saved it, and keeps the staff log for staff', async () => {
    const h = setup()
    const { coach, studentId, bookingId } = await booked(h)
    const ct = await bindCoach(h, coach.id)
    const res = await h.call(
      'PUT',
      path(bookingId),
      profile({ tags: [' 反手弱 ', '反手弱'] }),
      ct,
      { 'If-Match': EMPTY },
    )
    expect(res.status).toBe(200)
    expect(res.json.profile).toMatchObject({
      ...profile({ tags: ['反手弱'] }),
      updatedBy: { kind: 'coach', name: '王教练' },
      updatedAt: '2026-10-23T02:00:00.000Z',
    })
    expect(h.db.select().from(actionLog).all()).toHaveLength(0)

    // Staff still edit it, and then they are the last to have saved it.
    h.clock.now = new Date('2026-10-23T03:00:00Z')
    const admin = await h.admin()
    const saved = await h.call(
      'PUT',
      `/admin/students/${studentId}/profile`,
      profile({ grip: 'shakehand', tags: ['反手弱'] }),
      admin,
      { 'If-Match': versionOf(profile({ tags: ['反手弱'] })) },
    )
    expect(saved.json).toMatchObject({
      grip: 'shakehand',
      updatedBy: { kind: 'staff', name: '管理员' },
      updatedAt: '2026-10-23T03:00:00.000Z',
    })
    expect(h.db.select().from(actionLog).all()).toHaveLength(1)
  })

  it('refuses a save on top of a change by the venue or another coach, but not a repeat', async () => {
    const h = setup()
    const { coach, lesson, studentId, bookingId, t } = await booked(h)
    const other = h.db.insert(coaches).values({ name: '李教练' }).returning().get()
    h.db.insert(coachLessonTypes).values({ coachId: other.id, lessonTypeId: lesson.id }).run()
    const res = await h.call(
      'POST',
      '/bookings',
      { slotId: h.slot(other.id, '2026-10-26', 10).id, lessonTypeId: lesson.id },
      t,
    )
    await h.call('POST', `/dev/fake-pay/${res.json.orderId}`)
    const otherBooking = res.json.bookingId as number
    const wang = await bindCoach(h, coach.id)
    const li = await bindCoach(h, other.id, 'coach2')

    const first = await h.call('PUT', path(bookingId), profile(), wang, { 'If-Match': EMPTY })
    expect(first.status).toBe(200)
    // A double tap sends the same save again.
    const again = await h.call('PUT', path(bookingId), profile(), wang, { 'If-Match': EMPTY })
    expect(again.status).toBe(200)
    // 李教练 opened the editor before 王教练 saved.
    const late = await h.call('PUT', path(otherBooking), profile({ note: '别的' }), li, {
      'If-Match': EMPTY,
    })
    expect(late.status).toBe(409)
    expect(late.json.error.code).toBe('edited_elsewhere')
    // After loading the lesson again 李教练 sees it and can change it.
    const seen = (await h.call('GET', `/coach/lessons/${otherBooking}`, undefined, li)).json
    expect(seen.profile).toMatchObject({ note: NOTE, updatedBy: { name: '王教练' } })
    const ok = await h.call('PUT', path(otherBooking), profile({ note: '别的' }), li, {
      'If-Match': versionOf(profile()),
    })
    expect(ok.json.profile).toMatchObject({ note: '别的', updatedBy: { name: '李教练' } })

    // The venue's save on top of a coach's is refused too.
    const admin = await h.admin()
    const staffLate = await h.call(
      'PUT',
      `/admin/students/${studentId}/profile`,
      profile({ level: 'advanced' }),
      admin,
      { 'If-Match': versionOf(profile()) },
    )
    expect(staffLate.json.error.code).toBe('edited_elsewhere')
  })

  it('refuses bad values like the admin does', async () => {
    const h = setup()
    const { coach, bookingId } = await booked(h)
    const ct = await bindCoach(h, coach.id)
    const nine = await h.call(
      'PUT',
      path(bookingId),
      profile({ tags: Array.from({ length: 9 }, (_, i) => `标签${i}`) }),
      ct,
    )
    expect(nine.json.error.message).toBe('最多 8 个标签')
    const long = await h.call('PUT', path(bookingId), profile({ note: 'x'.repeat(501) }), ct)
    expect(long.status).toBe(400)
    expect(h.db.select().from(studentProfiles).all()).toHaveLength(0)
  })

  it('is only open on the coach own lesson, while it is on and for a week after', async () => {
    const h = setup()
    const { coach, lesson, t, bookingId } = await booked(h)
    const other = h.db.insert(coaches).values({ name: '李教练' }).returning().get()
    h.db.insert(coachLessonTypes).values({ coachId: other.id, lessonTypeId: lesson.id }).run()
    const li = await bindCoach(h, other.id, 'coach2')
    const notOwn = await h.call('PUT', path(bookingId), profile(), li)
    expect(notOwn.status).toBe(404)
    expect(
      (await h.call('GET', `/coach/lessons/${bookingId}/student-feedback`, undefined, li)).status,
    ).toBe(404)

    // Ends 10-25 11:00 at the venue; open until a week later.
    h.clock.now = new Date('2026-11-01T02:59:00Z')
    let ct = await bindCoach(h, coach.id)
    expect((await h.call('PUT', path(bookingId), profile(), ct)).status).toBe(200)
    h.clock.now = new Date('2026-11-01T03:01:00Z')
    ct = await bindCoach(h, coach.id)
    const closed = await h.call('PUT', path(bookingId), profile({ note: '晚了' }), ct)
    expect(closed.status).toBe(409)
    expect(closed.json.error.code).toBe('profile_closed')
    const list = await h.call('GET', `/coach/lessons/${bookingId}/student-feedback`, undefined, ct)
    expect(list.json.error.code).toBe('profile_closed')
    expect(h.db.select().from(studentProfiles).get()?.note).toBe(NOTE)

    // A cancelled lesson closes it at once.
    h.clock.now = new Date('2026-10-23T02:00:00Z')
    const res = await h.call(
      'POST',
      '/bookings',
      { slotId: h.slot(coach.id, '2026-10-27', 10).id, lessonTypeId: lesson.id },
      t,
    )
    await h.call('POST', `/dev/fake-pay/${res.json.orderId}`)
    await h.call('POST', `/bookings/${res.json.bookingId}/cancel`, {}, t)
    ct = await bindCoach(h, coach.id)
    const cancelled = await h.call('PUT', path(res.json.bookingId), profile(), ct)
    expect(cancelled.json.error.code).toBe('profile_closed')
  })

  it('stays closed until the lesson is paid', async () => {
    const h = setup()
    const { coach, lesson, t } = await booked(h)
    const res = await h.call(
      'POST',
      '/bookings',
      { slotId: h.slot(coach.id, '2026-10-26', 10).id, lessonTypeId: lesson.id },
      t,
    )
    const unpaid = res.json.bookingId as number
    const ct = await bindCoach(h, coach.id)
    const view = await h.call('GET', `/coach/lessons/${unpaid}`, undefined, ct)
    expect(view.json.status).toBe('pending_payment')
    expect(view.json.profile).toBeNull()
    expect((await h.call('PUT', path(unpaid), profile(), ct)).json.error.code).toBe(
      'profile_closed',
    )
    const list = await h.call('GET', `/coach/lessons/${unpaid}/student-feedback`, undefined, ct)
    expect(list.json.error.code).toBe('profile_closed')
  })

  it('refuses once the student deleted their account', async () => {
    const h = setup()
    const { coach, t, bookingId } = await booked(h)
    h.clock.now = new Date('2026-10-25T04:00:00Z')
    expect((await h.call('DELETE', '/me', undefined, t)).status).toBe(204)
    const ct = await bindCoach(h, coach.id)
    const res = await h.call('PUT', path(bookingId), profile(), ct)
    expect(res.json.error.code).toBe('account_deleted')
    expect(h.db.select().from(studentProfiles).all()).toHaveLength(0)
  })

  it('lists the 课后点评 the student sees, from every coach, newest first', async () => {
    const h = setup()
    const { coach, lesson, t, studentId, bookingId } = await booked(h)
    const other = h.db.insert(coaches).values({ name: '李教练' }).returning().get()
    h.db.insert(coachLessonTypes).values({ coachId: other.id, lessonTypeId: lesson.id }).run()
    const book = async (coachId: number, date: string, hour: number) => {
      const res = await h.call(
        'POST',
        '/bookings',
        { slotId: h.slot(coachId, date, hour).id, lessonTypeId: lesson.id },
        t,
      )
      await h.call('POST', `/dev/fake-pay/${res.json.orderId}`)
      return res.json.bookingId as number
    }
    const earlier = await book(other.id, '2026-10-23', 14)
    const missed = await book(other.id, '2026-10-24', 10)
    const hidden = await book(coach.id, '2026-10-24', 14)
    h.clock.now = new Date('2026-10-25T04:00:00Z')
    const attended = [earlier, hidden, bookingId]
    for (const id of attended) {
      h.db.update(bookings).set({ attendance: 'attended' }).where(eq(bookings.id, id)).run()
    }
    h.db.update(bookings).set({ attendance: 'no_show' }).where(eq(bookings.id, missed)).run()
    const write = (id: number, text: string, hiddenAt: Date | null = null) =>
      h.db
        .insert(lessonFeedback)
        .values({ bookingId: id, text, updatedAt: h.clock.now, hiddenAt })
        .run()
    write(earlier, '李教练：步法有进步')
    write(missed, '缺席的课')
    write(hidden, '场馆隐藏的', h.clock.now)
    write(bookingId, '王教练：反手更稳')

    const ct = await bindCoach(h, coach.id)
    const view = (await h.call('GET', `/coach/lessons/${bookingId}`, undefined, ct)).json
    expect(view.profile.feedbackCount).toBe(2)
    const list = await h.call('GET', `/coach/lessons/${bookingId}/student-feedback`, undefined, ct)
    expect(
      list.json.map((f: { text: string; coachName: string }) => [f.coachName, f.text]),
    ).toEqual([
      ['王教练', '王教练：反手更稳'],
      ['李教练', '李教练：步法有进步'],
    ])

    const admin = await h.admin()
    const detail = (await h.call('GET', `/admin/students/${studentId}`, undefined, admin)).json
    expect(detail.profile.feedbackCount).toBe(2)
    expect(detail.feedback.map((f: { bookingId: number }) => f.bookingId)).toEqual([
      bookingId,
      earlier,
    ])
  })
})
