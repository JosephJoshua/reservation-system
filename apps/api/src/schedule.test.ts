// 排班 end to end: weekly hours, 请假/加班/闭馆, the start times they leave, and booking, moving
// and cancelling private lessons at those times. The clock starts on Friday 2026-10-23 at 10:00
// venue time; 2026-10-25 is a Sunday.
import { venueInstant, versionOf } from '@rs/shared'
import { eq, inArray, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
  bookingMoves,
  bookings,
  coaches,
  coachLessonTypes,
  lessonTypes,
  scheduleExceptions,
  slots,
  studentNotices,
} from './db/schema'
import { settleOutsideAgreed } from './services/schedule'
import { type Harness, setup } from './test/harness'

const SUN = '2026-10-25'
const MON = '2026-10-26'
const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))
const at = (date: string, hhmm: string) => venueInstant(date, minutes(hhmm)).toISOString()
const hhmm = (iso: string) => new Date(Date.parse(iso) + 8 * 3_600_000).toISOString().slice(11, 16)

/** A seeded venue with a logged-in student and admin. */
async function venue(h: Harness) {
  const seeded = h.seed()
  const admin = await h.admin()
  const student = await h.student('a')
  return { ...seeded, admin, student }
}

/** A second coach teaching the seeded private lesson. */
function secondCoach(h: Harness, lessonTypeId: number, name = '李教练') {
  const coach = h.db.insert(coaches).values({ name }).returning().get()
  h.db.insert(coachLessonTypes).values({ coachId: coach.id, lessonTypeId }).run()
  return coach
}

/** A coach bound to WeChat, with a coach token. */
async function coachToken(h: Harness, admin: string, coachId: number, who = 'coach') {
  const { code } = (await h.call('POST', `/admin/coaches/${coachId}/bind-code`, {}, admin)).json
  const res = await h.call('POST', '/coach/bind', { code: `dev:${who}`, bindCode: code })
  expect(res.status).toBe(200)
  return res.json.token as string
}

/** Private start times a student is offered on a date, as HH:MM, for one coach. */
async function times(
  h: Harness,
  token: string,
  date: string,
  lessonTypeId: number,
  coachId?: number,
) {
  const q = new URLSearchParams({ date, lessonTypeId: String(lessonTypeId) })
  if (coachId) q.set('coachId', String(coachId))
  const res = await h.call('GET', `/slots?${q}`, undefined, token)
  expect(res.status).toBe(200)
  return (res.json as { id: number | null; startsAt: string; available: boolean }[])
    .filter((s) => s.id === null)
    .map((s) => hhmm(s.startsAt))
}

async function book(
  h: Harness,
  token: string,
  coachId: number,
  startsAt: string,
  lessonTypeId: number,
  { pay = true } = {},
) {
  const res = await h.call('POST', '/bookings', { coachId, startsAt, lessonTypeId }, token)
  if (res.status === 201 && pay && res.json.orderId) {
    await h.fakePay(res.json.orderId)
  }
  return res
}

const hoursPut = (
  h: Harness,
  admin: string,
  coachId: number,
  hours: { weekday: number; from: string; to: string }[],
  from?: string,
) =>
  h.call(
    'PUT',
    `/admin/coaches/${coachId}/hours`,
    {
      ...(from ? { from } : {}),
      hours: hours.map((w) => ({
        weekday: w.weekday,
        startMinute: minutes(w.from),
        endMinute: minutes(w.to),
      })),
    },
    admin,
  )

const exception = (
  h: Harness,
  admin: string,
  coachId: number,
  kind: 'off' | 'extra',
  startsAt: string,
  endsAt: string,
  note = '',
) => h.call('POST', `/admin/coaches/${coachId}/exceptions`, { kind, startsAt, endsAt, note }, admin)

describe('weekly hours', () => {
  it('offers every grid start a lesson fits in, ending by the end of the hours', async () => {
    const h = setup()
    const { coach, lesson, admin, student } = await venue(h)
    expect(
      (await hoursPut(h, admin, coach.id, [{ weekday: 0, from: '09:00', to: '12:00' }])).status,
    ).toBe(200)
    expect(await times(h, student, SUN, lesson.id)).toEqual([
      '09:00',
      '09:30',
      '10:00',
      '10:30',
      '11:00',
    ])
    // Nothing on Monday, which has no hours.
    expect(await times(h, student, MON, lesson.id)).toEqual([])
    // Private times carry no id: the lesson row is made when someone books.
    expect(h.db.select().from(slots).all()).toEqual([])
  })

  it('follows the venue grid and the lesson length', async () => {
    const h = setup()
    const { coach, lesson, admin, student } = await venue(h)
    const long = h.db
      .insert(lessonTypes)
      .values({ name: '90分钟私教', durationMinutes: 90, price: 30000 })
      .returning()
      .get()
    h.db.insert(coachLessonTypes).values({ coachId: coach.id, lessonTypeId: long.id }).run()
    // Hours that start off the grid: the first start is the start of the hours, then the grid.
    await hoursPut(h, admin, coach.id, [{ weekday: 0, from: '09:10', to: '12:00' }])
    expect(await times(h, student, SUN, lesson.id)).toEqual([
      '09:10',
      '09:30',
      '10:00',
      '10:30',
      '11:00',
    ])
    expect(await times(h, student, SUN, long.id)).toEqual(['09:10', '09:30', '10:00', '10:30'])
    h.settings((s) => {
      s.booking.startGrid = 60
    })
    expect(await times(h, student, SUN, lesson.id)).toEqual(['09:10', '10:00', '11:00'])
    h.settings((s) => {
      s.booking.startGrid = 15
    })
    expect(await times(h, student, SUN, long.id)).toEqual([
      '09:10',
      '09:15',
      '09:30',
      '09:45',
      '10:00',
      '10:15',
      '10:30',
    ])
  })

  it('joins touching windows so a lesson can span them, and keeps split windows apart', async () => {
    const h = setup()
    const { coach, lesson, admin, student } = await venue(h)
    await hoursPut(h, admin, coach.id, [
      { weekday: 0, from: '09:00', to: '10:30' },
      { weekday: 0, from: '10:30', to: '11:00' },
      { weekday: 0, from: '14:00', to: '15:30' },
    ])
    expect(await times(h, student, SUN, lesson.id)).toEqual([
      '09:00',
      '09:30',
      '10:00',
      '14:00',
      '14:30',
    ])
  })

  it('plans hours from a later date and keeps earlier days as they were', async () => {
    const h = setup()
    const { coach, lesson, admin, student } = await venue(h)
    await hoursPut(h, admin, coach.id, [{ weekday: 0, from: '09:00', to: '10:00' }])
    const planned = await hoursPut(
      h,
      admin,
      coach.id,
      [{ weekday: 0, from: '14:00', to: '15:00' }],
      '2026-11-01',
    )
    expect(planned.status).toBe(200)
    expect(await times(h, student, SUN, lesson.id)).toEqual(['09:00'])
    expect(await times(h, student, '2026-11-01', lesson.id)).toEqual(['14:00'])
    const view = (await h.call('GET', `/admin/coaches/${coach.id}/hours`, undefined, admin)).json
    expect(view.periods).toEqual([
      { from: '2026-10-23', hours: [{ weekday: 0, startMinute: 540, endMinute: 600 }] },
      { from: '2026-11-01', hours: [{ weekday: 0, startMinute: 840, endMinute: 900 }] },
    ])

    // Saving from an earlier date replaces the plan that came after it.
    await hoursPut(h, admin, coach.id, [{ weekday: 0, from: '18:00', to: '19:00' }], '2026-10-28')
    expect(await times(h, student, SUN, lesson.id)).toEqual(['09:00'])
    expect(await times(h, student, '2026-11-01', lesson.id)).toEqual(['18:00'])
    expect(
      (await h.call('GET', `/admin/coaches/${coach.id}/hours`, undefined, admin)).json.periods,
    ).toEqual([
      { from: '2026-10-23', hours: [{ weekday: 0, startMinute: 540, endMinute: 600 }] },
      { from: '2026-10-28', hours: [{ weekday: 0, startMinute: 1080, endMinute: 1140 }] },
    ])

    // Clearing the hours from today leaves no times at all.
    await hoursPut(h, admin, coach.id, [])
    expect(await times(h, student, SUN, lesson.id)).toEqual([])
    expect(await times(h, student, '2026-11-01', lesson.id)).toEqual([])
  })

  it('moves the first period to today as days go by', async () => {
    const h = setup()
    const { coach, admin } = await venue(h)
    await hoursPut(h, admin, coach.id, [{ weekday: 0, from: '09:00', to: '10:00' }])
    h.clock.now = new Date('2026-10-30T02:00:00Z')
    const view = (
      await h.call('GET', `/admin/coaches/${coach.id}/hours`, undefined, await h.admin())
    ).json
    expect(view.periods).toEqual([
      { from: '2026-10-30', hours: [{ weekday: 0, startMinute: 540, endMinute: 600 }] },
    ])
  })

  it('refuses hours that make no sense', async () => {
    const h = setup()
    const { coach, admin } = await venue(h)
    const put = (hours: unknown, from?: string) =>
      h.call('PUT', `/admin/coaches/${coach.id}/hours`, { hours, ...(from ? { from } : {}) }, admin)
    const one = (startMinute: number, endMinute: number, weekday = 1) => [
      { weekday, startMinute, endMinute },
    ]
    const cases: [unknown, string | undefined, number, string][] = [
      [one(600, 600), undefined, 400, 'invalid_hours'],
      [one(660, 600), undefined, 400, 'invalid_hours'],
      [one(601, 660), undefined, 400, 'invalid_hours'],
      [one(600, 1441), undefined, 400, 'invalid_body'],
      [one(600, 660, 7), undefined, 400, 'invalid_body'],
      [one(-5, 660), undefined, 400, 'invalid_body'],
      [[...one(600, 720), ...one(690, 780)], undefined, 400, 'invalid_hours'],
      [one(600, 660), '2026-10-22', 400, 'invalid_date'],
      [one(600, 660), '2027-12-01', 400, 'invalid_date'],
      [one(600, 660), '2026-02-30', 400, 'invalid_body'],
    ]
    for (const [hours, from, status, code] of cases) {
      const res = await put(hours, from)
      expect([res.status, res.json.error.code]).toEqual([status, code])
    }
    expect((await h.call('PUT', '/admin/coaches/99/hours', { hours: [] }, admin)).status).toBe(404)
    // A whole day is fine.
    expect((await put(one(0, 1440))).status).toBe(200)
  })

  it('keeps booked lessons when hours change and lists the ones now outside them', async () => {
    const h = setup()
    const { coach, lesson, admin, student } = await venue(h)
    await hoursPut(h, admin, coach.id, [{ weekday: 0, from: '09:00', to: '12:00' }])
    const booked = await book(h, student, coach.id, at(SUN, '11:00'), lesson.id)
    expect(booked.status).toBe(201)
    const res = await hoursPut(h, admin, coach.id, [{ weekday: 0, from: '09:00', to: '10:00' }])
    expect(res.json.conflicts).toEqual([
      expect.objectContaining({
        bookingId: booked.json.bookingId,
        coachName: '王教练',
        startsAt: at(SUN, '11:00'),
        title: '未填写姓名',
        group: false,
      }),
    ])
    expect(
      h.db.select().from(bookings).where(eq(bookings.id, booked.json.bookingId)).get()?.status,
    ).toBe('confirmed')
    // Hours that still cover it report nothing.
    const back = await hoursPut(h, admin, coach.id, [{ weekday: 0, from: '09:00', to: '12:00' }])
    expect(back.json.conflicts).toEqual([])
  })
})

describe('请假, 加班 and 闭馆', () => {
  it('takes 请假 out of the hours and gives the time back once removed', async () => {
    const h = setup()
    const { coach, lesson, admin, student } = await venue(h)
    await hoursPut(h, admin, coach.id, [{ weekday: 0, from: '09:00', to: '13:00' }])
    const leave = await exception(
      h,
      admin,
      coach.id,
      'off',
      at(SUN, '10:00'),
      at(SUN, '11:30'),
      '看病',
    )
    expect(leave.status).toBe(201)
    expect(leave.json.conflicts).toEqual([])
    expect(await times(h, student, SUN, lesson.id)).toEqual(['09:00', '11:30', '12:00'])
    expect(
      (
        await h.call(
          'DELETE',
          `/admin/coaches/${coach.id}/exceptions/${leave.json.id}`,
          undefined,
          admin,
        )
      ).status,
    ).toBe(200)
    expect(await times(h, student, SUN, lesson.id)).toEqual([
      '09:00',
      '09:30',
      '10:00',
      '10:30',
      '11:00',
      '11:30',
      '12:00',
    ])
    // A repeat of the delete is fine and changes nothing.
    expect(
      (
        await h.call(
          'DELETE',
          `/admin/coaches/${coach.id}/exceptions/${leave.json.id}`,
          undefined,
          admin,
        )
      ).status,
    ).toBe(200)
  })

  it('covers several days with one 请假', async () => {
    const h = setup()
    const { coach, lesson, admin, student } = await venue(h)
    await hoursPut(h, admin, coach.id, [
      { weekday: 0, from: '09:00', to: '11:00' },
      { weekday: 1, from: '09:00', to: '11:00' },
      { weekday: 2, from: '09:00', to: '11:00' },
    ])
    await exception(h, admin, coach.id, 'off', at(SUN, '00:00'), at('2026-10-27', '00:00'))
    expect(await times(h, student, SUN, lesson.id)).toEqual([])
    expect(await times(h, student, MON, lesson.id)).toEqual([])
    expect(await times(h, student, '2026-10-27', lesson.id)).toEqual(['09:00', '09:30', '10:00'])
    // The open-days list skips the days off.
    const days = (
      await h.call('GET', `/slots/open-days?lessonTypeId=${lesson.id}`, undefined, student)
    ).json as string[]
    expect(days).not.toContain(SUN)
    expect(days).not.toContain(MON)
    expect(days).toContain('2026-10-27')
  })

  it('lists lessons caught by 请假 for the venue to sort out, without cancelling them', async () => {
    const h = setup()
    const { coach, lesson, admin, student } = await venue(h)
    await hoursPut(h, admin, coach.id, [{ weekday: 0, from: '09:00', to: '13:00' }])
    const booked = await book(h, student, coach.id, at(SUN, '10:00'), lesson.id)
    const leave = await exception(h, admin, coach.id, 'off', at(SUN, '09:30'), at(SUN, '10:30'))
    expect(leave.json.conflicts).toEqual([
      expect.objectContaining({ bookingId: booked.json.bookingId, startsAt: at(SUN, '10:00') }),
    ])
    expect(h.db.select().from(bookings).get()?.status).toBe('confirmed')
    const listed = (await h.call('GET', '/admin/schedule/conflicts', undefined, admin)).json
    expect(listed).toEqual([expect.objectContaining({ bookingId: booked.json.bookingId })])

    // The venue moves it out of the 请假 at a time outside 排班, and the list empties.
    const moved = await h.call(
      'POST',
      `/admin/bookings/${booked.json.bookingId}/move`,
      { coachId: coach.id, startsAt: at(SUN, '14:00'), anyTime: true },
      admin,
    )
    expect(moved.status).toBe(204)
    expect((await h.call('GET', '/admin/schedule/conflicts', undefined, admin)).json).toEqual([])

    // A lesson that has started, or one already cancelled, is not listed.
    await h.call(
      'POST',
      `/admin/bookings/${booked.json.bookingId}/cancel`,
      { reason: '教练请假' },
      admin,
    )
    await exception(h, admin, coach.id, 'off', at(SUN, '13:00'), at(SUN, '18:00'))
    expect((await h.call('GET', '/admin/schedule/conflicts', undefined, admin)).json).toEqual([])
  })

  it('adds 加班 on a day without hours, but not across midnight', async () => {
    const h = setup()
    const { coach, lesson, admin, student } = await venue(h)
    const extra = await exception(h, admin, coach.id, 'extra', at(MON, '19:00'), at(MON, '21:00'))
    expect(extra.status).toBe(201)
    expect(await times(h, student, MON, lesson.id)).toEqual(['19:00', '19:30', '20:00'])
    const late = await exception(
      h,
      admin,
      coach.id,
      'extra',
      at(MON, '23:00'),
      at('2026-10-27', '01:00'),
    )
    expect([late.status, late.json.error.code]).toEqual([400, 'invalid_time'])
    // Up to midnight is fine, and a lesson never runs into the next day.
    const toMidnight = await exception(
      h,
      admin,
      coach.id,
      'extra',
      at(SUN, '22:30'),
      at(MON, '00:00'),
    )
    expect(toMidnight.status).toBe(201)
    expect(await times(h, student, SUN, lesson.id)).toEqual(['22:30', '23:00'])
  })

  it('lets 请假 win over 加班 at the same time', async () => {
    const h = setup()
    const { coach, lesson, admin, student } = await venue(h)
    await exception(h, admin, coach.id, 'extra', at(MON, '09:00'), at(MON, '12:00'))
    await exception(h, admin, coach.id, 'off', at(MON, '10:00'), at(MON, '11:00'))
    expect(await times(h, student, MON, lesson.id)).toEqual(['09:00', '11:00'])
  })

  it('closes the venue for every coach with 闭馆', async () => {
    const h = setup()
    const { coach, lesson, admin, student } = await venue(h)
    const li = secondCoach(h, lesson.id)
    for (const id of [coach.id, li.id]) {
      await hoursPut(h, admin, id, [{ weekday: 0, from: '09:00', to: '12:00' }])
    }
    const booked = await book(h, student, li.id, at(SUN, '11:00'), lesson.id)
    const closed = await h.call(
      'POST',
      '/admin/closures',
      { startsAt: at(SUN, '10:00'), endsAt: at(SUN, '12:00'), note: '比赛' },
      admin,
    )
    expect(closed.status).toBe(201)
    expect(closed.json.conflicts).toEqual([
      expect.objectContaining({ bookingId: booked.json.bookingId, coachName: '李教练' }),
    ])
    expect(await times(h, student, SUN, lesson.id)).toEqual(['09:00', '09:00'])
    const closures = (await h.call('GET', '/admin/closures', undefined, admin)).json
    expect(closures).toEqual([
      expect.objectContaining({ coachId: null, kind: 'off', note: '比赛', byStaff: '管理员' }),
    ])
    // Each coach's 排班 shows it, and so does the coach's own schedule.
    const view = (await h.call('GET', `/admin/coaches/${coach.id}/hours`, undefined, admin)).json
    expect(view.closures).toHaveLength(1)
    expect(view.exceptions).toEqual([])
    const token = await coachToken(h, admin, coach.id)
    const days = (await h.call('GET', `/coach/schedule?from=${SUN}&to=${SUN}`, undefined, token))
      .json
    expect(days.off).toEqual([
      {
        id: closed.json.id,
        startsAt: at(SUN, '10:00'),
        endsAt: at(SUN, '12:00'),
        note: '比赛',
        closure: true,
      },
    ])

    // A coach cannot remove 闭馆; the admin can.
    await h.call('DELETE', `/coach/exceptions/${closed.json.id}`, undefined, token)
    expect(h.db.select().from(scheduleExceptions).all()).toHaveLength(1)
    // Nor through a coach's exception route.
    await h.call(
      'DELETE',
      `/admin/coaches/${coach.id}/exceptions/${closed.json.id}`,
      undefined,
      admin,
    )
    expect(h.db.select().from(scheduleExceptions).all()).toHaveLength(1)
    expect(
      (await h.call('DELETE', `/admin/closures/${closed.json.id}`, undefined, admin)).status,
    ).toBe(204)
    expect(h.db.select().from(scheduleExceptions).all()).toHaveLength(0)
  })

  it('does not take 加班 as 闭馆', async () => {
    const h = setup()
    const { admin } = await venue(h)
    const res = await h.call(
      'POST',
      '/admin/closures',
      { startsAt: at(SUN, '10:00'), endsAt: at(SUN, '09:00') },
      admin,
    )
    expect([res.status, res.json.error.code]).toEqual([400, 'invalid_time'])
  })

  it('refuses group sessions in 请假 or 闭馆', async () => {
    const h = setup()
    const { coach, admin } = await venue(h)
    const kids = h.db
      .insert(lessonTypes)
      .values({ name: '少儿小班课', durationMinutes: 60, price: 8000, capacity: 4 })
      .returning()
      .get()
    h.db.insert(coachLessonTypes).values({ coachId: coach.id, lessonTypeId: kids.id }).run()
    const session = (date: string, from: string) =>
      h.call(
        'POST',
        '/admin/sessions',
        {
          lessonTypeId: kids.id,
          capacity: 4,
          sessions: [
            {
              coachId: coach.id,
              startsAt: at(date, from),
              endsAt: venueInstant(date, minutes(from) + 60).toISOString(),
            },
          ],
        },
        admin,
      )
    await exception(h, admin, coach.id, 'off', at(SUN, '10:00'), at(SUN, '11:00'))
    await h.call(
      'POST',
      '/admin/closures',
      { startsAt: at(MON, '00:00'), endsAt: at('2026-10-27', '00:00') },
      admin,
    )
    const leave = await session(SUN, '10:30')
    expect([leave.status, leave.json.error.code, leave.json.error.message]).toEqual([
      409,
      'coach_off',
      '10月25日 10:30 王教练请假',
    ])
    const closed = await session(MON, '15:00')
    expect([closed.status, closed.json.error.message]).toEqual([409, '10月26日 15:00 场馆闭馆'])
    // Touching the 请假 is fine.
    expect((await session(SUN, '11:00')).status).toBe(201)
  })

  it('takes no one new in a session that a later 请假 or 闭馆 covers', async () => {
    const h = setup()
    const { coach, admin } = await venue(h)
    const kids = h.db
      .insert(lessonTypes)
      .values({ name: '少儿小班课', durationMinutes: 60, price: 8000, capacity: 4 })
      .returning()
      .get()
    h.db.insert(coachLessonTypes).values({ coachId: coach.id, lessonTypeId: kids.id }).run()
    await h.call(
      'POST',
      '/admin/sessions',
      {
        lessonTypeId: kids.id,
        capacity: 4,
        sessions: [SUN, MON].map((d) => ({
          coachId: coach.id,
          startsAt: at(d, '15:00'),
          endsAt: at(d, '16:00'),
        })),
      },
      admin,
    )
    const [sunday, monday] = h.db.select().from(slots).all()
    const student = await h.student('b')
    const offered = async (date: string) =>
      (await h.call('GET', `/slots?date=${date}&lessonTypeId=${kids.id}`, undefined, student)).json
        .length
    expect([await offered(SUN), await offered(MON)]).toEqual([1, 1])

    await exception(h, admin, coach.id, 'off', at(SUN, '14:30'), at(SUN, '15:30'))
    await h.call(
      'POST',
      '/admin/closures',
      { startsAt: at(MON, '00:00'), endsAt: at('2026-10-27', '00:00') },
      admin,
    )
    expect([await offered(SUN), await offered(MON)]).toEqual([0, 0])
    const leave = await h.call(
      'POST',
      '/bookings',
      { slotId: sunday?.id, lessonTypeId: kids.id },
      student,
    )
    expect([leave.status, leave.json.error.code]).toEqual([409, 'coach_off'])
    const closed = await h.call(
      'POST',
      '/admin/bookings',
      {
        studentId: 1,
        slotId: monday?.id,
        lessonTypeId: kids.id,
        payWith: 'offline',
        amount: 8000,
        method: 'cash',
      },
      admin,
    )
    expect([closed.status, closed.json.error.code]).toEqual([409, 'venue_closed'])
  })

  it('cuts one under way short at now instead of removing what is past', async () => {
    const h = setup()
    const { coach, admin } = await venue(h)
    const leave = await exception(h, admin, coach.id, 'off', at(SUN, '09:00'), at(SUN, '12:00'))
    h.clock.now = new Date(Date.parse(at(SUN, '10:02')))
    const later = await h.admin()
    await h.call(
      'DELETE',
      `/admin/coaches/${coach.id}/exceptions/${leave.json.id}`,
      undefined,
      later,
    )
    const row = h.db.select().from(scheduleExceptions).get()
    expect(row?.endsAt.toISOString()).toBe(at(SUN, '10:05'))
    h.clock.now = new Date(Date.parse(at(SUN, '10:05')))
    const ended = await h.call(
      'DELETE',
      `/admin/coaches/${coach.id}/exceptions/${leave.json.id}`,
      undefined,
      later,
    )
    expect([ended.status, ended.json.error.code]).toEqual([409, 'ended'])
    // It is still on record and no longer in the 排班 view.
    expect(h.db.select().from(scheduleExceptions).all()).toHaveLength(1)
    const view = (await h.call('GET', `/admin/coaches/${coach.id}/hours`, undefined, later)).json
    expect(view.exceptions).toEqual([])
    // Logged as cut short, with what is left, not as deleted.
    const log = (
      await h.call('GET', '/admin/actions?actions=schedule.end,schedule.remove', undefined, later)
    ).json
    expect(log.map((e: { action: string; summary: string }) => [e.action, e.summary])).toEqual([
      ['schedule.end', '王教练：请假 10月25日 09:00-12:00 提前结束，改为 10月25日 09:00-10:05'],
    ])
  })

  it('logs a coach cutting their own 请假 short, and hours saved again only once', async () => {
    const h = setup()
    const { coach, admin } = await venue(h)
    const token = await coachToken(h, admin, coach.id)
    const hours = { hours: [{ weekday: 0, startMinute: 540, endMinute: 720 }] }
    for (let i = 0; i < 2; i++) {
      expect((await h.call('PUT', '/coach/hours', hours, token)).status).toBe(200)
    }
    const leave = await h.call(
      'POST',
      '/coach/exceptions',
      { kind: 'off', startsAt: at(SUN, '09:00'), endsAt: at(SUN, '12:00'), note: '' },
      token,
    )
    h.clock.now = new Date(Date.parse(at(SUN, '10:02')))
    const later = await h.admin()
    const again = await coachToken(h, later, coach.id)
    expect(
      (await h.call('DELETE', `/coach/exceptions/${leave.json.id}`, undefined, again)).status,
    ).toBe(200)
    const log = (await h.call('GET', '/admin/actions', undefined, later)).json
    expect(
      log.map((e: { action: string; summary: string }) => [e.action, e.summary]).reverse(),
    ).toEqual([
      ['coach.hours', '王教练：每周时间（2026-10-23 起）'],
      ['coach.leave_add', '王教练：请假 10月25日 09:00-12:00'],
      ['coach.leave_end', '王教练：请假 10月25日 09:00-12:00 提前结束，改为 10月25日 09:00-10:05'],
    ])
    // Different hours are a change again.
    await h.call('PUT', '/coach/hours', { hours: [] }, again)
    const hoursLog = await h.call('GET', '/admin/actions?actions=coach.hours', undefined, later)
    expect(hoursLog.json).toHaveLength(2)
  })

  it('adds a repeated request once and refuses odd times', async () => {
    const h = setup()
    const { coach, admin } = await venue(h)
    const first = await exception(h, admin, coach.id, 'off', at(SUN, '09:00'), at(SUN, '10:00'))
    const again = await exception(h, admin, coach.id, 'off', at(SUN, '09:00'), at(SUN, '10:00'))
    expect(again.json.id).toBe(first.json.id)
    expect(h.db.select().from(scheduleExceptions).all()).toHaveLength(1)
    const cases: [string, string, string, number, string][] = [
      ['off', at(SUN, '09:03'), at(SUN, '10:00'), 400, 'invalid_time'],
      ['off', at(SUN, '10:00'), at(SUN, '10:00'), 400, 'invalid_time'],
      ['off', at('2026-10-22', '09:00'), at('2026-10-23', '09:00'), 400, 'invalid_time'],
      ['extra', at('2027-11-01', '09:00'), at('2027-11-01', '10:00'), 400, 'invalid_time'],
      ['off', at(SUN, '09:00'), at('2027-11-01', '10:00'), 400, 'invalid_time'],
      ['nap', at(SUN, '09:00'), at(SUN, '10:00'), 400, 'invalid_body'],
      ['off', 'tomorrow', at(SUN, '10:00'), 400, 'invalid_body'],
    ]
    for (const [kind, startsAt, endsAt, status, code] of cases) {
      const res = await h.call(
        'POST',
        `/admin/coaches/${coach.id}/exceptions`,
        { kind, startsAt, endsAt },
        admin,
      )
      expect([res.status, res.json.error?.code]).toEqual([status, code])
    }
    const unknown = await exception(h, admin, 99, 'off', at(SUN, '09:00'), at(SUN, '10:00'))
    expect(unknown.status).toBe(404)
    // One that started earlier today but has not ended can still be added.
    expect(
      (
        await exception(
          h,
          admin,
          coach.id,
          'off',
          at('2026-10-23', '09:00'),
          at('2026-10-23', '11:00'),
        )
      ).status,
    ).toBe(201)
  })

  it('logs who changed 排班, and names them in the view', async () => {
    const h = setup()
    const { coach, admin } = await venue(h)
    await hoursPut(h, admin, coach.id, [{ weekday: 0, from: '09:00', to: '10:00' }])
    const leave = await exception(h, admin, coach.id, 'off', at(SUN, '09:00'), at(SUN, '10:00'))
    await h.call(
      'DELETE',
      `/admin/coaches/${coach.id}/exceptions/${leave.json.id}`,
      undefined,
      admin,
    )
    const log = (await h.call('GET', '/admin/actions', undefined, admin)).json
    const entries = (log.items ?? log) as { action: string; summary: string }[]
    expect(entries.map((e) => [e.action, e.summary]).reverse()).toEqual([
      ['schedule.hours', '王教练：每周时间（2026-10-23 起）'],
      ['schedule.add', '王教练：请假 10月25日 09:00-10:00'],
      ['schedule.remove', '王教练：请假 10月25日 09:00-10:00'],
    ])
  })
})

describe('the coach keeping their own 排班', () => {
  it('lets the coach set hours and 请假, which staff see as theirs', async () => {
    const h = setup()
    const { coach, lesson, admin, student } = await venue(h)
    const token = await coachToken(h, admin, coach.id)
    const put = await h.call(
      'PUT',
      '/coach/hours',
      { hours: [{ weekday: 0, startMinute: 540, endMinute: 720 }] },
      token,
    )
    expect(put.status).toBe(200)
    const leave = await h.call(
      'POST',
      '/coach/exceptions',
      { kind: 'off', startsAt: at(SUN, '09:00'), endsAt: at(SUN, '10:00'), note: '有事' },
      token,
    )
    expect(leave.status).toBe(201)
    // The same request again adds nothing and logs nothing.
    const again = await h.call(
      'POST',
      '/coach/exceptions',
      { kind: 'off', startsAt: at(SUN, '09:00'), endsAt: at(SUN, '10:00'), note: '有事' },
      token,
    )
    expect(again.json.id).toBe(leave.json.id)
    expect(again.json.created).toBeUndefined()
    expect(await times(h, student, SUN, lesson.id)).toEqual(['10:00', '10:30', '11:00'])
    const view = (await h.call('GET', '/coach/hours', undefined, token)).json
    expect(view).toMatchObject({
      coachEdits: true,
      advanceDays: 14,
      exceptions: [{ kind: 'off', note: '有事', byStaff: null }],
    })
    expect(
      (await h.call('DELETE', `/coach/exceptions/${leave.json.id}`, undefined, token)).status,
    ).toBe(200)
    expect(await times(h, student, SUN, lesson.id)).toHaveLength(5)
    // A repeat of the delete removes nothing and logs nothing.
    await h.call('DELETE', `/coach/exceptions/${leave.json.id}`, undefined, token)
    const log = (await h.call('GET', '/admin/actions', undefined, admin)).json as {
      action: string
      summary: string
      staff: unknown
      coach: { id: number; name: string } | null
    }[]
    expect(log.map((e) => [e.action, e.summary, e.staff, e.coach?.id]).reverse()).toEqual([
      ['coach.hours', '王教练：每周时间（2026-10-23 起）', null, coach.id],
      ['coach.leave_add', '王教练：请假 10月25日 09:00-10:00', null, coach.id],
      ['coach.leave_remove', '王教练：请假 10月25日 09:00-10:00', null, coach.id],
    ])
  })

  it("reaches as far as the coach's lesson with the longest booking window", async () => {
    const h = setup()
    const { coach, lesson, admin, student } = await venue(h)
    const token = await coachToken(h, admin, coach.id)
    h.db
      .update(lessonTypes)
      .set({ rules: { advanceDays: 24 } })
      .where(eq(lessonTypes.id, lesson.id))
      .run()
    await h.call(
      'PUT',
      '/coach/hours',
      { hours: [{ weekday: 1, startMinute: 840, endMinute: 900 }] },
      token,
    )
    expect((await h.call('GET', '/coach/hours', undefined, token)).json.advanceDays).toBe(24)
    expect((await h.call('GET', '/coach/me', undefined, token)).json.advanceDays).toBe(24)
    // 24 days from Friday 10-23 runs to Monday 11-16: past the venue's 14.
    expect(await times(h, student, '2026-11-16', lesson.id)).toEqual(['14:00'])
    const days = await h.call(
      'GET',
      `/slots/open-days?lessonTypeId=${lesson.id}`,
      undefined,
      student,
    )
    expect(days.json).toEqual(['2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16'])
    // Shortened again, the far Mondays go.
    h.db.update(lessonTypes).set({ rules: {} }).where(eq(lessonTypes.id, lesson.id)).run()
    expect(await times(h, student, '2026-11-16', lesson.id)).toEqual([])
  })

  it('keeps edits to staff when the venue says so', async () => {
    const h = setup()
    const { coach, admin } = await venue(h)
    const token = await coachToken(h, admin, coach.id)
    const leave = await exception(h, admin, coach.id, 'off', at(SUN, '09:00'), at(SUN, '10:00'))
    h.settings((s) => {
      s.booking.coachEditsHours = false
    })
    const tries = [
      await h.call('PUT', '/coach/hours', { hours: [] }, token),
      await h.call(
        'POST',
        '/coach/exceptions',
        { kind: 'off', startsAt: at(SUN, '11:00'), endsAt: at(SUN, '12:00') },
        token,
      ),
      await h.call('DELETE', `/coach/exceptions/${leave.json.id}`, undefined, token),
    ]
    expect(tries.map((r) => [r.status, r.json.error.code])).toEqual(
      Array(3).fill([403, 'schedule_locked']),
    )
    expect(h.db.select().from(scheduleExceptions).all()).toHaveLength(1)
    // The coach can still look; staff still edit.
    expect((await h.call('GET', '/coach/hours', undefined, token)).json.coachEdits).toBe(false)
    expect(
      (await hoursPut(h, admin, coach.id, [{ weekday: 0, from: '09:00', to: '10:00' }])).status,
    ).toBe(200)
  })

  it('refuses a weekly hours save made on top of the other side changing them', async () => {
    const h = setup()
    const { coach, admin } = await venue(h)
    const token = await coachToken(h, admin, coach.id)
    const week = (startMinute: number) => ({ hours: [{ weekday: 0, startMinute, endMinute: 720 }] })
    // Staff and the coach both open the 排班.
    const staffSaw = (await h.call('GET', `/admin/coaches/${coach.id}/hours`, undefined, admin))
      .json.hoursVersion
    const coachSaw = (await h.call('GET', '/coach/hours', undefined, token)).json.hoursVersion
    const coachSave = await h.call('PUT', '/coach/hours', week(540), token, {
      'If-Match': versionOf(coachSaw),
    })
    expect(coachSave.status).toBe(200)
    const staffSave = await h.call('PUT', `/admin/coaches/${coach.id}/hours`, week(600), admin, {
      'If-Match': versionOf(staffSaw),
      'Idempotency-Key': 'staff-hours-1',
    })
    expect([staffSave.status, staffSave.json.error.code]).toEqual([409, 'edited_elsewhere'])
    // The coach's hours stand; saved again on top of them, staff win.
    const now = (await h.call('GET', `/admin/coaches/${coach.id}/hours`, undefined, admin)).json
    expect(now.periods[0].hours).toEqual(week(540).hours)
    const again = await h.call('PUT', `/admin/coaches/${coach.id}/hours`, week(600), admin, {
      'If-Match': versionOf(now.hoursVersion),
      'Idempotency-Key': 'staff-hours-2',
    })
    expect(again.status).toBe(200)
    // A stale save from the coach is refused the same way.
    const stale = await h.call('PUT', '/coach/hours', week(480), token, {
      'If-Match': versionOf(coachSaw),
    })
    expect([stale.status, stale.json.error.code]).toEqual([409, 'edited_elsewhere'])
    // A repeat of the staff save (a lost response) gets its first answer back.
    const repeat = await h.call('PUT', `/admin/coaches/${coach.id}/hours`, week(600), admin, {
      'If-Match': versionOf(now.hoursVersion),
      'Idempotency-Key': 'staff-hours-2',
    })
    expect(repeat.status).toBe(200)
    expect(
      (await h.call('GET', '/coach/hours', undefined, token)).json.periods[0].hours[0].startMinute,
    ).toBe(600)
  })

  it('takes a weekly hours save loaded before the venue midnight as current', async () => {
    // 23:50 at the venue on Friday.
    const h = setup({ now: '2026-10-23T15:50:00Z' })
    const { coach, admin } = await venue(h)
    // A change planned from Saturday, so the periods from today change shape at midnight.
    await hoursPut(h, admin, coach.id, [{ weekday: 6, from: '09:00', to: '12:00' }], '2026-10-24')
    const saw = (await h.call('GET', `/admin/coaches/${coach.id}/hours`, undefined, admin)).json
    h.clock.now = new Date('2026-10-23T16:10:00Z')
    const save = await h.call(
      'PUT',
      `/admin/coaches/${coach.id}/hours`,
      { hours: [{ weekday: 0, startMinute: 540, endMinute: 720 }] },
      admin,
      { 'If-Match': versionOf(saw.hoursVersion) },
    )
    expect(save.status).toBe(200)
  })

  it('keeps one coach out of another coach 请假', async () => {
    const h = setup()
    const { coach, lesson, admin } = await venue(h)
    const li = secondCoach(h, lesson.id)
    const theirs = await exception(h, admin, li.id, 'off', at(SUN, '09:00'), at(SUN, '10:00'))
    const token = await coachToken(h, admin, coach.id)
    await h.call('DELETE', `/coach/exceptions/${theirs.json.id}`, undefined, token)
    expect(h.db.select().from(scheduleExceptions).all()).toHaveLength(1)
    // The admin route checks the coach too.
    await h.call(
      'DELETE',
      `/admin/coaches/${coach.id}/exceptions/${theirs.json.id}`,
      undefined,
      admin,
    )
    expect(h.db.select().from(scheduleExceptions).all()).toHaveLength(1)
  })

  it('shows the coach free time, lessons and 请假, without the past', async () => {
    const h = setup()
    const { coach, lesson, admin, student } = await venue(h)
    await hoursPut(h, admin, coach.id, [
      { weekday: 5, from: '08:00', to: '12:00' },
      { weekday: 0, from: '09:00', to: '12:00' },
    ])
    await book(h, student, coach.id, at(SUN, '10:00'), lesson.id)
    await exception(h, admin, coach.id, 'off', at(SUN, '11:30'), at(SUN, '12:00'))
    const token = await coachToken(h, admin, coach.id)
    const days = (
      await h.call('GET', `/coach/schedule?from=2026-10-23&to=${SUN}`, undefined, token)
    ).json
    expect(
      days.free.map((f: { startsAt: string; endsAt: string }) => [f.startsAt, f.endsAt]),
    ).toEqual([
      // Friday from now on.
      [at('2026-10-23', '10:00'), at('2026-10-23', '12:00')],
      [at(SUN, '09:00'), at(SUN, '10:00')],
      // 11:00 to 11:30 is too short for any lesson the coach teaches, so nobody can book it.
    ])
    // 排班 itself, past hours included, so 工作台 can tell a day that is over from one off it.
    expect(
      days.working.map((w: { startsAt: string; endsAt: string }) => [w.startsAt, w.endsAt]),
    ).toEqual([
      [at('2026-10-23', '08:00'), at('2026-10-23', '12:00')],
      [at(SUN, '09:00'), at(SUN, '11:30')],
    ])
    expect(days.lessons).toHaveLength(1)
    expect(days.off).toEqual([
      expect.objectContaining({
        startsAt: at(SUN, '11:30'),
        endsAt: at(SUN, '12:00'),
        note: '',
        closure: false,
      }),
    ])
  })
})

describe('booking a private lesson by coach and time', () => {
  it('takes the coach for the whole lesson, so overlapping starts go', async () => {
    const h = setup()
    const { coach, lesson, admin, student } = await venue(h)
    const other = await h.student('b')
    await hoursPut(h, admin, coach.id, [{ weekday: 0, from: '09:00', to: '13:00' }])
    const booked = await book(h, student, coach.id, at(SUN, '10:00'), lesson.id)
    expect(booked.status).toBe(201)
    expect(await times(h, other, SUN, lesson.id)).toEqual(['09:00', '11:00', '11:30', '12:00'])
    for (const t of ['09:30', '10:00', '10:30']) {
      const res = await book(h, other, coach.id, at(SUN, t), lesson.id)
      expect([t, res.status, res.json.error.code]).toEqual([t, 409, 'slot_taken'])
    }
    expect((await book(h, other, coach.id, at(SUN, '11:00'), lesson.id)).status).toBe(201)
    expect(h.db.select().from(slots).all()).toHaveLength(2)
  })

  it('offers the student their own lapsed unpaid hold’s time again, and only that start', async () => {
    const h = setup()
    const { coach, lesson, admin, student } = await venue(h)
    const other = await h.student('b')
    await hoursPut(h, admin, coach.id, [{ weekday: 0, from: '09:00', to: '13:00' }])
    const held = await book(h, student, coach.id, at(SUN, '10:00'), lesson.id, { pay: false })
    expect(held.json.status).toBe('pending_payment')
    const moveFrom = await book(h, student, coach.id, at(SUN, '12:00'), lesson.id)
    expect(moveFrom.status).toBe(201)
    // While it can still be paid, the time is theirs and not offered.
    expect(await times(h, student, SUN, lesson.id)).toEqual(['09:00', '11:00'])
    h.clock.now = new Date(h.clock.now.getTime() + 60 * 60_000)
    // Its payment time is up, but the sweep has not closed it yet. Booking that start again
    // closes it first, so it is offered to them; 10:30 still overlaps the hold, and others
    // still wait for the sweep.
    expect(await times(h, student, SUN, lesson.id)).toEqual(['09:00', '10:00', '11:00'])
    expect(await times(h, other, SUN, lesson.id)).toEqual(['09:00', '11:00'])
    // A move does not close it, so a move is not offered that time.
    const moving = await h.call(
      'GET',
      `/slots?date=${SUN}&lessonTypeId=${lesson.id}&moving=${moveFrom.json.bookingId}`,
      undefined,
      student,
    )
    expect(
      (moving.json as { id: number | null; startsAt: string }[])
        .filter((s) => s.id === null)
        .map((s) => hhmm(s.startsAt)),
    ).not.toContain('10:00')
    const again = await book(h, student, coach.id, at(SUN, '10:00'), lesson.id, { pay: false })
    expect(again.status).toBe(201)
    expect(again.json.bookingId).not.toBe(held.json.bookingId)
  })

  it('refuses a time 排班 does not offer', async () => {
    const h = setup()
    const { coach, lesson, admin, student } = await venue(h)
    await hoursPut(h, admin, coach.id, [{ weekday: 0, from: '09:00', to: '12:00' }])
    const cases: [string, number, string][] = [
      [at(SUN, '10:10'), 409, 'time_unavailable'],
      [at(SUN, '11:30'), 409, 'time_unavailable'],
      [at(SUN, '08:30'), 409, 'time_unavailable'],
      [at(MON, '10:00'), 409, 'time_unavailable'],
      [at(SUN, '10:03'), 400, 'invalid_time'],
      [at(SUN, '23:30'), 409, 'crosses_midnight'],
    ]
    for (const [startsAt, status, code] of cases) {
      const res = await book(h, student, coach.id, startsAt, lesson.id)
      expect([hhmm(startsAt), res.status, res.json.error.code]).toEqual([
        hhmm(startsAt),
        status,
        code,
      ])
    }
    const bad = [
      { coachId: coach.id, lessonTypeId: lesson.id },
      { startsAt: at(SUN, '10:00'), lessonTypeId: lesson.id },
      { slotId: 1, coachId: coach.id, startsAt: at(SUN, '10:00'), lessonTypeId: lesson.id },
      { coachId: coach.id, startsAt: '2026-10-25 10:00', lessonTypeId: lesson.id },
    ]
    for (const body of bad) {
      const res = await h.call('POST', '/bookings', body, student)
      expect([res.status, res.json.error.code]).toEqual([400, 'invalid_body'])
    }
    expect((await book(h, student, 99, at(SUN, '10:00'), lesson.id)).status).toBe(404)
    expect(h.db.select().from(slots).all()).toEqual([])
  })

  it('keeps the buffer clear and packs the day after a lesson', async () => {
    const h = setup()
    const { coach, lesson, admin, student } = await venue(h)
    const other = await h.student('b')
    h.settings((s) => {
      s.booking.bufferMinutes = 15
    })
    await hoursPut(h, admin, coach.id, [{ weekday: 0, from: '09:00', to: '13:00' }])
    await book(h, student, coach.id, at(SUN, '10:00'), lesson.id)
    expect(await times(h, other, SUN, lesson.id)).toEqual(['11:15', '11:30', '12:00'])
    const tight = await book(h, other, coach.id, at(SUN, '11:00'), lesson.id)
    expect([tight.status, tight.json.error.code]).toEqual([409, 'slot_taken'])
    const before = await book(h, other, coach.id, at(SUN, '09:00'), lesson.id)
    expect([before.status, before.json.error.code]).toEqual([409, 'slot_taken'])
    expect((await book(h, other, coach.id, at(SUN, '11:15'), lesson.id)).status).toBe(201)
    // The coach sees as free only what is left to book: 09:00 to 09:45 is too short once the
    // buffer is kept, so nothing is.
    const token = await coachToken(h, admin, coach.id)
    const days = (await h.call('GET', `/coach/schedule?from=${SUN}&to=${SUN}`, undefined, token))
      .json
    expect(days.free).toEqual([])
  })

  it('packs around a lesson the desk put off the grid', async () => {
    const h = setup()
    const { coach, lesson, admin } = await venue(h)
    await hoursPut(h, admin, coach.id, [{ weekday: 0, from: '09:00', to: '13:00' }])
    const desk = await h.call(
      'POST',
      '/admin/bookings',
      {
        studentId: 1,
        coachId: coach.id,
        startsAt: at(SUN, '10:10'),
        lessonTypeId: lesson.id,
        payWith: 'offline',
        amount: 20000,
        method: 'cash',
        anyTime: true,
      },
      admin,
    )
    expect(desk.status).toBe(201)
    const other = await h.student('b')
    expect(await times(h, other, SUN, lesson.id)).toEqual(['09:00', '11:10', '11:30', '12:00'])
  })

  it('frees the time on cancel and books the same lesson row again', async () => {
    const h = setup()
    const { coach, lesson, admin, student } = await venue(h)
    const other = await h.student('b')
    await hoursPut(h, admin, coach.id, [{ weekday: 0, from: '09:00', to: '12:00' }])
    const first = await book(h, student, coach.id, at(SUN, '10:00'), lesson.id)
    await h.call('POST', `/bookings/${first.json.bookingId}/cancel`, {}, student)
    expect(await times(h, other, SUN, lesson.id)).toContain('10:00')
    const second = await book(h, other, coach.id, at(SUN, '10:00'), lesson.id)
    expect(second.status).toBe(201)
    expect(h.db.select().from(slots).all()).toHaveLength(1)
    // An overlapping time gets a row of its own once the first is free again.
    await h.call('POST', `/bookings/${second.json.bookingId}/cancel`, {}, other)
    expect((await book(h, student, coach.id, at(SUN, '10:30'), lesson.id)).status).toBe(201)
    expect(h.db.select().from(slots).all()).toHaveLength(2)
    // The free row does not show in the admin list.
    const listed = (
      await h.call(
        'GET',
        `/admin/slots?from=${at(SUN, '00:00')}&to=${at(MON, '00:00')}`,
        undefined,
        admin,
      )
    ).json
    expect(listed.map((s: { startsAt: string }) => hhmm(s.startsAt))).toEqual(['10:30'])
  })

  it('answers a repeated tap with the same booking', async () => {
    const h = setup()
    const { coach, lesson, admin, student } = await venue(h)
    await hoursPut(h, admin, coach.id, [{ weekday: 0, from: '09:00', to: '12:00' }])
    const first = await book(h, student, coach.id, at(SUN, '10:00'), lesson.id, { pay: false })
    const again = await book(h, student, coach.id, at(SUN, '10:00'), lesson.id, { pay: false })
    expect(again.status).toBe(201)
    expect(again.json.bookingId).toBe(first.json.bookingId)
    expect(h.db.select().from(bookings).all()).toHaveLength(1)
    // A different, overlapping time is the student's own clash.
    const clash = await book(h, student, coach.id, at(SUN, '10:30'), lesson.id, { pay: false })
    expect(clash.status).toBe(409)
  })

  it('holds the time while unpaid and gives it back when the hold expires', async () => {
    const h = setup()
    const { coach, lesson, admin, student } = await venue(h)
    const other = await h.student('b')
    await hoursPut(h, admin, coach.id, [{ weekday: 0, from: '09:00', to: '11:00' }])
    const held = await book(h, student, coach.id, at(SUN, '09:30'), lesson.id, { pay: false })
    expect(held.json.orderId).toBeTruthy()
    expect(await times(h, other, SUN, lesson.id)).toEqual([])
    h.clock.now = new Date(h.clock.now.getTime() + 30 * 60_000)
    await h.call('GET', '/bookings', undefined, student)
    const { expireOrders } = await import('./services/orders')
    await expireOrders(h.deps)
    expect(await times(h, other, SUN, lesson.id)).toEqual(['09:00', '09:30', '10:00'])
  })

  it('refuses a group class at a private time, a coach who stopped, and one who does not teach it', async () => {
    const h = setup()
    const { coach, lesson, admin, student } = await venue(h)
    await hoursPut(h, admin, coach.id, [{ weekday: 0, from: '09:00', to: '12:00' }])
    const kids = h.db
      .insert(lessonTypes)
      .values({ name: '少儿小班课', durationMinutes: 60, price: 8000, capacity: 4 })
      .returning()
      .get()
    h.db.insert(coachLessonTypes).values({ coachId: coach.id, lessonTypeId: kids.id }).run()
    const group = await book(h, student, coach.id, at(SUN, '10:00'), kids.id)
    expect([group.status, group.json.error.code]).toEqual([409, 'lesson_type_mismatch'])
    // Students are not offered private times for a group class.
    expect(await times(h, student, SUN, kids.id)).toEqual([])

    const li = h.db.insert(coaches).values({ name: '李教练' }).returning().get()
    await hoursPut(h, admin, li.id, [{ weekday: 0, from: '09:00', to: '12:00' }])
    expect(await times(h, student, SUN, lesson.id, li.id)).toEqual([])
    const notTaught = await book(h, student, li.id, at(SUN, '10:00'), lesson.id)
    expect(notTaught.status).toBe(409)

    h.db.update(coaches).set({ active: false }).where(eq(coaches.id, coach.id)).run()
    expect(await times(h, student, SUN, lesson.id)).toEqual([])
    const stopped = await book(h, student, coach.id, at(SUN, '10:00'), lesson.id)
    expect([stopped.status, stopped.json.error.code]).toEqual([409, 'coach_not_teaching'])
    expect(h.db.select().from(slots).all()).toEqual([])
  })

  it('keeps to the booking window: too soon is shown but closed, too far is hidden', async () => {
    const h = setup()
    const { coach, lesson, admin, student } = await venue(h)
    // Friday, today: now is 10:00 and lessons need 2 hours notice.
    await hoursPut(h, admin, coach.id, [{ weekday: 5, from: '08:00', to: '14:00' }])
    const res = await h.call(
      'GET',
      `/slots?date=2026-10-23&lessonTypeId=${lesson.id}`,
      undefined,
      student,
    )
    expect(
      res.json.map((s: { startsAt: string; available: boolean }) => [
        hhmm(s.startsAt),
        s.available,
      ]),
    ).toEqual([
      ['10:00', false],
      ['10:30', false],
      ['11:00', false],
      ['11:30', false],
      ['12:00', true],
      ['12:30', true],
      ['13:00', true],
    ])
    const soon = await book(h, student, coach.id, at('2026-10-23', '11:00'), lesson.id)
    expect([soon.status, soon.json.error.code]).toEqual([409, 'too_soon'])
    // 14 days ahead is the last day shown.
    expect(await times(h, student, '2026-11-06', lesson.id)).toHaveLength(11)
    expect(await times(h, student, '2026-11-13', lesson.id)).toEqual([])
    const far = await book(h, student, coach.id, at('2026-11-13', '12:00'), lesson.id)
    expect([far.status, far.json.error.code]).toEqual([409, 'too_far'])
  })

  it('quotes a time without making a lesson row', async () => {
    const h = setup()
    const { coach, lesson, admin, student } = await venue(h)
    await hoursPut(h, admin, coach.id, [{ weekday: 0, from: '09:00', to: '12:00' }])
    const q = new URLSearchParams({
      coachId: String(coach.id),
      startsAt: at(SUN, '10:00'),
      lessonTypeId: String(lesson.id),
    })
    const res = await h.call('GET', `/bookings/quote?${q}`, undefined, student)
    expect(res.status).toBe(200)
    expect(res.json.price).toMatchObject({ price: 20000 })
    expect(h.db.select().from(slots).all()).toEqual([])
    const none = await h.call(
      'GET',
      `/bookings/quote?lessonTypeId=${lesson.id}`,
      undefined,
      student,
    )
    expect(none.status).toBe(400)
  })

  it('still books an old private lesson row by its id', async () => {
    const h = setup()
    const { coach, lesson, student } = await venue(h)
    const slot = h.slot(coach.id, SUN, 10)
    const res = await h.call(
      'POST',
      '/bookings',
      { slotId: slot.id, lessonTypeId: lesson.id },
      student,
    )
    expect(res.status).toBe(201)
    expect(h.db.select().from(bookings).get()?.slotId).toBe(slot.id)
  })

  it('shares tables between coaches, time by time', async () => {
    const h = setup()
    const { coach, lesson, admin, student } = await venue(h)
    const li = secondCoach(h, lesson.id)
    const other = await h.student('b')
    h.settings((s) => {
      s.booking.tables = 1
    })
    for (const id of [coach.id, li.id]) {
      await hoursPut(h, admin, id, [{ weekday: 0, from: '09:00', to: '12:00' }])
    }
    await book(h, student, coach.id, at(SUN, '10:00'), lesson.id)
    const res = await h.call(
      'GET',
      `/slots?date=${SUN}&lessonTypeId=${lesson.id}&coachId=${li.id}`,
      undefined,
      other,
    )
    expect(
      res.json.map((s: { startsAt: string; available: boolean }) => [
        hhmm(s.startsAt),
        s.available,
      ]),
    ).toEqual([
      ['09:00', true],
      ['09:30', false],
      ['10:00', false],
      ['10:30', false],
      ['11:00', true],
    ])
    const full = await book(h, other, li.id, at(SUN, '10:30'), lesson.id)
    expect([full.status, full.json.error.code]).toEqual([409, 'tables_full'])
    expect((await book(h, other, li.id, at(SUN, '11:00'), lesson.id)).status).toBe(201)
  })
})

describe('the front desk booking outside 排班', () => {
  async function desk(
    h: Harness,
    admin: string,
    body: Record<string, unknown>,
    path = '/admin/bookings',
  ) {
    return h.call(
      'POST',
      path,
      { studentId: 1, payWith: 'offline', amount: 20000, method: 'cash', ...body },
      admin,
    )
  }

  it('books inside 排班 like a student, and outside it only when told to', async () => {
    const h = setup()
    const { coach, lesson, admin } = await venue(h)
    await hoursPut(h, admin, coach.id, [{ weekday: 0, from: '09:00', to: '12:00' }])
    const outside = { coachId: coach.id, startsAt: at(SUN, '18:00'), lessonTypeId: lesson.id }
    const refused = await desk(h, admin, outside)
    expect([refused.status, refused.json.error.code]).toEqual([409, 'time_unavailable'])
    const quoted = await desk(h, admin, { ...outside, anyTime: true }, '/admin/bookings/quote')
    expect(quoted.status).toBe(200)
    expect(h.db.select().from(slots).all()).toEqual([])
    expect((await desk(h, admin, { ...outside, anyTime: true })).status).toBe(201)
    // Inside 排班 needs no override.
    expect(
      (
        await desk(h, admin, {
          coachId: coach.id,
          startsAt: at(SUN, '10:00'),
          lessonTypeId: lesson.id,
        })
      ).status,
    ).toBe(201)
  })

  it('never double books the coach, even outside 排班', async () => {
    const h = setup()
    const { coach, lesson, admin } = await venue(h)
    await h.student('b')
    const first = await desk(h, admin, {
      coachId: coach.id,
      startsAt: at(SUN, '18:00'),
      lessonTypeId: lesson.id,
      anyTime: true,
    })
    expect(first.status).toBe(201)
    const second = await desk(h, admin, {
      studentId: 2,
      coachId: coach.id,
      startsAt: at(SUN, '18:30'),
      lessonTypeId: lesson.id,
      anyTime: true,
    })
    expect([second.status, second.json.error.code]).toEqual([409, 'coach_busy'])
    const odd = await desk(h, admin, {
      studentId: 2,
      coachId: coach.id,
      startsAt: at(SUN, '19:02'),
      lessonTypeId: lesson.id,
      anyTime: true,
    })
    expect([odd.status, odd.json.error.code]).toEqual([400, 'invalid_time'])
    const late = await desk(h, admin, {
      studentId: 2,
      coachId: coach.id,
      startsAt: at(SUN, '23:30'),
      lessonTypeId: lesson.id,
      anyTime: true,
    })
    expect([late.status, late.json.error.code]).toEqual([409, 'crosses_midnight'])
    // Right after is fine.
    expect(
      (
        await desk(h, admin, {
          studentId: 2,
          coachId: coach.id,
          startsAt: at(SUN, '19:00'),
          lessonTypeId: lesson.id,
          anyTime: true,
        })
      ).status,
    ).toBe(201)
  })

  it('keeps out of 请假 and 闭馆, even outside 排班', async () => {
    const h = setup()
    const { coach, lesson, admin } = await venue(h)
    await exception(h, admin, coach.id, 'off', at(SUN, '15:00'), at(SUN, '17:00'), '比赛')
    await h.call(
      'POST',
      '/admin/closures',
      { startsAt: at(SUN, '19:00'), endsAt: at(SUN, '21:00'), note: '检修' },
      admin,
    )
    const outside = (startsAt: string) => ({
      coachId: coach.id,
      startsAt,
      lessonTypeId: lesson.id,
      anyTime: true,
    })
    for (const path of ['/admin/bookings/quote', '/admin/bookings']) {
      const leave = await desk(h, admin, outside(at(SUN, '14:30')), path)
      expect([leave.status, leave.json.error.code]).toEqual([409, 'coach_off'])
      const closed = await desk(h, admin, outside(at(SUN, '20:00')), path)
      expect([closed.status, closed.json.error.code]).toEqual([409, 'venue_closed'])
    }
    const booked = await desk(h, admin, outside(at(SUN, '17:00')))
    expect(booked.status).toBe(201)
    // A 闭馆 over a 请假 is named as the 闭馆.
    await exception(h, admin, coach.id, 'off', at(SUN, '18:00'), at(SUN, '22:00'))
    const both = await desk(h, admin, outside(at(SUN, '19:00')))
    expect([both.status, both.json.error.code]).toEqual([409, 'venue_closed'])
    const bookingId = h.db.select().from(bookings).get()?.id
    const moved = await h.call(
      'POST',
      `/admin/bookings/${bookingId}/move`,
      { coachId: coach.id, startsAt: at(SUN, '16:00'), anyTime: true },
      admin,
    )
    expect([moved.status, moved.json.error.code]).toEqual([409, 'coach_off'])
  })

  it('refuses a lesson in a group session of the same coach', async () => {
    const h = setup()
    const { coach, lesson, admin } = await venue(h)
    const kids = h.db
      .insert(lessonTypes)
      .values({ name: '少儿小班课', durationMinutes: 60, price: 8000, capacity: 4 })
      .returning()
      .get()
    h.db.insert(coachLessonTypes).values({ coachId: coach.id, lessonTypeId: kids.id }).run()
    await hoursPut(h, admin, coach.id, [{ weekday: 0, from: '09:00', to: '12:00' }])
    await h.call(
      'POST',
      '/admin/sessions',
      {
        lessonTypeId: kids.id,
        capacity: 4,
        sessions: [{ coachId: coach.id, startsAt: at(SUN, '10:00'), endsAt: at(SUN, '11:00') }],
      },
      admin,
    )
    const student = await h.student('b')
    expect(await times(h, student, SUN, lesson.id)).toEqual(['09:00', '11:00'])
    const res = await desk(h, admin, {
      coachId: coach.id,
      startsAt: at(SUN, '10:30'),
      lessonTypeId: lesson.id,
      anyTime: true,
    })
    expect([res.status, res.json.error.code]).toEqual([409, 'coach_busy'])
    // Once the session is called off, the time is the coach's again.
    const session = h.db.select().from(slots).get()
    expect(
      (await h.call('POST', `/admin/slots/${session?.id}/cancel`, { reason: '人数不足' }, admin))
        .status,
    ).toBe(204)
    expect(await times(h, student, SUN, lesson.id)).toEqual([
      '09:00',
      '09:30',
      '10:00',
      '10:30',
      '11:00',
    ])
  })
})

describe('moving a private lesson in 排班', () => {
  it('lets the student move into time their own lesson covers', async () => {
    const h = setup()
    const { coach, lesson, admin, student } = await venue(h)
    await hoursPut(h, admin, coach.id, [{ weekday: 0, from: '09:00', to: '12:00' }])
    const booked = await book(h, student, coach.id, at(SUN, '10:00'), lesson.id)
    const id = booked.json.bookingId
    // The move page lists the times with the lesson's own time free.
    const listed = await h.call('GET', `/slots?date=${SUN}&moving=${id}`, undefined, student)
    expect(listed.json.map((s: { startsAt: string }) => hhmm(s.startsAt))).toEqual([
      '09:00',
      '09:30',
      '10:00',
      '10:30',
      '11:00',
    ])
    const moved = await h.call(
      'POST',
      `/bookings/${id}/move`,
      { coachId: coach.id, startsAt: at(SUN, '10:30') },
      student,
    )
    expect(moved.status).toBe(200)
    expect(h.db.select().from(bookings).get()?.startsAt.toISOString()).toBe(at(SUN, '10:30'))
    const other = await h.student('b')
    expect(await times(h, other, SUN, lesson.id)).toEqual(['09:00', '09:30'])
  })

  it('refuses a student move outside 排班 or onto someone else, and lets the venue override', async () => {
    const h = setup()
    const { coach, lesson, admin, student } = await venue(h)
    const other = await h.student('b')
    h.settings((s) => {
      s.booking.studentMoves = 3
    })
    await hoursPut(h, admin, coach.id, [{ weekday: 0, from: '09:00', to: '12:00' }])
    const mine = (await book(h, student, coach.id, at(SUN, '09:00'), lesson.id)).json.bookingId
    await book(h, other, coach.id, at(SUN, '11:00'), lesson.id)
    const move = (startsAt: string) =>
      h.call('POST', `/bookings/${mine}/move`, { coachId: coach.id, startsAt }, student)
    const outside = await move(at(SUN, '15:00'))
    expect([outside.status, outside.json.error.code]).toEqual([409, 'time_unavailable'])
    const taken = await move(at(SUN, '10:30'))
    expect([taken.status, taken.json.error.code]).toEqual([409, 'slot_taken'])
    // Moving to the time it has is a no-op.
    expect((await move(at(SUN, '09:00'))).status).toBe(200)
    expect(
      h.db.select().from(bookings).where(eq(bookings.id, mine)).get()?.startsAt.toISOString(),
    ).toBe(at(SUN, '09:00'))
    const venueMove = await h.call(
      'POST',
      `/admin/bookings/${mine}/move`,
      { coachId: coach.id, startsAt: at(SUN, '15:00') },
      admin,
    )
    expect([venueMove.status, venueMove.json.error.code]).toEqual([409, 'time_unavailable'])
    const forced = await h.call(
      'POST',
      `/admin/bookings/${mine}/move`,
      { coachId: coach.id, startsAt: at(SUN, '15:00'), anyTime: true },
      admin,
    )
    expect(forced.status).toBe(204)
    // The old time is free for others.
    expect(await times(h, other, SUN, lesson.id)).toEqual(['09:00', '09:30', '10:00'])
  })

  it('lets the coach move within their own 排班 only', async () => {
    const h = setup()
    const { coach, lesson, admin, student } = await venue(h)
    const li = secondCoach(h, lesson.id)
    for (const id of [coach.id, li.id]) {
      await hoursPut(h, admin, id, [{ weekday: 0, from: '09:00', to: '12:00' }])
    }
    const id = (await book(h, student, coach.id, at(SUN, '10:00'), lesson.id)).json.bookingId
    const token = await coachToken(h, admin, coach.id)
    const offered = await h.call(
      'GET',
      `/coach/move-times?bookingId=${id}&from=${SUN}&to=${SUN}`,
      undefined,
      token,
    )
    expect(offered.json.map((t: { startsAt: string }) => hhmm(t.startsAt))).toEqual([
      '09:00',
      '09:30',
      '10:30',
      '11:00',
    ])
    const toLi = await h.call(
      'POST',
      `/coach/lessons/${id}/move`,
      { coachId: li.id, startsAt: at(SUN, '10:00') },
      token,
    )
    expect([toLi.status, toLi.json.error.code]).toEqual([404, 'slot_not_found'])
    const outside = await h.call(
      'POST',
      `/coach/lessons/${id}/move`,
      { coachId: coach.id, startsAt: at(SUN, '14:00') },
      token,
    )
    expect([outside.status, outside.json.error.code]).toEqual([409, 'time_unavailable'])
    const ok = await h.call(
      'POST',
      `/coach/lessons/${id}/move`,
      { coachId: coach.id, startsAt: at(SUN, '11:00') },
      token,
    )
    expect(ok.status).toBe(200)
    // Another coach's lesson is not theirs to look at.
    const liToken = await coachToken(h, admin, li.id, 'li')
    expect(
      (
        await h.call(
          'GET',
          `/coach/move-times?bookingId=${id}&from=${SUN}&to=${SUN}`,
          undefined,
          liToken,
        )
      ).status,
    ).toBe(404)
  })
})

describe('the admin 日程 views', () => {
  it('shows each coach working time, 请假 and tables in use for a day', async () => {
    const h = setup()
    const { coach, lesson, admin, student } = await venue(h)
    const li = secondCoach(h, lesson.id)
    const gone = h.db.insert(coaches).values({ name: '张教练', active: false }).returning().get()
    h.settings((s) => {
      s.booking.tables = 4
    })
    await hoursPut(h, admin, coach.id, [{ weekday: 0, from: '09:00', to: '12:00' }])
    await hoursPut(h, admin, li.id, [{ weekday: 0, from: '14:00', to: '16:00' }])
    await exception(h, admin, coach.id, 'off', at(SUN, '11:00'), at(SUN, '12:00'), '看病')
    await book(h, student, coach.id, at(SUN, '09:30'), lesson.id)
    const day = (await h.call('GET', `/admin/schedule/day?date=${SUN}`, undefined, admin)).json
    expect(day.tables).toBe(4)
    expect(day.coaches.map((c: { id: number }) => c.id)).toEqual([coach.id, li.id])
    expect(day.coaches[0]).toMatchObject({
      name: '王教练',
      active: true,
      working: [{ startsAt: at(SUN, '09:00'), endsAt: at(SUN, '11:00') }],
      off: [expect.objectContaining({ note: '看病', byStaff: '管理员' })],
    })
    expect(day.coaches[1].working).toEqual([
      { startsAt: at(SUN, '14:00'), endsAt: at(SUN, '16:00') },
    ])
    expect(day.tableUse).toEqual([
      { startsAt: at(SUN, '09:30'), used: 1 },
      { startsAt: at(SUN, '10:00'), used: 1 },
    ])
    // An inactive coach shows only on a day they still have a lesson.
    h.db.update(coaches).set({ active: false }).where(eq(coaches.id, coach.id)).run()
    const later = (await h.call('GET', `/admin/schedule/day?date=${SUN}`, undefined, admin)).json
    expect(later.coaches.map((c: { id: number }) => c.id)).toEqual([coach.id, li.id])
    expect(later.coaches.map((c: { id: number }) => c.id)).not.toContain(gone.id)
    const monday = (await h.call('GET', `/admin/schedule/day?date=${MON}`, undefined, admin)).json
    expect(monday.coaches.map((c: { id: number }) => c.id)).toEqual([li.id])
    const bad = await h.call('GET', '/admin/schedule/day?date=2026-02-30', undefined, admin)
    expect(bad.status).toBe(400)
  })

  it('lists open times for 代约 and 改约, per coach', async () => {
    const h = setup()
    const { coach, lesson, admin, student } = await venue(h)
    const li = secondCoach(h, lesson.id)
    await hoursPut(h, admin, coach.id, [{ weekday: 0, from: '09:00', to: '11:00' }])
    await hoursPut(h, admin, li.id, [{ weekday: 0, from: '10:00', to: '11:00' }])
    const all = (
      await h.call(
        'GET',
        `/admin/open-times?date=${SUN}&lessonTypeId=${lesson.id}`,
        undefined,
        admin,
      )
    ).json
    expect(
      all.map((t: { coachId: number; startsAt: string }) => [t.coachId, hhmm(t.startsAt)]),
    ).toEqual([
      [coach.id, '09:00'],
      [coach.id, '09:30'],
      [coach.id, '10:00'],
      [li.id, '10:00'],
    ])
    const id = (await book(h, student, coach.id, at(SUN, '09:30'), lesson.id)).json.bookingId
    const moving = (
      await h.call(
        'GET',
        `/admin/open-times?date=${SUN}&moving=${id}&coachId=${coach.id}`,
        undefined,
        admin,
      )
    ).json
    expect(moving.map((t: { startsAt: string }) => hhmm(t.startsAt))).toEqual([
      '09:00',
      '09:30',
      '10:00',
    ])
    const others = (
      await h.call(
        'GET',
        `/admin/open-times?date=${SUN}&lessonTypeId=${lesson.id}`,
        undefined,
        admin,
      )
    ).json
    expect(
      others.map((t: { coachId: number; startsAt: string }) => [t.coachId, hhmm(t.startsAt)]),
    ).toEqual([[li.id, '10:00']])
    expect((await h.call('GET', `/admin/open-times?date=${SUN}`, undefined, admin)).status).toBe(
      400,
    )
    expect(
      (await h.call('GET', `/admin/open-times?date=${SUN}&moving=999`, undefined, admin)).status,
    ).toBe(404)
  })

  it('keeps private lesson rows out of the session tools', async () => {
    const h = setup()
    const { coach, lesson, admin, student } = await venue(h)
    await hoursPut(h, admin, coach.id, [{ weekday: 0, from: '09:00', to: '12:00' }])
    await book(h, student, coach.id, at(SUN, '10:00'), lesson.id)
    const row = h.db.select().from(slots).get()
    const patch = await h.call('PATCH', `/admin/slots/${row?.id}`, { open: false }, admin)
    expect([patch.status, patch.json.error.code]).toEqual([409, 'not_group'])
    const del = await h.call('DELETE', `/admin/slots/${row?.id}`, undefined, admin)
    expect([del.status, del.json.error.code]).toEqual([409, 'not_group'])
  })
})

describe('a busy venue', () => {
  it('works out times for many coaches and lessons quickly', async () => {
    const h = setup()
    const { lesson, admin, student } = await venue(h)
    h.settings((s) => {
      s.booking.tables = 20
    })
    const ids: number[] = []
    for (let i = 0; i < 30; i++) {
      const c = i === 0 ? 1 : secondCoach(h, lesson.id, `教练${i}`).id
      ids.push(c)
      h.hours(
        c,
        [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: '08:00', to: '22:00' })),
      )
    }
    // 600 lessons over two weeks, straight into the table.
    const { slots: slotTable, bookings: bookingTable } = await import('./db/schema')
    for (let i = 0; i < 600; i++) {
      const coachId = ids[i % ids.length] as number
      const date = `2026-10-${String(24 + Math.floor(i / 120)).padStart(2, '0')}`
      const startsAt = venueInstant(date, 8 * 60 + ((Math.floor(i / 30) % 4) * 2 + 1) * 60)
      const endsAt = new Date(startsAt.getTime() + 3_600_000)
      const slot = h.db.insert(slotTable).values({ coachId, startsAt, endsAt }).returning().get()
      h.db
        .insert(bookingTable)
        .values({
          slotId: slot.id,
          studentId: 1,
          lessonTypeId: lesson.id,
          startsAt,
          endsAt,
          status: 'confirmed',
          paidWith: 'order',
          price: 20000,
          seat: 1,
        })
        .run()
    }
    const time = async (path: string, token: string) => {
      const start = performance.now()
      const res = await h.call('GET', path, undefined, token)
      expect(res.status).toBe(200)
      return performance.now() - start
    }
    expect(await time(`/slots?date=${SUN}&lessonTypeId=${lesson.id}`, student)).toBeLessThan(500)
    expect(await time(`/slots/open-days?lessonTypeId=${lesson.id}`, student)).toBeLessThan(2000)
    expect(await time(`/admin/schedule/day?date=${SUN}`, admin)).toBeLessThan(500)
    expect(
      await time(`/admin/open-times?date=${SUN}&lessonTypeId=${lesson.id}`, admin),
    ).toBeLessThan(500)
  }, 30_000)
})

describe('lessons left to sort out', () => {
  const conflicts = async (h: Harness, admin: string) =>
    (await h.call('GET', '/admin/schedule/conflicts', undefined, admin)).json as {
      bookingId: number | null
      reason: string
    }[]

  it('lists the lessons of a 加班 that is removed, from the venue and from the coach', async () => {
    const h = setup()
    const { coach, lesson, admin, student } = await venue(h)
    const extra = await exception(h, admin, coach.id, 'extra', at(SUN, '10:00'), at(SUN, '12:00'))
    const booked = await book(h, student, coach.id, at(SUN, '10:00'), lesson.id)
    expect(booked.status).toBe(201)
    const path = `/admin/coaches/${coach.id}/exceptions/${extra.json.id}`
    const removed = await h.call('DELETE', path, undefined, admin)
    expect(removed.status).toBe(200)
    expect(removed.json.conflicts).toEqual([
      expect.objectContaining({
        bookingId: booked.json.bookingId,
        startsAt: at(SUN, '10:00'),
        reason: 'outside',
      }),
    ])
    // A repeat removes nothing more and has nothing new to report.
    expect((await h.call('DELETE', path, undefined, admin)).json.conflicts).toEqual([])
    expect(await conflicts(h, admin)).toEqual([
      expect.objectContaining({ bookingId: booked.json.bookingId, reason: 'outside' }),
    ])
    expect(h.db.select().from(bookings).get()?.status).toBe('confirmed')

    // The coach removing their own 加班 hears of the lessons in that one only.
    const token = await coachToken(h, admin, coach.id)
    const own = await h.call(
      'POST',
      '/coach/exceptions',
      { kind: 'extra', startsAt: at(MON, '10:00'), endsAt: at(MON, '11:00') },
      token,
    )
    const other = await h.student('b')
    const second = await book(h, other, coach.id, at(MON, '10:00'), lesson.id)
    const gone = await h.call('DELETE', `/coach/exceptions/${own.json.id}`, undefined, token)
    expect(gone.status).toBe(200)
    expect(gone.json.conflicts.map((c: { bookingId: number }) => c.bookingId)).toEqual([
      second.json.bookingId,
    ])
    // Removing 请假 leaves nothing new to report.
    const leave = await exception(h, admin, coach.id, 'off', at(MON, '14:00'), at(MON, '15:00'))
    const back = await h.call(
      'DELETE',
      `/admin/coaches/${coach.id}/exceptions/${leave.json.id}`,
      undefined,
      admin,
    )
    expect(back.json.conflicts).toEqual([])
  })

  it('lists lessons a coach left outside their own hours, but not ones the venue agreed', async () => {
    const h = setup()
    const { coach, lesson, admin, student } = await venue(h)
    await hoursPut(h, admin, coach.id, [{ weekday: 0, from: '09:00', to: '13:00' }])
    const inside = await book(h, student, coach.id, at(SUN, '11:00'), lesson.id)
    // The desk books 18:00 outside 排班, agreed with the coach, and 09:00 inside it.
    const desk = (body: Record<string, unknown>) =>
      h.call(
        'POST',
        '/admin/bookings',
        {
          studentId: 1,
          payWith: 'offline',
          amount: 20000,
          method: 'cash',
          lessonTypeId: lesson.id,
          ...body,
        },
        admin,
      )
    const agreed = await desk({ coachId: coach.id, startsAt: at(SUN, '18:00'), anyTime: true })
    expect(agreed.status).toBe(201)
    const deskInside = await desk({ coachId: coach.id, startsAt: at(SUN, '09:00'), anyTime: true })
    expect(deskInside.status).toBe(201)
    expect(await conflicts(h, admin)).toEqual([])

    // The coach cuts Sunday to 09:00-10:00 in the mini program: the venue sees 11:00.
    const token = await coachToken(h, admin, coach.id)
    const sunday = (from: string, to: string) =>
      h.call(
        'PUT',
        '/coach/hours',
        { hours: [{ weekday: 0, startMinute: minutes(from), endMinute: minutes(to) }] },
        token,
      )
    const cut = await sunday('09:00', '10:00')
    expect(cut.json.conflicts.map((c: { bookingId: number }) => c.bookingId)).toEqual([
      inside.json.bookingId,
    ])
    expect(await conflicts(h, admin)).toEqual([
      expect.objectContaining({ bookingId: inside.json.bookingId, reason: 'outside' }),
    ])

    // Moved by the venue outside 排班 on purpose, it leaves the list; moved back into 排班 by a
    // plain move, it is watched again.
    const move = (startsAt: string, anyTime: boolean) =>
      h.call(
        'POST',
        `/admin/bookings/${inside.json.bookingId}/move`,
        { coachId: coach.id, startsAt, anyTime },
        admin,
      )
    expect((await move(at(SUN, '15:00'), true)).status).toBe(204)
    expect(await conflicts(h, admin)).toEqual([])
    await sunday('09:00', '18:00')
    expect((await move(at(SUN, '16:00'), false)).status).toBe(204)
    await sunday('09:00', '10:00')
    expect(await conflicts(h, admin)).toEqual([
      expect.objectContaining({ bookingId: inside.json.bookingId, reason: 'outside' }),
    ])
  })

  it('says why: 请假, 闭馆 or a coach who stopped', async () => {
    const h = setup()
    const { coach, lesson, admin, student } = await venue(h)
    const li = secondCoach(h, lesson.id)
    for (const id of [coach.id, li.id]) {
      await hoursPut(h, admin, id, [{ weekday: 0, from: '09:00', to: '18:00' }])
    }
    const other = await h.student('b')
    const a = await book(h, student, coach.id, at(SUN, '10:00'), lesson.id)
    const b = await book(h, student, coach.id, at(SUN, '14:00'), lesson.id)
    const c = await book(h, other, li.id, at(SUN, '16:00'), lesson.id)
    await exception(h, admin, coach.id, 'off', at(SUN, '10:00'), at(SUN, '11:00'))
    await h.call(
      'POST',
      '/admin/closures',
      { startsAt: at(SUN, '14:00'), endsAt: at(SUN, '15:00') },
      admin,
    )
    h.db.update(coaches).set({ active: false }).where(eq(coaches.id, li.id)).run()
    expect((await conflicts(h, admin)).map((x) => [x.bookingId, x.reason])).toEqual([
      [a.json.bookingId, 'off'],
      [b.json.bookingId, 'closed'],
      [c.json.bookingId, 'inactive'],
    ])
  })
})

describe('the buffer over midnight', () => {
  it('keeps clear of a lesson ending at 24:00 the day before, and one at 00:00 the day after', async () => {
    const h = setup()
    const { coach, lesson, admin, student } = await venue(h)
    const other = await h.student('b')
    h.settings((s) => {
      s.booking.bufferMinutes = 30
    })
    await hoursPut(h, admin, coach.id, [
      { weekday: 6, from: '22:00', to: '24:00' },
      { weekday: 0, from: '00:00', to: '02:00' },
    ])
    const SAT = '2026-10-24'
    const first = await book(h, student, coach.id, at(SAT, '23:00'), lesson.id)
    expect(first.status).toBe(201)
    expect(await times(h, other, SUN, lesson.id)).toEqual(['00:30', '01:00'])
    const early = await book(h, other, coach.id, at(SUN, '00:00'), lesson.id)
    expect([early.status, early.json.error.code]).toEqual([409, 'slot_taken'])

    // The other way round: a lesson at 00:00 keeps the evening before clear.
    await h.call('POST', `/bookings/${first.json.bookingId}/cancel`, {}, student)
    expect((await book(h, other, coach.id, at(SUN, '00:00'), lesson.id)).status).toBe(201)
    expect(await times(h, student, SAT, lesson.id)).toEqual(['22:00', '22:30'])
    const late = await book(h, student, coach.id, at(SAT, '23:00'), lesson.id)
    expect([late.status, late.json.error.code]).toEqual([409, 'slot_taken'])
  })
})

describe('a coach moving a lesson far ahead', () => {
  it("keeps to the lesson's booking window; the venue may go further", async () => {
    const h = setup()
    const { coach, lesson, admin, student } = await venue(h)
    await hoursPut(h, admin, coach.id, [{ weekday: 0, from: '09:00', to: '12:00' }])
    // 14 days from Friday 10-23 run to 11-06; 11-10 is past them.
    const FAR = '2026-11-10'
    await exception(h, admin, coach.id, 'extra', at(FAR, '10:00'), at(FAR, '12:00'))
    const id = (await book(h, student, coach.id, at(SUN, '10:00'), lesson.id)).json.bookingId
    const token = await coachToken(h, admin, coach.id)
    const farTimes = async () =>
      (
        await h.call(
          'GET',
          `/coach/move-times?bookingId=${id}&from=${FAR}&to=${FAR}`,
          undefined,
          token,
        )
      ).json
    expect(await farTimes()).toEqual([])
    const moved = await h.call(
      'POST',
      `/coach/lessons/${id}/move`,
      { coachId: coach.id, startsAt: at(FAR, '10:00') },
      token,
    )
    expect([moved.status, moved.json.error.code]).toEqual([409, 'too_far'])
    // A lesson booked further ahead lets the coach go as far.
    h.db
      .update(lessonTypes)
      .set({ rules: { advanceDays: 24 } })
      .where(eq(lessonTypes.id, lesson.id))
      .run()
    expect(await farTimes()).toHaveLength(3)
    h.db.update(lessonTypes).set({ rules: {} }).where(eq(lessonTypes.id, lesson.id)).run()
    const byVenue = await h.call(
      'POST',
      `/admin/bookings/${id}/move`,
      { coachId: coach.id, startsAt: at(FAR, '10:00') },
      admin,
    )
    expect(byVenue.status).toBe(204)
  })
})

describe('lessons placed by the venue before the flag was kept', () => {
  it('counts as agreed only those outside 排班 now, once', async () => {
    const h = setup()
    const { coach, lesson, admin, student } = await venue(h)
    await hoursPut(h, admin, coach.id, [{ weekday: 0, from: '09:00', to: '13:00' }])
    const desk = (startsAt: string, anyTime: boolean) =>
      h.call(
        'POST',
        '/admin/bookings',
        {
          studentId: 1,
          payWith: 'offline',
          amount: 20000,
          method: 'cash',
          lessonTypeId: lesson.id,
          coachId: coach.id,
          startsAt,
          anyTime,
        },
        admin,
      )
    const inside = (await desk(at(SUN, '10:00'), false)).json.bookingId as number
    const outside = (await desk(at(SUN, '18:00'), true)).json.bookingId as number
    const own = (await book(h, student, coach.id, at(SUN, '12:00'), lesson.id)).json
      .bookingId as number
    // As migration 0023 leaves them.
    h.db
      .update(bookings)
      .set({ outsideAgreed: sql`2` as unknown as boolean })
      .where(inArray(bookings.id, [inside, outside]))
      .run()
    const flags = () =>
      h.db
        .select({ id: bookings.id, agreed: sql<number>`${bookings.outsideAgreed}` })
        .from(bookings)
        .orderBy(bookings.id)
        .all()
    settleOutsideAgreed(h.db)
    const settled = [
      { id: inside, agreed: 0 },
      { id: outside, agreed: 1 },
      { id: own, agreed: 0 },
    ]
    expect(flags()).toEqual(settled)
    // Run again, say on the next start, it changes nothing.
    settleOutsideAgreed(h.db)
    expect(flags()).toEqual(settled)
    // The desk's lesson inside 排班 is watched like any other.
    await hoursPut(h, admin, coach.id, [{ weekday: 0, from: '09:00', to: '10:00' }])
    const listed = (await h.call('GET', '/admin/schedule/conflicts', undefined, admin)).json
    expect(listed.map((c: { bookingId: number }) => c.bookingId)).toEqual([inside, own])
  })
})

describe('keeping a lesson outside 排班', () => {
  const keepAt = (h: Harness, admin: string, id: number, coachId: number, startsAt: string) =>
    h.call('POST', `/admin/bookings/${id}/keep-outside`, { coachId, startsAt }, admin)
  const keptLog = async (h: Harness, admin: string) => {
    const log = (await h.call('GET', '/admin/actions', undefined, admin)).json
    return ((log.items ?? log) as { summary: string }[]).filter((e) =>
      e.summary.includes('已与教练确认在排班外上课'),
    )
  }

  it('lets the desk confirm it with the coach where it is, once and logged', async () => {
    const h = setup()
    const { coach, lesson, admin, student } = await venue(h)
    const other = await h.student('b')
    await hoursPut(h, admin, coach.id, [{ weekday: 0, from: '09:00', to: '13:00' }])
    const a = (await book(h, student, coach.id, at(SUN, '11:00'), lesson.id)).json.bookingId
    const b = (await book(h, other, coach.id, at(SUN, '12:00'), lesson.id)).json.bookingId
    await hoursPut(h, admin, coach.id, [{ weekday: 0, from: '09:00', to: '10:00' }])
    const listed = async () =>
      (await h.call('GET', '/admin/schedule/conflicts', undefined, admin)).json.map(
        (c: { bookingId: number }) => c.bookingId,
      )
    expect(await listed()).toEqual([a, b])
    // A move to the time it has, even outside 排班, changes nothing.
    const same = { coachId: coach.id, startsAt: at(SUN, '11:00'), anyTime: true }
    expect((await h.call('POST', `/admin/bookings/${a}/move`, same, admin)).status).toBe(204)
    expect(await listed()).toEqual([a, b])
    const notices = h.db.select().from(studentNotices).all().length
    expect((await keepAt(h, admin, a, coach.id, at(SUN, '11:00'))).status).toBe(204)
    expect(await listed()).toEqual([b])
    expect((await keepAt(h, admin, a, coach.id, at(SUN, '11:00'))).status).toBe(204)
    expect(await keptLog(h, admin)).toHaveLength(1)
    const kept = h.db.select().from(bookings).where(eq(bookings.id, a)).get()
    expect([kept?.startsAt.toISOString(), kept?.outsideAgreed]).toEqual([at(SUN, '11:00'), true])
    // Kept in place: no move recorded and no 改约 message for the student.
    expect(h.db.select().from(bookingMoves).all()).toHaveLength(0)
    expect(h.db.select().from(studentNotices).all()).toHaveLength(notices)
    // Not over the coach's 请假.
    await exception(h, admin, coach.id, 'off', at(SUN, '12:00'), at(SUN, '13:00'))
    const off = await keepAt(h, admin, b, coach.id, at(SUN, '12:00'))
    expect([off.status, off.json.error.code]).toEqual([409, 'coach_off'])
  })

  it('never moves a lesson back that another desk moved since the list was loaded', async () => {
    const h = setup()
    const { coach, lesson, admin, student } = await venue(h)
    await hoursPut(h, admin, coach.id, [{ weekday: 0, from: '09:00', to: '18:00' }])
    const id = (await book(h, student, coach.id, at(SUN, '10:00'), lesson.id)).json.bookingId
    await hoursPut(h, admin, coach.id, [{ weekday: 0, from: '13:00', to: '18:00' }])
    const [c] = (await h.call('GET', '/admin/schedule/conflicts', undefined, admin)).json
    expect(c).toMatchObject({ bookingId: id, coachId: coach.id, startsAt: at(SUN, '10:00') })
    // Another desk moves it into 排班 at 14:00.
    const move = { coachId: coach.id, startsAt: at(SUN, '14:00') }
    expect((await h.call('POST', `/admin/bookings/${id}/move`, move, admin)).status).toBe(204)
    const notices = h.db.select().from(studentNotices).all().length
    // The first desk, from the old list, confirms 10:00 with the coach.
    const stale = await keepAt(h, admin, id, c.coachId, c.startsAt)
    expect([stale.status, stale.json.error.code]).toEqual([409, 'booking_changed'])
    const now = h.db.select().from(bookings).where(eq(bookings.id, id)).get()
    expect([now?.startsAt.toISOString(), now?.outsideAgreed]).toEqual([at(SUN, '14:00'), false])
    expect(h.db.select().from(bookingMoves).all()).toHaveLength(1)
    expect(h.db.select().from(studentNotices).all()).toHaveLength(notices)
    expect(await keptLog(h, admin)).toHaveLength(0)
    // A coach other than the one shown is refused the same way.
    const other = await keepAt(h, admin, id, coach.id + 99, at(SUN, '14:00'))
    expect(other.json.error?.code).toBe('booking_changed')
    // Back inside 排班 at the time shown: nothing to keep, and nothing logged.
    expect((await keepAt(h, admin, id, coach.id, at(SUN, '14:00'))).status).toBe(204)
    expect(await keptLog(h, admin)).toHaveLength(0)
    expect(h.db.select().from(bookings).where(eq(bookings.id, id)).get()?.outsideAgreed).toBe(false)
  })

  it('tells the desk a lesson still to pay cannot be kept yet', async () => {
    const h = setup()
    const { coach, lesson, admin, student } = await venue(h)
    await hoursPut(h, admin, coach.id, [{ weekday: 0, from: '09:00', to: '18:00' }])
    const res = await book(h, student, coach.id, at(SUN, '10:00'), lesson.id, { pay: false })
    const id = res.json.bookingId as number
    await hoursPut(h, admin, coach.id, [{ weekday: 0, from: '13:00', to: '18:00' }])
    const [c] = (await h.call('GET', '/admin/schedule/conflicts', undefined, admin)).json
    expect(c).toMatchObject({ bookingId: id, startsAt: at(SUN, '10:00') })
    const kept = await keepAt(h, admin, id, c.coachId, c.startsAt)
    expect([kept.status, kept.json.error.code]).toEqual([409, 'not_confirmed'])
    expect(kept.json.error.message).toBe('学员尚未付款，付款后才能标为已与教练确认')
    expect(h.db.select().from(bookings).where(eq(bookings.id, id)).get()?.outsideAgreed).toBe(false)
    expect(await keptLog(h, admin)).toHaveLength(0)
    // Once paid, it can be.
    await h.fakePay(res.json.orderId)
    expect((await keepAt(h, admin, id, c.coachId, c.startsAt)).status).toBe(204)
    expect(h.db.select().from(bookings).where(eq(bookings.id, id)).get()?.outsideAgreed).toBe(true)
  })

  it('refuses a desk move made from a stale view of the lesson', async () => {
    const h = setup()
    const { coach, lesson, admin, student } = await venue(h)
    await hoursPut(h, admin, coach.id, [{ weekday: 0, from: '09:00', to: '18:00' }])
    const id = (await book(h, student, coach.id, at(SUN, '10:00'), lesson.id)).json.bookingId
    const shown = { coachId: coach.id, startsAt: at(SUN, '10:00') }
    const moveTo = (time: string) =>
      h.call(
        'POST',
        `/admin/bookings/${id}/move`,
        { coachId: coach.id, startsAt: at(SUN, time), from: shown },
        admin,
      )
    expect((await moveTo('14:00')).status).toBe(204)
    // The same request again is the move that already happened.
    expect((await moveTo('14:00')).status).toBe(204)
    const stale = await moveTo('15:00')
    expect([stale.status, stale.json.error.code]).toEqual([409, 'booking_changed'])
    expect(
      h.db.select().from(bookings).where(eq(bookings.id, id)).get()?.startsAt.toISOString(),
    ).toBe(at(SUN, '14:00'))
  })
})
