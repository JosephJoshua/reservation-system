import { venueInstant } from '@rs/shared'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { bookings, coaches, packageProducts, refunds, slots } from './db/schema'
import { notifyCoaches } from './services/coach-notices'
import { syncAllSlots } from './services/coaches'
import { type Harness, setup } from './test/harness'
import { fieldValue, type NoticeTemplate, type Notifier, parseTemplate } from './wx-notify'

const MON = 1
const at = (date: string, hhmm: string) =>
  venueInstant(date, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))).toISOString()
const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))
const hours = (weekday: number, from: string, to: string, lessonMinutes = 60) => ({
  weekday,
  startMinute: minutes(from),
  endMinute: minutes(to),
  lessonMinutes,
})

/** A seeded venue with the coach bound to the WeChat user `dev:coach`. */
async function withCoach(h: Harness) {
  const seeded = h.seed()
  const admin = await h.admin()
  const { code } = (await h.call('POST', `/admin/coaches/${seeded.coach.id}/bind-code`, {}, admin))
    .json
  const res = await h.call('POST', '/coach/bind', { code: 'dev:coach', bindCode: code })
  expect(res.status).toBe(200)
  return { ...seeded, admin, token: res.json.token as string }
}

async function book(h: Harness, token: string, slotId: number, lessonTypeId: number) {
  const res = await h.call('POST', '/bookings', { slotId, lessonTypeId }, token)
  if (res.json.orderId) await h.call('POST', `/dev/fake-pay/${res.json.orderId}`)
  return res.json.bookingId as number
}

function coachSlots(h: Harness, coachId: number) {
  return h.db
    .select()
    .from(slots)
    .where(eq(slots.coachId, coachId))
    .all()
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
}

describe('binding a coach to WeChat', () => {
  it('needs a bind code before the coach can log in', async () => {
    const h = setup()
    const { coach } = h.seed()
    const login = await h.call('POST', '/coach/login', { code: 'dev:coach' })
    expect(login.status).toBe(404)
    expect(login.json.error.code).toBe('not_bound')

    const admin = await h.admin()
    const { code, expiresAt } = (
      await h.call('POST', `/admin/coaches/${coach.id}/bind-code`, {}, admin)
    ).json
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/)
    expect(expiresAt).toBe('2026-10-24T02:00:00.000Z')
    const listed = (await h.call('GET', '/admin/coaches', undefined, admin)).json[0]
    expect(listed).toMatchObject({ bound: false, bindCode: code })
    expect(listed.openid).toBeUndefined()

    // Typed on a phone: lower case and a space are fine.
    const typed = `${code.slice(0, 4).toLowerCase()} ${code.slice(4)}`
    const bind = await h.call('POST', '/coach/bind', { code: 'dev:coach', bindCode: typed })
    expect(bind.status).toBe(200)
    expect(bind.json.coach).toMatchObject({ id: coach.id, name: '王教练', notifyTemplateIds: [] })
    expect((await h.call('GET', '/coach/me', undefined, bind.json.token)).status).toBe(200)
    expect((await h.call('POST', '/coach/login', { code: 'dev:coach' })).status).toBe(200)
    expect((await h.call('GET', '/admin/coaches', undefined, admin)).json[0]).toMatchObject({
      bound: true,
      bindCode: null,
    })

    // The code is single use.
    const again = await h.call('POST', '/coach/bind', { code: 'dev:other', bindCode: code })
    expect(again.json.error.code).toBe('bad_bind_code')
  })

  it('refuses an expired code', async () => {
    const h = setup()
    const { coach } = h.seed()
    const admin = await h.admin()
    const { code } = (await h.call('POST', `/admin/coaches/${coach.id}/bind-code`, {}, admin)).json
    h.clock.now = new Date('2026-10-24T02:00:01Z')
    const res = await h.call('POST', '/coach/bind', { code: 'dev:coach', bindCode: code })
    expect(res.status).toBe(400)
    expect(res.json.error.code).toBe('bad_bind_code')
  })

  it('keeps one WeChat user to one coach', async () => {
    const h = setup()
    const { coach } = await withCoach(h)
    const other = h.db.insert(coaches).values({ name: '李教练' }).returning().get()
    const admin = await h.admin()
    const { code } = (await h.call('POST', `/admin/coaches/${other.id}/bind-code`, {}, admin)).json
    const res = await h.call('POST', '/coach/bind', { code: 'dev:coach', bindCode: code })
    expect(res.status).toBe(409)
    expect(res.json.error.message).toBe(`这个微信已绑定教练「${coach.name}」`)
  })

  it('signs out the old phone when the coach binds a new one', async () => {
    const h = setup()
    const { coach, admin, token } = await withCoach(h)
    const { code } = (await h.call('POST', `/admin/coaches/${coach.id}/bind-code`, {}, admin)).json
    const fresh = await h.call('POST', '/coach/bind', { code: 'dev:new-phone', bindCode: code })
    expect(fresh.status).toBe(200)
    expect((await h.call('GET', '/coach/me', undefined, token)).status).toBe(401)
    expect((await h.call('GET', '/coach/me', undefined, fresh.json.token)).status).toBe(200)
  })

  it('cuts access when the coach is unbound or deactivated', async () => {
    const h = setup()
    const { coach, admin, token } = await withCoach(h)
    h.db.update(coaches).set({ active: false }).where(eq(coaches.id, coach.id)).run()
    expect((await h.call('GET', '/coach/me', undefined, token)).status).toBe(401)
    expect((await h.call('POST', '/coach/login', { code: 'dev:coach' })).status).toBe(403)
    h.db.update(coaches).set({ active: true }).where(eq(coaches.id, coach.id)).run()
    expect((await h.call('GET', '/coach/me', undefined, token)).status).toBe(200)

    expect(
      (await h.call('DELETE', `/admin/coaches/${coach.id}/binding`, undefined, admin)).status,
    ).toBe(204)
    expect((await h.call('GET', '/coach/me', undefined, token)).status).toBe(401)
    expect((await h.call('POST', '/coach/login', { code: 'dev:coach' })).status).toBe(404)
  })

  it('does not accept a student or admin token', async () => {
    const h = setup()
    await withCoach(h)
    const student = await h.student('coach')
    expect((await h.call('GET', '/coach/me', undefined, student)).status).toBe(401)
    expect((await h.call('GET', '/coach/me', undefined, await h.admin())).status).toBe(401)
  })

  it('tells the student profile when the same WeChat user is a coach', async () => {
    const h = setup()
    await withCoach(h)
    const asCoach = await h.student('coach')
    expect((await h.call('GET', '/me', undefined, asCoach)).json.isCoach).toBe(true)
    const student = await h.student('a')
    expect((await h.call('GET', '/me', undefined, student)).json.isCoach).toBe(false)
  })
})

describe('weekly hours', () => {
  it('turn into slots across the booking window', async () => {
    const h = setup()
    const { coach, token } = await withCoach(h)
    const res = await h.call(
      'PUT',
      '/coach/hours',
      { hours: [hours(MON, '14:00', '17:00'), hours(3, '09:00', '10:30')] },
      token,
    )
    expect(res.status).toBe(200)
    // Today is Friday 10-23 and the window runs 14 days to Friday 11-06:
    // Mondays 10-26 and 11-02 with 3 lessons, Wednesdays 10-28 and 11-04 with 1.
    expect(res.json).toEqual({ created: 8, removed: 0, bookedOnDaysOff: 0 })
    const rows = coachSlots(h, coach.id)
    expect(rows[0]).toMatchObject({ source: 'hours', open: true })
    expect(rows[0]?.startsAt.toISOString()).toBe(at('2026-10-26', '14:00'))
    // The half hour left over on Wednesday holds no lesson.
    expect(rows[3]?.endsAt.toISOString()).toBe(at('2026-10-28', '10:00'))

    // Saving the same hours again changes nothing.
    const again = await h.call(
      'PUT',
      '/coach/hours',
      { hours: [hours(MON, '14:00', '17:00'), hours(3, '09:00', '10:30')] },
      token,
    )
    expect(again.json).toEqual({ created: 0, removed: 0, bookedOnDaysOff: 0 })
    expect((await h.call('GET', '/coach/hours', undefined, token)).json).toMatchObject({
      hours: [hours(MON, '14:00', '17:00'), hours(3, '09:00', '10:30')],
      daysOff: [],
      lessonMinutes: [60],
      advanceDays: 14,
    })
  })

  it('rejects lengths the coach does not teach and overlapping windows', async () => {
    const h = setup()
    const { token } = await withCoach(h)
    const badLength = await h.call(
      'PUT',
      '/coach/hours',
      { hours: [hours(MON, '09:00', '12:00', 45)] },
      token,
    )
    expect(badLength.json.error.message).toBe('每节时长需与所教课程一致')
    const overlap = await h.call(
      'PUT',
      '/coach/hours',
      { hours: [hours(MON, '09:00', '12:00'), hours(MON, '11:00', '13:00')] },
      token,
    )
    expect(overlap.json.error.message).toBe('同一天的时间段不能重叠')
    const outOfDay = await h.call(
      'PUT',
      '/coach/hours',
      { hours: [hours(MON, '23:00', '25:00')] },
      token,
    )
    expect(outOfDay.status).toBe(400)
  })

  it('keeps booked lessons and removes the rest when hours change', async () => {
    const h = setup()
    const { coach, lesson, token } = await withCoach(h)
    await h.call('PUT', '/coach/hours', { hours: [hours(MON, '14:00', '17:00')] }, token)
    const [first, second] = coachSlots(h, coach.id)
    if (!first || !second) throw new Error('no slots')
    const student = await h.student('a')
    await book(h, student, first.id, lesson.id)
    // Someone booked and cancelled the second one: it has history, so it is closed, not deleted.
    const cancelled = await book(h, await h.student('b'), second.id, lesson.id)
    await h.call('POST', `/bookings/${cancelled}/cancel`, undefined, await h.student('b'))

    const res = await h.call('PUT', '/coach/hours', { hours: [hours(2, '14:00', '15:00')] }, token)
    expect(res.json).toEqual({ created: 2, removed: 5, bookedOnDaysOff: 0 })
    const rows = coachSlots(h, coach.id)
    expect(rows.map((s) => [s.id === first.id, s.id === second.id, s.open])).toEqual([
      [true, false, true],
      [false, true, false],
      [false, false, true],
      [false, false, true],
    ])
  })

  it('reopens a slot with history when its hours come back', async () => {
    const h = setup()
    const { coach, lesson, token, admin } = await withCoach(h)
    await h.call('PUT', '/coach/hours', { hours: [hours(MON, '14:00', '15:00')] }, token)
    const [first] = coachSlots(h, coach.id)
    if (!first) throw new Error('no slot')
    const student = await h.student('a')
    const cancelled = await book(h, student, first.id, lesson.id)
    await h.call('POST', `/bookings/${cancelled}/cancel`, undefined, student)

    await h.call('PUT', '/coach/hours', { hours: [] }, token)
    expect(h.db.select().from(slots).where(eq(slots.id, first.id)).get()?.open).toBe(false)
    const back = await h.call(
      'PUT',
      '/coach/hours',
      { hours: [hours(MON, '14:00', '15:00')] },
      token,
    )
    expect(back.json).toEqual({ created: 2, removed: 0, bookedOnDaysOff: 0 })
    expect(h.db.select().from(slots).where(eq(slots.id, first.id)).get()?.open).toBe(true)
    const [, fresh] = coachSlots(h, coach.id)
    if (!fresh) throw new Error('no slot')

    // Deleting a generated slot would only bring it back on the next sync.
    const del = await h.call('DELETE', `/admin/slots/${fresh.id}`, undefined, admin)
    expect(del.status).toBe(409)
    expect(del.json.error.code).toBe('slot_from_hours')
  })

  it('never puts a generated slot over a manual one', async () => {
    const h = setup()
    const { coach, token } = await withCoach(h)
    const manual = h.slot(coach.id, '2026-10-26', 14)
    const res = await h.call(
      'PUT',
      '/coach/hours',
      { hours: [hours(MON, '13:30', '16:30')] },
      token,
    )
    // 13:30 and 14:30 overlap the manual 14:00 lesson on 10-26 only.
    expect(res.json.created).toBe(4)
    const day = coachSlots(h, coach.id).filter((s) => s.startsAt < new Date('2026-10-27T00:00:00Z'))
    expect(day.map((s) => [s.id === manual.id, s.startsAt.toISOString()])).toEqual([
      [true, at('2026-10-26', '14:00')],
      [false, at('2026-10-26', '15:30')],
    ])
  })

  it('roll forward as days pass', async () => {
    const h = setup()
    const { coach, token } = await withCoach(h)
    await h.call('PUT', '/coach/hours', { hours: [hours(MON, '14:00', '15:00')] }, token)
    expect(coachSlots(h, coach.id)).toHaveLength(2)
    h.clock.now = new Date('2026-10-28T02:00:00Z')
    syncAllSlots(h.deps)
    // Monday 11-09 is now inside the window; the past Monday stays as history.
    expect(coachSlots(h, coach.id).map((s) => s.startsAt.toISOString())).toEqual([
      at('2026-10-26', '14:00'),
      at('2026-11-02', '14:00'),
      at('2026-11-09', '14:00'),
    ])
  })

  it('give slots students can book', async () => {
    const h = setup()
    const { lesson, token } = await withCoach(h)
    await h.call('PUT', '/coach/hours', { hours: [hours(MON, '14:00', '15:00')] }, token)
    const student = await h.student('a')
    const list = await h.call(
      'GET',
      `/slots?date=2026-10-26&lessonTypeId=${lesson.id}`,
      undefined,
      student,
    )
    expect(list.json).toHaveLength(1)
    expect(list.json[0].available).toBe(true)
    const id = await book(h, student, list.json[0].id, lesson.id)
    expect(h.db.select().from(bookings).where(eq(bookings.id, id)).get()?.status).toBe('confirmed')
  })
})

describe('days off', () => {
  it('remove free lessons, close manual slots and report booked ones', async () => {
    const h = setup()
    const { coach, lesson, token } = await withCoach(h)
    await h.call('PUT', '/coach/hours', { hours: [hours(MON, '14:00', '17:00')] }, token)
    const manual = h.slot(coach.id, '2026-10-26', 9)
    const booked = coachSlots(h, coach.id).find(
      (s) => s.startsAt.toISOString() === at('2026-10-26', '15:00'),
    )
    if (!booked) throw new Error('no slot')
    await book(h, await h.student('a'), booked.id, lesson.id)

    const res = await h.call('PUT', '/coach/days-off/2026-10-26', undefined, token)
    expect(res.json).toEqual({ created: 0, removed: 3, bookedOnDaysOff: 1 })
    const day = coachSlots(h, coach.id).filter((s) => s.startsAt < new Date('2026-10-27T00:00:00Z'))
    expect(day.map((s) => [s.id, s.open])).toEqual([
      [manual.id, false],
      [booked.id, true],
    ])
    expect((await h.call('GET', '/coach/hours', undefined, token)).json.daysOff).toEqual([
      '2026-10-26',
    ])

    const back = await h.call('DELETE', '/coach/days-off/2026-10-26', undefined, token)
    expect(back.json).toEqual({ created: 3, removed: 0, bookedOnDaysOff: 0 })
    expect(h.db.select().from(slots).where(eq(slots.id, manual.id)).get()?.open).toBe(true)
  })

  it('leaves a slot the coach closed by hand closed after the day off', async () => {
    const h = setup()
    const { coach, token } = await withCoach(h)
    const manual = h.slot(coach.id, '2026-10-26', 9)
    await h.call('PUT', `/coach/slots/${manual.id}`, { open: false }, token)
    await h.call('PUT', '/coach/days-off/2026-10-26', undefined, token)
    const back = await h.call('DELETE', '/coach/days-off/2026-10-26', undefined, token)
    expect(back.json.created).toBe(0)
    expect(h.db.select().from(slots).where(eq(slots.id, manual.id)).get()?.open).toBe(false)
  })

  it('refuses past and far dates', async () => {
    const h = setup()
    const { token } = await withCoach(h)
    expect((await h.call('PUT', '/coach/days-off/2026-10-22', undefined, token)).status).toBe(400)
    expect((await h.call('PUT', '/coach/days-off/2028-01-01', undefined, token)).status).toBe(400)
    expect((await h.call('PUT', '/coach/days-off/2026-02-30', undefined, token)).status).toBe(400)
    expect((await h.call('PUT', '/coach/days-off/2026-10-23', undefined, token)).status).toBe(200)
  })

  it('can be set by the admin for a coach', async () => {
    const h = setup()
    const { coach, admin } = await withCoach(h)
    await h.call(
      'PUT',
      `/admin/coaches/${coach.id}/hours`,
      { hours: [hours(MON, '14:00', '15:00')] },
      admin,
    )
    const res = await h.call(
      'PUT',
      `/admin/coaches/${coach.id}/days-off/2026-10-26`,
      undefined,
      admin,
    )
    expect(res.json.removed).toBe(1)
    expect(
      (await h.call('GET', `/admin/coaches/${coach.id}/hours`, undefined, admin)).json,
    ).toMatchObject({
      hours: [hours(MON, '14:00', '15:00')],
      daysOff: ['2026-10-26'],
    })
  })
})

describe('the coach schedule and lessons', () => {
  async function bookedLesson(h: Harness) {
    const ctx = await withCoach(h)
    const slot = h.slot(ctx.coach.id, '2026-10-26', 10)
    const student = await h.student('a')
    await h.call('PUT', '/me', { name: '小明', phone: '13800138000' }, student)
    const bookingId = await book(h, student, slot.id, ctx.lesson.id)
    return { ...ctx, slot, student, bookingId }
  }

  it('lists slots with who booked them', async () => {
    const h = setup()
    const { coach, token, slot, bookingId } = await bookedLesson(h)
    const free = h.slot(coach.id, '2026-10-26', 11)
    const res = await h.call(
      'GET',
      '/coach/schedule?from=2026-10-26&to=2026-10-26',
      undefined,
      token,
    )
    expect(res.json).toEqual([
      {
        id: slot.id,
        startsAt: at('2026-10-26', '10:00'),
        endsAt: at('2026-10-26', '11:00'),
        open: true,
        lesson: {
          bookingId,
          status: 'confirmed',
          attendance: null,
          studentName: '小明',
          lessonTypeName: '一对一私教',
          isTrial: false,
        },
        group: null,
      },
      {
        id: free.id,
        startsAt: at('2026-10-26', '11:00'),
        endsAt: at('2026-10-26', '12:00'),
        open: true,
        lesson: null,
        group: null,
      },
    ])
    expect(
      (await h.call('GET', '/coach/schedule?from=2026-10-26&to=2027-03-31', undefined, token))
        .status,
    ).toBe(400)
    expect(
      (await h.call('GET', '/coach/schedule?from=2026-10-27&to=2026-10-26', undefined, token))
        .status,
    ).toBe(400)
    expect(
      (await h.call('GET', '/coach/schedule?from=2026-02-30&to=2026-13-45', undefined, token))
        .status,
    ).toBe(400)
  })

  it('shows a student who deleted their account without their details', async () => {
    const h = setup()
    const { student, token, bookingId } = await bookedLesson(h)
    h.clock.now = new Date('2026-10-26T03:30:00Z') // after the lesson
    expect((await h.call('DELETE', '/me', undefined, student)).status).toBe(204)
    const lesson = (await h.call('GET', `/coach/lessons/${bookingId}`, undefined, token)).json
    expect(lesson.student).toEqual({ id: 1, name: '已注销学员', phone: '' })
    const [slot] = (
      await h.call('GET', '/coach/schedule?from=2026-10-26&to=2026-10-26', undefined, token)
    ).json
    expect(slot.lesson.studentName).toBe('已注销学员')
    const note = await h.call('PUT', `/coach/lessons/${bookingId}/note`, { note: '反手' }, token)
    expect(note.json.error.code).toBe('account_deleted')
  })

  it('shows a lesson with the student and earlier lessons together', async () => {
    const h = setup()
    const { coach, lesson, token, student, bookingId } = await bookedLesson(h)
    const later = await book(h, student, h.slot(coach.id, '2026-10-28', 10).id, lesson.id)
    h.clock.now = new Date('2026-10-26T03:30:00Z')
    await h.call('PUT', `/coach/lessons/${bookingId}/note`, { note: '反手要多练' }, token)

    const res = await h.call('GET', `/coach/lessons/${later}`, undefined, token)
    expect(res.json).toMatchObject({
      id: later,
      status: 'confirmed',
      student: { name: '小明', phone: '13800138000' },
      paidWith: 'order',
      price: 20000,
      canMarkAttendance: false,
      canCancel: true,
      lessonsTogether: 1,
      history: [{ id: bookingId, coachNote: '反手要多练', attendance: null }],
    })
    // The earlier lesson does not see the later one, which has not happened yet.
    expect(
      (await h.call('GET', `/coach/lessons/${bookingId}`, undefined, token)).json.history,
    ).toEqual([])
    await h.call('PUT', `/coach/lessons/${bookingId}/attendance`, { attendance: 'no_show' }, token)
    const after = (await h.call('GET', `/coach/lessons/${later}`, undefined, token)).json
    expect(after.lessonsTogether).toBe(0)
    expect(after.history).toMatchObject([{ id: bookingId, attendance: 'no_show' }])
  })

  it('hides other coaches lessons', async () => {
    const h = setup()
    const { bookingId } = await bookedLesson(h)
    const other = h.db.insert(coaches).values({ name: '李教练' }).returning().get()
    const admin = await h.admin()
    const { code } = (await h.call('POST', `/admin/coaches/${other.id}/bind-code`, {}, admin)).json
    const token = (await h.call('POST', '/coach/bind', { code: 'dev:li', bindCode: code })).json
      .token
    expect((await h.call('GET', `/coach/lessons/${bookingId}`, undefined, token)).status).toBe(404)
    const note = await h.call('PUT', `/coach/lessons/${bookingId}/note`, { note: 'x' }, token)
    expect(note.status).toBe(404)
    const cancel = await h.call(
      'POST',
      `/coach/lessons/${bookingId}/cancel`,
      { reason: 'x' },
      token,
    )
    expect(cancel.status).toBe(404)
    h.clock.now = new Date('2026-10-26T02:30:00Z')
    const mark = await h.call(
      'PUT',
      `/coach/lessons/${bookingId}/attendance`,
      { attendance: 'attended' },
      token,
    )
    expect(mark.status).toBe(404)
  })

  it('marks attendance once the lesson starts, for a week', async () => {
    const h = setup()
    const { token, bookingId } = await bookedLesson(h)
    const mark = (attendance: string | null, t = token) =>
      h.call('PUT', `/coach/lessons/${bookingId}/attendance`, { attendance }, t)
    expect((await mark('attended')).json.error.code).toBe('not_started')

    h.clock.now = new Date('2026-10-26T02:00:00Z')
    const marked = await mark('no_show')
    expect(marked.json).toMatchObject({ attendance: 'no_show', canMarkAttendance: true })
    expect((await mark(null)).json.attendance).toBeNull()

    h.clock.now = new Date('2026-11-02T03:00:01Z')
    expect((await mark('attended')).json.error.code).toBe('too_late')
    const admin = await h.admin()
    const byAdmin = await h.call(
      'PUT',
      `/admin/bookings/${bookingId}/attendance`,
      { attendance: 'attended' },
      admin,
    )
    expect(byAdmin.status).toBe(204)
    const list = await h.call('GET', '/admin/bookings?from=2026-10-26T00:00:00Z', undefined, admin)
    expect(list.json[0]).toMatchObject({
      id: bookingId,
      attendance: 'attended',
      status: 'completed',
    })
    expect((await mark('bogus')).status).toBe(400)
  })

  it('does not touch money or the package on a no-show', async () => {
    const h = setup()
    const { token, bookingId } = await bookedLesson(h)
    h.clock.now = new Date('2026-10-26T03:30:00Z')
    await h.call('PUT', `/coach/lessons/${bookingId}/attendance`, { attendance: 'no_show' }, token)
    expect(h.db.select().from(refunds).all()).toHaveLength(0)
    expect(h.db.select().from(bookings).where(eq(bookings.id, bookingId)).get()?.status).toBe(
      'confirmed',
    )
  })

  it('lets the coach cancel with a full refund', async () => {
    const h = setup()
    const { token, slot, lesson, bookingId } = await bookedLesson(h)
    h.clock.now = new Date('2026-10-26T01:30:00Z') // 30 minutes before, past the student deadline
    const res = await h.call(
      'POST',
      `/coach/lessons/${bookingId}/cancel`,
      { reason: '生病' },
      token,
    )
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ status: 'cancelled', cancelledBy: 'venue', canCancel: false })
    expect(res.json.cancelReason).toBe('教练取消：生病')
    expect(h.db.select().from(refunds).get()).toMatchObject({ amount: 20000, status: 'succeeded' })
    const row = h.db.select().from(bookings).where(eq(bookings.id, bookingId)).get()
    expect(row?.coachToldCancelledAt).not.toBeNull()
    // The slot is free again.
    const again = await h.call(
      'POST',
      '/bookings',
      { slotId: slot.id, lessonTypeId: lesson.id },
      await h.student('z'),
    )
    expect(again.json.error.code).toBe('too_soon')
    const note = await h.call('PUT', `/coach/lessons/${bookingId}/note`, { note: 'x' }, token)
    expect(note.json.error.code).toBe('not_live')
    const empty = await h.call('POST', `/coach/lessons/${bookingId}/cancel`, { reason: '' }, token)
    expect(empty.status).toBe(400)
  })

  it('still announces a student cancel that beat the coach cancel', async () => {
    const h = setup()
    const { token, student, bookingId } = await bookedLesson(h)
    await h.call('POST', `/bookings/${bookingId}/cancel`, undefined, student)
    const res = await h.call(
      'POST',
      `/coach/lessons/${bookingId}/cancel`,
      { reason: '生病' },
      token,
    )
    expect(res.status).toBe(409)
    const row = h.db.select().from(bookings).where(eq(bookings.id, bookingId)).get()
    expect(row).toMatchObject({
      status: 'cancelled',
      cancelledBy: 'student',
      coachToldCancelledAt: null,
    })
  })

  it('drops the attendance mark when the venue cancels a lesson under way', async () => {
    const h = setup()
    const { token, bookingId } = await bookedLesson(h)
    h.clock.now = new Date('2026-10-26T02:10:00Z')
    await h.call('PUT', `/coach/lessons/${bookingId}/attendance`, { attendance: 'attended' }, token)
    const admin = await h.admin()
    const res = await h.call(
      'POST',
      `/admin/bookings/${bookingId}/cancel`,
      { reason: '停电' },
      admin,
    )
    expect(res.status).toBeLessThan(300)
    const row = h.db.select().from(bookings).where(eq(bookings.id, bookingId)).get()
    expect(row).toMatchObject({ status: 'cancelled', attendance: null })
  })

  it('does not let the coach cancel a lesson that has started', async () => {
    const h = setup()
    const { token, bookingId } = await bookedLesson(h)
    h.clock.now = new Date('2026-10-26T02:10:00Z')
    expect(
      (await h.call('GET', `/coach/lessons/${bookingId}`, undefined, token)).json.canCancel,
    ).toBe(false)
    const res = await h.call(
      'POST',
      `/coach/lessons/${bookingId}/cancel`,
      { reason: '生病' },
      token,
    )
    expect(res.status).toBe(409)
    expect(res.json.error.code).toBe('started')
    const row = h.db.select().from(bookings).where(eq(bookings.id, bookingId)).get()
    expect(row).toMatchObject({ status: 'confirmed', coachToldCancelledAt: null })
  })

  it('opens and closes the coach own future slots', async () => {
    const h = setup()
    const { coach, lesson, token } = await withCoach(h)
    const slot = h.slot(coach.id, '2026-10-26', 10)
    expect((await h.call('PUT', `/coach/slots/${slot.id}`, { open: false }, token)).status).toBe(
      204,
    )
    expect(h.db.select().from(slots).where(eq(slots.id, slot.id)).get()?.open).toBe(false)
    h.clock.now = new Date('2026-10-26T02:00:00Z')
    expect((await h.call('PUT', `/coach/slots/${slot.id}`, { open: true }, token)).status).toBe(409)
    const booked = h.slot(coach.id, '2026-10-27', 10)
    await book(h, await h.student('a'), booked.id, lesson.id)
    const late = await h.call('PUT', `/coach/slots/${booked.id}`, { open: false }, token)
    expect(late.json.error.code).toBe('slot_booked')
    const other = h.db.insert(coaches).values({ name: '李教练' }).returning().get()
    const theirs = h.slot(other.id, '2026-10-28', 10)
    expect((await h.call('PUT', `/coach/slots/${theirs.id}`, { open: false }, token)).status).toBe(
      404,
    )
  })
})

describe('coach notices', () => {
  function fakeNotifier(result: 'sent' | 'refused' | 'fail' = 'sent') {
    const template: NoticeTemplate = {
      id: 'tpl',
      fields: { thing1: 'student', time2: 'time', thing3: 'lesson' },
    }
    const sent: { openid: string; page: string; data: Record<string, string> }[] = []
    const notifier: Notifier = {
      template: (kind) => (kind.startsWith('coach_') ? { ...template, id: kind } : undefined),
      async send(openid, _template, page, values) {
        if (result === 'fail') throw new Error('offline')
        sent.push({ openid, page, data: { ...values } })
        return result
      },
    }
    return { notifier, sent }
  }

  it('tells the coach about paid and package bookings, not unpaid holds', async () => {
    const h = setup()
    const { notifier, sent } = fakeNotifier()
    h.deps.notifier = notifier
    const { coach, lesson, token } = await withCoach(h)
    expect((await h.call('GET', '/coach/me', undefined, token)).json.notifyTemplateIds).toEqual([
      'coach_booked',
      'coach_cancelled',
      'coach_moved',
    ])
    const student = await h.student('a')
    await h.call('PUT', '/me', { name: '小明' }, student)
    const unpaid = await h.call(
      'POST',
      '/bookings',
      { slotId: h.slot(coach.id, '2026-10-26', 9).id, lessonTypeId: lesson.id },
      student,
    )
    expect(unpaid.status).toBe(201)
    await notifyCoaches(h.deps)
    expect(sent).toHaveLength(0)

    const id = await book(h, student, h.slot(coach.id, '2026-10-26', 10).id, lesson.id)
    await notifyCoaches(h.deps)
    await notifyCoaches(h.deps)
    expect(sent).toEqual([
      {
        openid: 'dev_coach',
        page: `coach/lesson/index?id=${id}`,
        data: {
          student: '小明',
          lesson: '一对一私教',
          time: '2026年10月26日 10:00~11:00',
          coach: '王教练',
          reason: '',
        },
      },
    ])

    await h.call('POST', `/bookings/${id}/cancel`, undefined, student)
    await notifyCoaches(h.deps)
    expect(sent).toHaveLength(2)
    expect(sent[1]?.page).toBe(`coach/lesson/index?id=${id}`)
  })

  it('retries when WeChat is down and gives up once the lesson starts', async () => {
    const h = setup()
    const { notifier } = fakeNotifier('fail')
    h.deps.notifier = notifier
    const { coach, lesson } = await withCoach(h)
    const id = await book(h, await h.student('a'), h.slot(coach.id, '2026-10-26', 10).id, lesson.id)
    await notifyCoaches(h.deps)
    const told = () =>
      h.db.select().from(bookings).where(eq(bookings.id, id)).get()?.coachToldBookedAt
    expect(told()).toBeNull()
    expect(h.logs.some((l) => l.message === 'coach notice failed')).toBe(true)
    h.clock.now = new Date('2026-10-26T02:00:00Z')
    await notifyCoaches(h.deps)
    expect(told()).not.toBeNull()
  })

  it('marks bookings as handled when no template is set up', async () => {
    const h = setup()
    const { coach, lesson } = await withCoach(h)
    await book(h, await h.student('a'), h.slot(coach.id, '2026-10-26', 10).id, lesson.id)
    await notifyCoaches(h.deps)
    const pending = h.db
      .select()
      .from(bookings)
      .where(and(eq(bookings.status, 'confirmed')))
      .all()
      .filter((b) => b.coachToldBookedAt === null)
    expect(pending).toHaveLength(0)
  })

  it('reads templates and fits values to WeChat limits', () => {
    expect(parseTemplate('abc thing1=student time2=time')).toEqual({
      id: 'abc',
      fields: { thing1: 'student', time2: 'time' },
    })
    expect(parseTemplate('')).toBeUndefined()
    expect(() => parseTemplate('abc thing1=nobody')).toThrow()
    expect(() => parseTemplate('abc')).toThrow()
    expect(fieldValue('thing1', '一二三四五六七八九十一二三四五六七八九十一')).toBe(
      '一二三四五六七八九十一二三四五六七八九…',
    )
    expect(fieldValue('name2', '')).toBe('-')
    expect(fieldValue('thing4', '今天练了：\n1. 反手  拧拉\n')).toBe('今天练了： 1. 反手 拧拉')
    expect(fieldValue('thing4', ' \n ')).toBe('-')
    expect(fieldValue('time3', '2026年10月26日 10:00~11:00')).toBe('2026年10月26日 10:00~11:00')
  })
})

describe('monthly report', () => {
  it('counts lessons per coach, money and prepaid lessons', async () => {
    const h = setup()
    const { coach, lesson, token, admin } = await withCoach(h)
    const a = await h.student('a')
    const b = await h.student('b')
    const attended = await book(h, a, h.slot(coach.id, '2026-10-26', 10).id, lesson.id)
    const noShow = await book(h, b, h.slot(coach.id, '2026-10-26', 12).id, lesson.id)
    const venueCancel = await book(h, a, h.slot(coach.id, '2026-10-27', 10).id, lesson.id)
    await h.call('POST', `/admin/bookings/${venueCancel}/cancel`, { reason: '场地维修' }, admin)
    const product = h.db
      .insert(packageProducts)
      .values({
        name: '10 次课',
        lessonTypeId: lesson.id,
        lessonCount: 10,
        price: 180000,
        validityDays: 90,
      })
      .returning()
      .get()
    await h.call(
      'POST',
      '/admin/packages/offline-sale',
      { studentId: 2, productId: product.id, amount: 150000, method: 'cash' },
      admin,
    )
    h.clock.now = new Date('2026-10-26T05:00:00Z')
    await h.call('PUT', `/coach/lessons/${attended}/attendance`, { attendance: 'attended' }, token)
    await h.call('PUT', `/coach/lessons/${noShow}/attendance`, { attendance: 'no_show' }, token)

    const later = await h.admin()
    const res = await h.call('GET', '/admin/reports/monthly?month=2026-10', undefined, later)
    expect(res.json).toEqual({
      month: '2026-10',
      coaches: [
        {
          id: coach.id,
          name: '王教练',
          taught: 2,
          minutes: 120,
          attended: 1,
          noShow: 1,
          unmarked: 0,
          venueCancelled: 1,
          lateCancelled: 0,
          // No category, so no rate; no-shows count by default.
          pay: {
            amount: 0,
            lessons: 2,
            unrated: 2,
            lines: [
              { lessonTypeId: lesson.id, name: '一对一私教', lessons: 2, rate: null, amount: 0 },
            ],
          },
        },
      ],
      payRules: { noShows: true, lateCancels: false },
      revenue: {
        wechat: 60000,
        offline: 150000,
        byKind: { class: 60000, trial: 0, package: 150000 },
        refunded: 20000,
        net: 190000,
      },
      packagesOutstanding: { lessons: 10, value: 150000 },
    })
    const empty = await h.call('GET', '/admin/reports/monthly?month=2026-11', undefined, later)
    expect(empty.json.revenue.net).toBe(0)
    expect(
      (await h.call('GET', '/admin/reports/monthly?month=2026-13', undefined, later)).status,
    ).toBe(400)
  })
})
