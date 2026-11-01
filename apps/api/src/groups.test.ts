import { venueInstant } from '@rs/shared'
import { and, eq, inArray } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
  bookings,
  coaches,
  coachLessonTypes,
  lessonFeedback,
  lessonTypes,
  orders,
  packageProducts,
  packages,
  refunds,
  slots,
  studentNotices,
  students as studentRows,
} from './db/schema'
import { notifyCoaches } from './services/coach-notices'
import { applyPayment } from './services/orders'
import { cancelUnderfilledSessions, UNDERFILLED_REASON } from './services/sessions'
import { notifyStudents } from './services/student-notices'
import { type Harness, setup } from './test/harness'
import type { Notifier } from './wx-notify'

// The clock starts at 2026-10-23 10:00 venue time.

/** One coach who teaches a private lesson and a 60-minute group class for 4 at ¥80. */
function seedGroup(h: Harness, group: Partial<typeof lessonTypes.$inferInsert> = {}) {
  const seeded = h.seed()
  const kids = h.db
    .insert(lessonTypes)
    .values({ name: '少儿小班课', durationMinutes: 60, price: 8000, capacity: 4, ...group })
    .returning()
    .get()
  h.db.insert(coachLessonTypes).values({ coachId: seeded.coach.id, lessonTypeId: kids.id }).run()
  return { ...seeded, kids }
}

async function schedule(
  h: Harness,
  admin: string,
  input: { lessonTypeId: number; coachId: number; date?: string; hour?: number; capacity?: number },
) {
  const date = input.date ?? '2026-10-26'
  const hour = input.hour ?? 10
  return h.call(
    'POST',
    '/admin/sessions',
    {
      lessonTypeId: input.lessonTypeId,
      capacity: input.capacity ?? 4,
      sessions: [
        {
          coachId: input.coachId,
          startsAt: venueInstant(date, hour * 60).toISOString(),
          endsAt: venueInstant(date, hour * 60 + 60).toISOString(),
        },
      ],
    },
    admin,
  )
}

async function session(
  h: Harness,
  admin: string,
  lessonTypeId: number,
  coachId: number,
  hour = 10,
) {
  const res = await schedule(h, admin, { lessonTypeId, coachId, hour })
  expect(res.status).toBe(201)
  return res.json.ids[0] as number
}

function book(h: Harness, token: string, slotId: number, lessonTypeId: number, payWith?: string) {
  return h.call('POST', '/bookings', { slotId, lessonTypeId, payWith }, token)
}

/** Logs students in, one token per name. */
async function students<N extends string[]>(h: Harness, ...names: N) {
  return (await Promise.all(names.map((n) => h.student(n)))) as { [K in keyof N]: string }
}

/** Books and pays a seat. */
async function seat(h: Harness, token: string, slotId: number, lessonTypeId: number) {
  const res = await book(h, token, slotId, lessonTypeId)
  expect(res.status).toBe(201)
  if (res.json.orderId) await h.fakePay(res.json.orderId)
  return res.json.bookingId as number
}

const live = (h: Harness, slotId: number) =>
  h.db
    .select()
    .from(bookings)
    .where(
      and(eq(bookings.slotId, slotId), inArray(bookings.status, ['pending_payment', 'confirmed'])),
    )
    .all()

describe('group class lesson types', () => {
  it('saves capacity and a minimum headcount, and refuses odd ones', async () => {
    const h = setup()
    const admin = await h.admin()
    const base = { name: '小班课', durationMinutes: 90, price: 8000 }
    const ok = await h.call(
      'POST',
      '/admin/lesson-types',
      { ...base, capacity: 6, minStudents: 3 },
      admin,
    )
    expect(ok.status).toBe(201)
    expect(ok.json).toMatchObject({ capacity: 6, minStudents: 3 })
    for (const [body, message] of [
      [{ capacity: 6, minStudents: 7 }, '最低开班人数需在 2 到人数上限之间'],
      [{ capacity: 1, minStudents: 2 }, '一对一课程不设开班人数'],
      [{ capacity: 6, isTrial: true }, '体验课不能设为小班课'],
      [{ capacity: 31 }, '人数上限超出允许范围'],
      [{ capacity: 0 }, '人数上限超出允许范围'],
    ] as const) {
      const res = await h.call('POST', '/admin/lesson-types', { ...base, ...body }, admin)
      expect(res.status).toBe(400)
      expect(res.json.error.message).toBe(message)
    }
  })

  it('keeps a lesson type private or group once it has sessions or bookings', async () => {
    const h = setup()
    const { coach, lesson, kids } = seedGroup(h)
    const admin = await h.admin()
    const put = (t: typeof lessonTypes.$inferSelect, capacity: number) =>
      h.call(
        'PUT',
        `/admin/lesson-types/${t.id}`,
        {
          name: t.name,
          durationMinutes: t.durationMinutes,
          price: t.price,
          capacity,
        },
        admin,
      )
    // Nothing scheduled yet: free to change.
    expect((await put(kids, 6)).status).toBe(200)
    await session(h, admin, kids.id, coach.id)
    expect((await put(kids, 8)).status).toBe(200)
    const locked = await put(kids, 1)
    expect(locked.status).toBe(409)
    expect(locked.json.error.code).toBe('capacity_locked')

    const t = await h.student('a')
    await seat(h, t, h.slot(coach.id, '2026-10-27').id, lesson.id)
    expect((await put(lesson, 4)).json.error?.code).toBe('capacity_locked')
  })

  it('keeps the length of a group class that has sessions, even unbooked ones', async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h)
    const admin = await h.admin()
    await session(h, admin, kids.id, coach.id)
    const res = await h.call(
      'PUT',
      `/admin/lesson-types/${kids.id}`,
      { name: kids.name, durationMinutes: 90, price: kids.price, capacity: 4 },
      admin,
    )
    expect(res.status).toBe(409)
    expect(res.json.error.code).toBe('duration_locked')
  })

  it('shows capacity in the catalog', async () => {
    const h = setup()
    const { kids } = seedGroup(h)
    const t = await h.student('a')
    const catalog = (await h.call('GET', '/catalog', undefined, t)).json
    expect(catalog.lessonTypes.find((l: { id: number }) => l.id === kids.id)).toMatchObject({
      capacity: 4,
    })
  })
})

describe('scheduling sessions', () => {
  it('keeps private lessons off its time, and gives the time back once it is deleted', async () => {
    const h = setup()
    const { coach, lesson, kids } = seedGroup(h)
    const admin = await h.admin()
    const privateSlot = h.slot(coach.id, '2026-10-26', 10)
    const id = await session(h, admin, kids.id, coach.id)
    expect(h.db.select().from(slots).where(eq(slots.id, id)).get()).toMatchObject({
      lessonTypeId: kids.id,
      capacity: 4,
      open: true,
    })
    const t = await h.student('a')
    const times = async () =>
      (await h.call('GET', `/slots?date=2026-10-26&lessonTypeId=${lesson.id}`, undefined, t)).json
    expect(await times()).toEqual([])
    expect((await book(h, t, privateSlot.id, lesson.id)).json.error.code).toBe('slot_taken')
    // A private lesson's time is not the venue's to open or delete; 排班 decides.
    const reopen = await h.call('PATCH', `/admin/slots/${privateSlot.id}`, { open: true }, admin)
    expect(reopen.json.error.code).toBe('not_group')
    // Calling the session off frees the coach as well.
    expect((await h.call('DELETE', `/admin/slots/${id}`, undefined, admin)).status).toBe(204)
    expect(await times()).toEqual([expect.objectContaining({ id: null, available: true })])
  })

  it('refuses a session off the 5-minute marks', async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h)
    const admin = await h.admin()
    for (const [startsAt, endsAt] of [
      ['2026-10-26T01:02:30.500Z', '2026-10-26T02:02:30.500Z'],
      ['2026-10-26T01:03:00.000Z', '2026-10-26T02:03:00.000Z'],
    ]) {
      const res = await h.call(
        'POST',
        '/admin/sessions',
        { lessonTypeId: kids.id, capacity: 4, sessions: [{ coachId: coach.id, startsAt, endsAt }] },
        admin,
      )
      expect(res.status).toBe(400)
      expect(res.json.error).toEqual({ code: 'invalid_time', message: '时间需为 5 分钟的整数倍' })
    }
    expect(h.db.select().from(slots).all()).toEqual([])
  })

  it('refuses a session in 请假 or 闭馆, outside weekly hours is fine', async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h)
    const admin = await h.admin()
    await h.call(
      'POST',
      `/admin/coaches/${coach.id}/exceptions`,
      {
        kind: 'off',
        startsAt: venueInstant('2026-10-26', 9 * 60).toISOString(),
        endsAt: venueInstant('2026-10-26', 11 * 60).toISOString(),
      },
      admin,
    )
    const leave = await schedule(h, admin, { lessonTypeId: kids.id, coachId: coach.id })
    expect(leave.json.error).toMatchObject({
      code: 'coach_off',
      message: '10月26日 10:00 王教练请假',
    })
    await h.call(
      'POST',
      '/admin/closures',
      {
        startsAt: venueInstant('2026-10-27', 0).toISOString(),
        endsAt: venueInstant('2026-10-28', 0).toISOString(),
        note: '设备检修',
      },
      admin,
    )
    const closed = await schedule(h, admin, {
      lessonTypeId: kids.id,
      coachId: coach.id,
      date: '2026-10-27',
    })
    expect(closed.json.error.message).toBe('10月27日 10:00 场馆闭馆')
    const fine = await schedule(h, admin, {
      lessonTypeId: kids.id,
      coachId: coach.id,
      date: '2026-10-28',
    })
    expect(fine.status).toBe(201)
  })

  it('refuses fewer seats than the class needs to go ahead', async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h, { minStudents: 3 })
    const admin = await h.admin()
    const res = await schedule(h, admin, { lessonTypeId: kids.id, coachId: coach.id, capacity: 2 })
    expect(res.status).toBe(400)
    expect(res.json.error.message).toBe('人数需在 3 到 4 之间')
    const id = await session(h, admin, kids.id, coach.id)
    const patch = await h.call('PATCH', `/admin/slots/${id}`, { capacity: 2 }, admin)
    expect(patch.status).toBe(400)
    expect(patch.json.error.code).toBe('invalid_capacity')
  })

  it("keeps seats within the class's 上课人数 and schedules active classes only", async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h)
    const admin = await h.admin()
    const over = await schedule(h, admin, { lessonTypeId: kids.id, coachId: coach.id, capacity: 5 })
    expect([over.status, over.json.error.message]).toEqual([400, '人数需在 2 到 4 之间'])
    const id = await session(h, admin, kids.id, coach.id)
    const raised = await h.call('PATCH', `/admin/slots/${id}`, { capacity: 5 }, admin)
    expect([raised.status, raised.json.error.code]).toEqual([400, 'invalid_capacity'])
    expect(h.db.select().from(slots).where(eq(slots.id, id)).get()?.capacity).toBe(4)
    h.db.update(lessonTypes).set({ active: false }).where(eq(lessonTypes.id, kids.id)).run()
    const off = await schedule(h, admin, { lessonTypeId: kids.id, coachId: coach.id, hour: 14 })
    expect([off.status, off.json.error.code]).toEqual([404, 'not_found'])
    // A session already on can still change its seats.
    expect((await h.call('PATCH', `/admin/slots/${id}`, { capacity: 3 }, admin)).status).toBe(204)
    expect((await h.call('PATCH', `/admin/slots/${id}`, { capacity: 4 }, admin)).status).toBe(204)
  })

  it('refuses a seat change on a session called off or over', async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h)
    const admin = await h.admin()
    const id = await session(h, admin, kids.id, coach.id)
    const ended = h.db.select().from(slots).where(eq(slots.id, id)).get()?.endsAt
    const before = h.clock.now
    h.clock.now = new Date((ended?.getTime() ?? 0) + 60_000)
    // Days on, so signed in again.
    const later = await h.admin()
    const late = await h.call('PATCH', `/admin/slots/${id}`, { capacity: 3 }, later)
    expect([late.status, late.json.error.code]).toEqual([409, 'ended'])
    h.clock.now = before
    await h.call('POST', `/admin/slots/${id}/cancel`, { reason: '天气原因' }, admin)
    const stale = await h.call('PATCH', `/admin/slots/${id}`, { capacity: 3 }, admin)
    expect([stale.status, stale.json.error.code]).toEqual([409, 'session_cancelled'])
    expect(h.db.select().from(slots).where(eq(slots.id, id)).get()?.capacity).toBe(4)
    // The same number as now is no change, so a resent dialog still closes cleanly.
    expect((await h.call('PATCH', `/admin/slots/${id}`, { capacity: 4 }, admin)).status).toBe(204)
  })

  it('keeps a session bigger than its class has since become editable', async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h, { capacity: 6 })
    const admin = await h.admin()
    const made = await schedule(h, admin, { lessonTypeId: kids.id, coachId: coach.id, capacity: 6 })
    const id = made.json.ids[0] as number
    // The class is made smaller; the session keeps its 6 seats.
    const put = await h.call(
      'PUT',
      `/admin/lesson-types/${kids.id}`,
      { name: kids.name, durationMinutes: 60, price: kids.price, capacity: 4 },
      admin,
    )
    expect(put.status).toBe(200)
    expect(h.db.select().from(slots).where(eq(slots.id, id)).get()?.capacity).toBe(6)
    const [a, b, c, d, e] = await students(h, 'a', 'b', 'c', 'd', 'e')
    for (const t of [a, b, c, d, e]) await seat(h, t, id, kids.id)
    // Up to the 6 it has, never below the 5 booked; not above.
    const patch = (capacity: number) => h.call('PATCH', `/admin/slots/${id}`, { capacity }, admin)
    expect((await patch(7)).json.error.message).toBe('人数需在 2 到 6 之间')
    expect((await patch(4)).json.error.code).toBe('capacity_below_booked')
    expect((await patch(6)).status).toBe(204)
    expect((await patch(5)).status).toBe(204)
    // Lowered to the 5 booked, it goes back no further than the class's 4 allow, which is 5.
    expect((await patch(6)).json.error.message).toBe('人数需在 2 到 5 之间')
  })

  it('refuses a time with a booked lesson, another session, a wrong length or coach', async () => {
    const h = setup()
    const { coach, lesson, kids } = seedGroup(h)
    const admin = await h.admin()
    const t = await h.student('a')
    await seat(h, t, h.slot(coach.id, '2026-10-26', 9).id, lesson.id)
    const booked = await schedule(h, admin, { lessonTypeId: kids.id, coachId: coach.id, hour: 9 })
    expect(booked.status).toBe(409)
    expect(booked.json.error.message).toBe('10月26日 09:00 该教练已有预约')

    await session(h, admin, kids.id, coach.id, 11)
    const twice = await schedule(h, admin, { lessonTypeId: kids.id, coachId: coach.id, hour: 11 })
    expect(twice.json.error.message).toBe('10月26日 11:00 与该教练已有的小班课重叠')

    const wrongLength = await h.call(
      'POST',
      '/admin/sessions',
      {
        lessonTypeId: kids.id,
        capacity: 4,
        sessions: [
          {
            coachId: coach.id,
            startsAt: venueInstant('2026-10-26', 14 * 60).toISOString(),
            endsAt: venueInstant('2026-10-26', 14 * 60 + 90).toISOString(),
          },
        ],
      },
      admin,
    )
    expect(wrongLength.json.error.code).toBe('duration_mismatch')

    const overnight = await h.call(
      'POST',
      '/admin/sessions',
      {
        lessonTypeId: kids.id,
        capacity: 4,
        sessions: [
          {
            coachId: coach.id,
            startsAt: venueInstant('2026-10-26', 23 * 60 + 30).toISOString(),
            endsAt: venueInstant('2026-10-26', 24 * 60 + 30).toISOString(),
          },
        ],
      },
      admin,
    )
    expect(overnight.json.error.message).toBe('10月26日 23:30 开始会上到第二天')

    const other = h.db.insert(coaches).values({ name: '李教练' }).returning().get()
    const notTeaching = await schedule(h, admin, { lessonTypeId: kids.id, coachId: other.id })
    expect(notTeaching.json.error.code).toBe('coach_not_teaching')

    const notGroup = await schedule(h, admin, {
      lessonTypeId: lesson.id,
      coachId: coach.id,
      hour: 15,
    })
    expect(notGroup.json.error.code).toBe('not_group')

    // All or none: a later session that fails leaves no earlier one behind.
    const before = h.db.select().from(slots).all().length
    const mixed = await h.call(
      'POST',
      '/admin/sessions',
      {
        lessonTypeId: kids.id,
        capacity: 4,
        sessions: [16, 11].map((hour) => ({
          coachId: coach.id,
          startsAt: venueInstant('2026-10-26', hour * 60).toISOString(),
          endsAt: venueInstant('2026-10-26', hour * 60 + 60).toISOString(),
        })),
      },
      admin,
    )
    expect(mixed.status).toBe(409)
    expect(h.db.select().from(slots).all()).toHaveLength(before)
  })
})

describe('booking seats', () => {
  it('lists sessions with the seats left, apart from private slots', async () => {
    const h = setup()
    const { coach, lesson, kids } = seedGroup(h)
    const admin = await h.admin()
    const id = await session(h, admin, kids.id, coach.id, 10)
    const privateSlot = h.slot(coach.id, '2026-10-26', 14)
    const t = await h.student('a')
    await seat(h, t, id, kids.id)
    const group = (
      await h.call('GET', `/slots?date=2026-10-26&lessonTypeId=${kids.id}`, undefined, t)
    ).json
    // Not offered again to the student who has a seat, who is told so.
    expect(group).toEqual([
      expect.objectContaining({
        id,
        capacity: 4,
        seatsLeft: 3,
        available: false,
        mine: expect.objectContaining({ status: 'confirmed' }),
      }),
    ])
    const other = await h.student('b')
    const forOther = (
      await h.call('GET', `/slots?date=2026-10-26&lessonTypeId=${kids.id}`, undefined, other)
    ).json
    expect(forOther).toEqual([
      expect.objectContaining({ id, seatsLeft: 3, available: true, mine: null }),
    ])
    const solo = (
      await h.call('GET', `/slots?date=2026-10-26&lessonTypeId=${lesson.id}`, undefined, t)
    ).json
    expect(solo).toEqual([
      expect.objectContaining({
        id: null,
        startsAt: privateSlot.startsAt.toISOString(),
        capacity: 1,
        seatsLeft: 1,
      }),
    ])
  })

  it('lists sessions of classes the student can see only', async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h)
    const inner = h.db
      .insert(lessonTypes)
      .values({ name: '内部小班', durationMinutes: 60, price: 8000, capacity: 4, adminOnly: true })
      .returning()
      .get()
    h.db.insert(coachLessonTypes).values({ coachId: coach.id, lessonTypeId: inner.id }).run()
    const admin = await h.admin()
    const open = await session(h, admin, kids.id, coach.id, 10)
    const hidden = await session(h, admin, inner.id, coach.id, 14)
    const t = await h.student('a')
    const tester = await h.student('b')
    h.db.update(studentRows).set({ tester: true }).where(eq(studentRows.id, 2)).run()
    const ids = async (token: string, q = '') =>
      (await h.call('GET', `/slots?date=2026-10-26${q}`, undefined, token)).json.map(
        (s: { id: number }) => s.id,
      )
    expect(await ids(t)).toEqual([open])
    expect(await ids(tester)).toEqual([open, hidden])
    const asked = await h.call(
      'GET',
      `/slots?date=2026-10-26&lessonTypeId=${inner.id}`,
      undefined,
      t,
    )
    expect([asked.status, asked.json.error.code]).toEqual([404, 'not_found'])
    expect(
      (await h.call('GET', `/slots/open-days?lessonTypeId=${inner.id}`, undefined, t)).json,
    ).toEqual([])
    expect((await h.call('GET', '/slots/open-days', undefined, t)).json).toEqual(['2026-10-26'])

    // A class taken off: its sessions go from the list, but a seat already held can still move.
    const mine = await seat(h, t, open, kids.id)
    const other = await session(h, admin, kids.id, coach.id, 16)
    h.db.update(lessonTypes).set({ active: false }).where(eq(lessonTypes.id, kids.id)).run()
    expect(await ids(t)).toEqual([])
    expect((await h.call('GET', '/slots/open-days', undefined, t)).json).toEqual([])
    expect(await ids(t, `&moving=${mine}`)).toEqual([open, other])
  })

  it('hides sessions of a length the class no longer has', async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h)
    const admin = await h.admin()
    await session(h, admin, kids.id, coach.id, 10)
    // The class now runs 90 minutes; the 60-minute session cannot be booked for it.
    h.db.update(lessonTypes).set({ durationMinutes: 90 }).where(eq(lessonTypes.id, kids.id)).run()
    const t = await h.student('a')
    expect(
      (await h.call('GET', `/slots?date=2026-10-26&lessonTypeId=${kids.id}`, undefined, t)).json,
    ).toEqual([])
  })

  it('gives exactly the seats there are to students racing for them', async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h)
    const admin = await h.admin()
    const id = await session(h, admin, kids.id, coach.id)
    const tokens = await Promise.all(Array.from({ length: 12 }, (_, i) => h.student(`s${i}`)))
    const results = await Promise.all(tokens.map((t) => book(h, t, id, kids.id)))
    expect(results.filter((r) => r.status === 201)).toHaveLength(4)
    for (const r of results.filter((r) => r.status !== 201)) {
      expect(r.status).toBe(409)
      expect(r.json.error).toMatchObject({ code: 'slot_taken', message: '该课已满员' })
    }
    expect(
      live(h, id)
        .map((b) => b.seat)
        .sort(),
    ).toEqual([1, 2, 3, 4])
    const t = await h.student('late')
    const slotsNow = (
      await h.call('GET', `/slots?date=2026-10-26&lessonTypeId=${kids.id}`, undefined, t)
    ).json
    expect(slotsNow[0]).toMatchObject({ seatsLeft: 0, available: false })
  })

  it('treats a double tap as one seat', async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h)
    const admin = await h.admin()
    const id = await session(h, admin, kids.id, coach.id)
    const t = await h.student('a')
    const [a, b] = await Promise.all([book(h, t, id, kids.id), book(h, t, id, kids.id)])
    expect([a.status, b.status]).toEqual([201, 201])
    expect(b.json.bookingId).toBe(a.json.bookingId)
    expect([a.json.existing, b.json.existing].sort()).toEqual([false, true])
    expect(live(h, id)).toHaveLength(1)
  })

  it('refuses two seats for one student and two bookings in one seat at the database', async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h)
    const admin = await h.admin()
    const id = await session(h, admin, kids.id, coach.id)
    const t = await h.student('a')
    await h.student('b')
    await seat(h, t, id, kids.id)
    const row = live(h, id)[0]
    if (!row) throw new Error('no booking')
    expect(() =>
      h.db
        .insert(bookings)
        .values({ ...row, id: undefined, seat: 2 })
        .run(),
    ).toThrow(/UNIQUE/)
    expect(() =>
      h.db
        .insert(bookings)
        .values({ ...row, id: undefined, studentId: 2 })
        .run(),
    ).toThrow(/UNIQUE/)
  })

  it('keeps group classes and private lessons in their own slots', async () => {
    const h = setup()
    const { coach, lesson, kids } = seedGroup(h)
    const admin = await h.admin()
    const id = await session(h, admin, kids.id, coach.id)
    const t = await h.student('a')
    const privateInSession = await book(h, t, id, lesson.id)
    expect(privateInSession.json.error.code).toBe('lesson_type_mismatch')
    const groupInPrivate = await book(h, t, h.slot(coach.id, '2026-10-27').id, kids.id)
    expect(groupInPrivate.json.error.code).toBe('lesson_type_mismatch')
    const quote = await h.call(
      'GET',
      `/bookings/quote?slotId=${id}&lessonTypeId=${lesson.id}`,
      undefined,
      t,
    )
    expect(quote.json.error.code).toBe('lesson_type_mismatch')
  })

  it('pays a seat from a group class package and gives the lesson back on cancel', async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h)
    const admin = await h.admin()
    const product = h.db
      .insert(packageProducts)
      .values({
        name: '小班课 10 次',
        lessonTypeId: kids.id,
        lessonCount: 10,
        price: 70000,
        validityDays: 90,
      })
      .returning()
      .get()
    const t = await h.student('a')
    const bought = await h.call('POST', '/packages/purchase', { productId: product.id }, t)
    await h.fakePay(bought.json.orderId)
    const id = await session(h, admin, kids.id, coach.id)
    const quote = await h.call(
      'GET',
      `/bookings/quote?slotId=${id}&lessonTypeId=${kids.id}`,
      undefined,
      t,
    )
    expect(quote.json.package).toMatchObject({ name: '小班课 10 次', lessonsRemaining: 10 })
    const res = await book(h, t, id, kids.id)
    expect(res.json).toMatchObject({ status: 'confirmed', orderId: null })
    expect(h.db.select().from(packages).get()?.lessonsRemaining).toBe(9)
    const cancel = await h.call('POST', `/bookings/${res.json.bookingId}/cancel`, {}, t)
    expect(cancel.status).toBe(200)
    expect(h.db.select().from(packages).get()?.lessonsRemaining).toBe(10)
  })

  it('frees a seat on cancel for the next student', async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h)
    const admin = await h.admin()
    const id = await session(h, admin, kids.id, coach.id, 10)
    h.db.update(slots).set({ capacity: 2 }).where(eq(slots.id, id)).run()
    const [a, b, c] = await students(h, 'a', 'b', 'c')
    const first = await seat(h, a, id, kids.id)
    await seat(h, b, id, kids.id)
    expect((await book(h, c, id, kids.id)).status).toBe(409)
    await h.call('POST', `/bookings/${first}/cancel`, {}, a)
    expect((await book(h, c, id, kids.id)).status).toBe(201)
    expect(
      live(h, id)
        .map((r) => r.seat)
        .sort(),
    ).toEqual([1, 2])
  })

  it('offers the last seat back to the student whose own hold of it ran out', async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h)
    const admin = await h.admin()
    const id = await session(h, admin, kids.id, coach.id, 10)
    h.db.update(slots).set({ capacity: 2 }).where(eq(slots.id, id)).run()
    const [a, b, c] = await students(h, 'a', 'b', 'c')
    await seat(h, b, id, kids.id)
    const held = await book(h, a, id, kids.id, 'wechat')
    expect(held.json.status).toBe('pending_payment')
    const listFor = async (t: string) =>
      (await h.call('GET', `/slots?date=2026-10-26&lessonTypeId=${kids.id}`, undefined, t)).json
    expect(await listFor(a)).toEqual([
      expect.objectContaining({ id, seatsLeft: 0, available: false, mine: expect.anything() }),
    ])
    // Its payment time is up, before the sweeper closes it.
    h.clock.now = new Date(h.clock.now.getTime() + 60 * 60_000)
    expect(await listFor(a)).toEqual([
      expect.objectContaining({ id, seatsLeft: 1, available: true, mine: null }),
    ])
    // Everyone else still sees it taken until it is closed.
    expect(await listFor(c)).toEqual([
      expect.objectContaining({ id, seatsLeft: 0, available: false }),
    ])
    const again = await book(h, a, id, kids.id, 'wechat')
    expect(again.status).toBe(201)
    expect(again.json.bookingId).not.toBe(held.json.bookingId)
  })

  it('books a seat at the front desk', async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h)
    const admin = await h.admin()
    const id = await session(h, admin, kids.id, coach.id)
    await h.student('a')
    const res = await h.call(
      'POST',
      '/admin/bookings',
      {
        studentId: 1,
        slotId: id,
        lessonTypeId: kids.id,
        payWith: 'offline',
        amount: 8000,
        method: 'cash',
      },
      admin,
    )
    expect(res.status).toBe(201)
    expect(live(h, id)).toHaveLength(1)
    const again = await h.call(
      'POST',
      '/admin/bookings',
      {
        studentId: 1,
        slotId: id,
        lessonTypeId: kids.id,
        payWith: 'offline',
        amount: 8000,
        method: 'cash',
      },
      admin,
    )
    expect(again.json.error.code).toBe('student_clash')
  })
})

describe('late payments', () => {
  it('confirms a seat whose hold ran out while the session has room, and refunds when full', async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h)
    const admin = await h.admin()
    const id = await session(h, admin, kids.id, coach.id)
    h.db.update(slots).set({ capacity: 2 }).where(eq(slots.id, id)).run()
    const [a, b, c] = await students(h, 'a', 'b', 'c')
    const held = await book(h, a, id, kids.id)
    const order = h.db.select().from(orders).where(eq(orders.id, held.json.orderId)).get()
    if (!order) throw new Error('no order')
    // The hold runs out; another student takes seat 1.
    h.db
      .update(bookings)
      .set({ status: 'expired' })
      .where(eq(bookings.id, held.json.bookingId))
      .run()
    h.db.update(orders).set({ status: 'closed' }).where(eq(orders.id, order.id)).run()
    await seat(h, b, id, kids.id)
    const paid = (outTradeNo: string) => {
      const state = h.gateway.pay(outTradeNo, h.deps.now()).order
      if (state.state !== 'paid') throw new Error('not paid')
      applyPayment(h.deps, outTradeNo, state)
    }
    paid(order.outTradeNo)
    const revived = h.db.select().from(bookings).where(eq(bookings.id, held.json.bookingId)).get()
    expect(revived).toMatchObject({ status: 'confirmed', seat: 2 })

    // Now full: a late payment for another lapsed hold is refunded in full.
    h.db.update(slots).set({ capacity: 3 }).where(eq(slots.id, id)).run()
    const other = await book(h, c, id, kids.id)
    const otherOrder = h.db.select().from(orders).where(eq(orders.id, other.json.orderId)).get()
    h.db
      .update(bookings)
      .set({ status: 'expired' })
      .where(eq(bookings.id, other.json.bookingId))
      .run()
    h.db.update(slots).set({ capacity: 2 }).where(eq(slots.id, id)).run()
    paid(otherOrder?.outTradeNo ?? '')
    expect(
      h.db.select().from(bookings).where(eq(bookings.id, other.json.bookingId)).get()?.status,
    ).toBe('expired')
    expect(h.db.select().from(refunds).get()).toMatchObject({
      orderId: otherOrder?.id,
      amount: 8000,
    })
    expect(live(h, id)).toHaveLength(2)
  })
})

describe('moving seats', () => {
  it('moves a seat to another session of the same class only', async () => {
    const h = setup()
    const { coach, lesson, kids } = seedGroup(h)
    const admin = await h.admin()
    const from = await session(h, admin, kids.id, coach.id, 10)
    const to = await session(h, admin, kids.id, coach.id, 14)
    const t = await h.student('a')
    const id = await seat(h, t, from, kids.id)
    const toPrivate = await h.call(
      'POST',
      `/bookings/${id}/move`,
      { slotId: h.slot(coach.id, '2026-10-27').id },
      t,
    )
    expect(toPrivate.json.error.code).toBe('lesson_type_mismatch')
    const moved = await h.call('POST', `/bookings/${id}/move`, { slotId: to }, t)
    expect(moved.status).toBe(200)
    expect(h.db.select().from(bookings).where(eq(bookings.id, id)).get()).toMatchObject({
      slotId: to,
      seat: 1,
    })
    // A private lesson cannot move into a session either.
    const p = await seat(h, t, h.slot(coach.id, '2026-10-28').id, lesson.id)
    const privateToSession = await h.call(
      'POST',
      `/admin/bookings/${p}/move`,
      { slotId: from },
      admin,
    )
    expect(privateToSession.json.error.code).toBe('lesson_type_mismatch')
  })

  it('refuses a full session', async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h)
    const admin = await h.admin()
    const from = await session(h, admin, kids.id, coach.id, 10)
    const to = await session(h, admin, kids.id, coach.id, 14)
    h.db.update(slots).set({ capacity: 2 }).where(eq(slots.id, to)).run()
    const [a, b, c] = await students(h, 'a', 'b', 'c')
    await seat(h, b, to, kids.id)
    await seat(h, c, to, kids.id)
    const id = await seat(h, a, from, kids.id)
    const res = await h.call('POST', `/admin/bookings/${id}/move`, { slotId: to }, admin)
    expect(res.json.error).toMatchObject({ code: 'slot_taken', message: '该课已满员' })
  })

  it('does not offer a full session for a move because the student’s own hold there lapsed', async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h)
    const admin = await h.admin()
    const from = await session(h, admin, kids.id, coach.id, 10)
    const to = await session(h, admin, kids.id, coach.id, 14)
    h.db.update(slots).set({ capacity: 2 }).where(eq(slots.id, to)).run()
    const [a, b] = await students(h, 'a', 'b')
    const id = await seat(h, a, from, kids.id)
    // a also holds the last place in the 14:00 session, unpaid, and its payment time is up.
    expect((await book(h, a, to, kids.id)).json.status).toBe('pending_payment')
    await seat(h, b, to, kids.id)
    h.clock.now = new Date(h.clock.now.getTime() + 60 * 60_000)
    const listed = async (q: string) =>
      (await h.call('GET', `/slots?date=2026-10-26${q}`, undefined, a)).json.find(
        (s: { id: number }) => s.id === to,
      )
    // Booking again closes the hold first, so a new booking may take that place.
    expect(await listed('')).toMatchObject({ available: true, seatsLeft: 1, mine: null })
    // A move does not, so the session stays full for it, as the move itself says.
    expect(await listed(`&moving=${id}`)).toMatchObject({ available: false, seatsLeft: 0 })
    const move = await h.call('POST', `/bookings/${id}/move`, { slotId: to }, a)
    expect(move.status).toBe(409)
  })
})

describe('the coach and group sessions', () => {
  async function bound(h: Harness) {
    const seeded = seedGroup(h)
    const admin = await h.admin()
    const { code } = (
      await h.call('POST', `/admin/coaches/${seeded.coach.id}/bind-code`, {}, admin)
    ).json
    const res = await h.call('POST', '/coach/bind', { code: 'dev:coach', bindCode: code })
    return { ...seeded, admin, token: res.json.token as string }
  }

  it('shows the session on the schedule and its roster', async () => {
    const h = setup()
    const { coach, kids, admin, token } = await bound(h)
    const id = await session(h, admin, kids.id, coach.id)
    const [a, b] = await students(h, 'a', 'b')
    await h.call('PUT', '/me', { name: '小明' }, a)
    await h.call('PUT', '/me', { name: '小红' }, b)
    const first = await seat(h, a, id, kids.id)
    await seat(h, b, id, kids.id)
    const schedule = (
      await h.call('GET', '/coach/schedule?from=2026-10-26&to=2026-10-26', undefined, token)
    ).json
    expect(schedule.lessons).toEqual([
      expect.objectContaining({
        id,
        lesson: null,
        group: { lessonTypeName: '少儿小班课', capacity: 4, booked: 2, cancelled: false },
      }),
    ])
    const roster = (await h.call('GET', `/coach/sessions/${id}`, undefined, token)).json
    expect(roster).toMatchObject({
      id,
      capacity: 4,
      lessonTypeName: '少儿小班课',
      cancelled: false,
    })
    expect(roster.students.map((s: { name: string }) => s.name)).toEqual(['小明', '小红'])

    // Attendance and the lesson page work per student; cancel and move are the venue's.
    h.clock.now = venueInstant('2026-10-26', 10 * 60 + 30)
    expect(
      (await h.call('PUT', `/coach/lessons/${first}/attendance`, { attendance: 'attended' }, token))
        .status,
    ).toBe(200)
    const lesson = (await h.call('GET', `/coach/lessons/${first}`, undefined, token)).json
    expect(lesson).toMatchObject({
      sessionId: id,
      attendance: 'attended',
      canCancel: false,
      canMove: false,
    })
    h.clock.now = venueInstant('2026-10-25', 10 * 60)
    const cancel = await h.call('POST', `/coach/lessons/${first}/cancel`, { reason: '有事' }, token)
    expect(cancel.json.error.code).toBe('group_lesson')
  })

  it('tells the coach once that a session has students and once that it is off', async () => {
    const h = setup()
    const sent: { page: string; data: Record<string, string> }[] = []
    const notifier: Notifier = {
      template: (kind) =>
        kind.startsWith('coach_') ? { id: kind, fields: { thing1: 'student' } } : undefined,
      async send(_openid, _template, page, values) {
        sent.push({ page, data: { ...values } })
        return 'sent'
      },
    }
    h.deps.notifier = notifier
    const { coach, kids, admin } = await bound(h)
    const id = await session(h, admin, kids.id, coach.id)
    const [a, b] = await students(h, 'a', 'b')
    await seat(h, a, id, kids.id)
    await notifyCoaches(h.deps)
    await seat(h, b, id, kids.id)
    await notifyCoaches(h.deps)
    expect(sent).toEqual([
      {
        page: `coach/session/index?id=${id}`,
        data: expect.objectContaining({ student: '已有 1 人报名' }),
      },
    ])
    await h.call('POST', `/admin/slots/${id}/cancel`, { reason: '场地维修' }, admin)
    await notifyCoaches(h.deps)
    await notifyCoaches(h.deps)
    expect(sent).toHaveLength(2)
    expect(sent[1]?.data).toMatchObject({ reason: '场地维修' })
  })
})

describe('calling off a session', () => {
  it('cancels every seat, gives everything back and closes the session', async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h)
    const admin = await h.admin()
    const id = await session(h, admin, kids.id, coach.id)
    const [a, b, c] = await students(h, 'a', 'b', 'c')
    await seat(h, a, id, kids.id)
    await seat(h, b, id, kids.id)
    // An unpaid hold is released too.
    const held = await book(h, c, id, kids.id)
    const res = await h.call('POST', `/admin/slots/${id}/cancel`, { reason: '场地维修' }, admin)
    // The desk is told what went back, so it knows what is left to hand over in person.
    expect([res.status, res.json]).toEqual([
      200,
      { cancelled: 3, refunded: 16000, offline: 0, failed: 0, lessonsReturned: 0 },
    ])
    expect(live(h, id)).toHaveLength(0)
    const rows = h.db.select().from(bookings).where(eq(bookings.slotId, id)).all()
    expect(
      rows.filter((r) => r.status === 'cancelled' && r.cancelReason === '场地维修'),
    ).toHaveLength(3)
    expect(
      h.db
        .select()
        .from(refunds)
        .all()
        .map((r) => r.amount),
    ).toEqual([8000, 8000])
    expect(h.db.select().from(orders).where(eq(orders.id, held.json.orderId)).get()?.status).toBe(
      'closed',
    )
    expect(h.db.select().from(slots).where(eq(slots.id, id)).get()).toMatchObject({
      open: false,
      cancelReason: '场地维修',
    })
    // A repeat does nothing more; the session cannot be reopened or booked.
    expect(
      (await h.call('POST', `/admin/slots/${id}/cancel`, { reason: '场地维修' }, admin)).json,
    ).toEqual({ cancelled: 0, refunded: 0, offline: 0, failed: 0, lessonsReturned: 0 })
    expect(h.db.select().from(refunds).all()).toHaveLength(2)
    // Another reason, say from a second tab, is told the session went for the first one.
    const other = await h.call('POST', `/admin/slots/${id}/cancel`, { reason: '停电' }, admin)
    expect([other.status, other.json.error.code]).toEqual([409, 'session_cancelled'])
    expect(other.json.error.message).toBe('该节课已取消，原因：场地维修')
    const reopen = await h.call('PATCH', `/admin/slots/${id}`, { open: true }, admin)
    expect(reopen.json.error.code).toBe('session_cancelled')
    const t = await h.student('d')
    expect((await book(h, t, id, kids.id)).json.error.code).toBe('slot_closed')
    const log = (await h.call('GET', '/admin/actions?actions=session.cancel', undefined, admin))
      .json
    expect(log).toEqual([
      expect.objectContaining({
        summary: '10月26日 10:00 王教练 少儿小班课，原因：场地维修，取消 3 人的预约',
      }),
    ])
  })

  it('cancels a seat for the venue when its payment lands after a cancel that failed', async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h)
    const admin = await h.admin()
    const id = await session(h, admin, kids.id, coach.id)
    const [a, b] = await students(h, 'a', 'b')
    const held = await book(h, a, id, kids.id)
    const stuck = await book(h, b, id, kids.id)
    expect(held.json.status).toBe('pending_payment')
    // WeChat Pay cannot be reached, so the holds stay until the sweeper tries again.
    const realClose = h.gateway.closeOrder.bind(h.gateway)
    h.gateway.closeOrder = async () => {
      throw new Error('wechat down')
    }
    const res = await h.call('POST', `/admin/slots/${id}/cancel`, { reason: '场地维修' }, admin)
    expect(res.status).toBe(200)
    expect(live(h, id).map((r) => r.status)).toEqual(['pending_payment', 'pending_payment'])
    // No cashier for it any more.
    const again = await h.call('POST', `/orders/${held.json.orderId}/payment`, {}, a)
    expect(again.status).toBe(409)
    expect(again.json.error).toEqual({
      code: 'lesson_unavailable',
      message: '该课已取消，请预约其他课程',
    })
    // A cashier opened before still takes the money: never confirmed, cancelled by the venue as
    // the rest were, and refunded in full at once.
    const order = h.db.select().from(orders).where(eq(orders.id, held.json.orderId)).get()
    applyPayment(h.deps, order?.outTradeNo ?? '', {
      state: 'paid',
      transactionId: 'x',
      paidAt: h.deps.now(),
      amount: order?.amount ?? 0,
    })
    const row = h.db.select().from(bookings).where(eq(bookings.id, held.json.bookingId)).get()
    expect(row).toMatchObject({
      status: 'cancelled',
      cancelledBy: 'venue',
      cancelReason: '场地维修',
      cancelledAt: h.deps.now(),
      late: false,
    })
    expect(h.db.select().from(refunds).all()).toEqual([
      expect.objectContaining({ amount: 8000, reason: '场馆取消课程' }),
    ])
    const status = await h.call('GET', `/orders/${held.json.orderId}`, undefined, a)
    expect(status.json).toMatchObject({
      status: 'paid',
      bookingStatus: 'cancelled',
      refunded: true,
    })
    const view = await h.call('GET', `/bookings/${held.json.bookingId}`, undefined, a)
    expect(view.json).toMatchObject({ cancelledBy: 'venue', cancelReason: '场地维修' })
    // The student is told, as for the other seats.
    await notifyStudents(h.deps)
    const told = h.db
      .select()
      .from(studentNotices)
      .where(
        and(
          eq(studentNotices.bookingId, held.json.bookingId),
          eq(studentNotices.kind, 'cancelled'),
        ),
      )
      .all()
    expect(told).toHaveLength(1)
    h.gateway.closeOrder = realClose

    // A seat still confirmed before the sweeper gets to it is not on the desk's list and cannot
    // be checked in.
    h.db
      .update(bookings)
      .set({ status: 'confirmed' })
      .where(eq(bookings.id, stuck.json.bookingId))
      .run()
    h.clock.now = venueInstant('2026-10-26', 9 * 60 + 45)
    const desk = await h.admin()
    const list = await h.call('GET', '/admin/front-desk?date=2026-10-26', undefined, desk)
    expect(list.json).toEqual([])
    const scan = await h.call('POST', '/check-in', { code: 'https://yuyue.example.com/checkin' }, b)
    expect(scan.json.error.code).toBe('nothing_to_check_in')
  })

  it('counts a seat whose payment lands while the venue cancels it', async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h)
    const admin = await h.admin()
    const id = await session(h, admin, kids.id, coach.id)
    const [a] = await students(h, 'a')
    const held = await book(h, a, id, kids.id)
    const order = h.db.select().from(orders).where(eq(orders.id, held.json.orderId)).get()
    // Paid at WeChat Pay a moment before the call-off; the close call reports it paid.
    h.gateway.pay(order?.outTradeNo ?? '')
    const res = await h.call('POST', `/admin/slots/${id}/cancel`, { reason: '场地维修' }, admin)
    expect(res.status).toBe(200)
    expect(
      h.db.select().from(bookings).where(eq(bookings.id, held.json.bookingId)).get(),
    ).toMatchObject({ status: 'cancelled', cancelledBy: 'venue', cancelReason: '场地维修' })
    expect(h.db.select().from(refunds).all()).toEqual([
      expect.objectContaining({ amount: 8000, reason: '场馆取消课程' }),
    ])
    const log = (await h.call('GET', '/admin/actions?actions=session.cancel', undefined, admin))
      .json
    expect(log).toEqual([
      expect.objectContaining({
        summary: '10月26日 10:00 王教练 少儿小班课，原因：场地维修，取消 1 人的预约',
      }),
    ])
    await notifyStudents(h.deps)
    const told = h.db
      .select()
      .from(studentNotices)
      .where(eq(studentNotices.kind, 'cancelled'))
      .all()
    expect(told.map((n) => n.bookingId)).toEqual([held.json.bookingId])
  })

  it('calls off a session short of the minimum at the free-cancel deadline, once', async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h, { minStudents: 2 })
    const admin = await h.admin()
    const short = await session(h, admin, kids.id, coach.id, 10)
    const full = await session(h, admin, kids.id, coach.id, 14)
    const [a, b, c] = await students(h, 'a', 'b', 'c')
    const lonely = await seat(h, a, short, kids.id)
    await seat(h, b, full, kids.id)
    await seat(h, c, full, kids.id)

    // A day ahead of the deadline nothing happens.
    h.clock.now = venueInstant('2026-10-25', 9 * 60)
    await cancelUnderfilledSessions(h.deps)
    expect(live(h, short)).toHaveLength(1)

    h.clock.now = venueInstant('2026-10-25', 10 * 60)
    await cancelUnderfilledSessions(h.deps)
    expect(h.db.select().from(bookings).where(eq(bookings.id, lonely)).get()).toMatchObject({
      status: 'cancelled',
      cancelledBy: 'venue',
      cancelReason: UNDERFILLED_REASON,
    })
    expect(
      h.db
        .select()
        .from(refunds)
        .all()
        .map((r) => r.amount),
    ).toEqual([8000])
    expect(live(h, full)).toHaveLength(2)

    // The full one goes ahead at its deadline; a student cancelling late does not call it off.
    h.clock.now = venueInstant('2026-10-25', 14 * 60)
    await cancelUnderfilledSessions(h.deps)
    h.clock.now = venueInstant('2026-10-25', 15 * 60)
    const [late] = live(h, full)
    await h.call('POST', `/bookings/${late?.id}/cancel`, { acceptLate: true }, b)
    await cancelUnderfilledSessions(h.deps)
    expect(live(h, full)).toHaveLength(1)
  })

  it('waits for a student paying at the deadline who would make up the number', async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h, { minStudents: 2 })
    const admin = await h.admin()
    const id = await session(h, admin, kids.id, coach.id)
    const [a, b] = await students(h, 'a', 'b')
    await seat(h, a, id, kids.id)
    h.clock.now = venueInstant('2026-10-25', 10 * 60)
    const paying = await book(h, b, id, kids.id)
    expect(paying.status).toBe(201)
    await cancelUnderfilledSessions(h.deps)
    expect(live(h, id)).toHaveLength(2)
    expect(h.db.select().from(slots).where(eq(slots.id, id)).get()?.minCheckedAt).toBeNull()
    await h.fakePay(paying.json.orderId)
    await cancelUnderfilledSessions(h.deps)
    expect(live(h, id).map((x) => x.status)).toEqual(['confirmed', 'confirmed'])
    expect(h.db.select().from(slots).where(eq(slots.id, id)).get()?.minCheckedAt).not.toBeNull()
  })

  it('does not wait for a hold taken after the check time', async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h, { minStudents: 2 })
    const admin = await h.admin()
    const id = await session(h, admin, kids.id, coach.id)
    const [a, b] = await students(h, 'a', 'b')
    await seat(h, a, id, kids.id)
    h.clock.now = venueInstant('2026-10-25', 10 * 60 + 5)
    expect((await book(h, b, id, kids.id)).status).toBe(201)
    await cancelUnderfilledSessions(h.deps)
    expect(live(h, id)).toHaveLength(0)
  })

  it('checks an hour ahead when cancelling is free until the start', async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h, { minStudents: 2 })
    const admin = await h.admin()
    const settings = (await h.call('GET', '/admin/settings', undefined, admin)).json
    const saved = await h.call(
      'PUT',
      '/admin/settings',
      { ...settings, booking: { ...settings.booking, cancelDeadlineHours: 0 } },
      admin,
    )
    expect(saved.status).toBe(200)
    const id = await session(h, admin, kids.id, coach.id)
    const t = await h.student('a')
    await seat(h, t, id, kids.id)
    h.clock.now = venueInstant('2026-10-26', 9 * 60)
    await cancelUnderfilledSessions(h.deps)
    expect(live(h, id)).toHaveLength(0)
  })

  it("checks at the class's own free-cancel deadline", async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h, { minStudents: 2, rules: { cancelDeadlineHours: 48 } })
    const admin = await h.admin()
    const id = await session(h, admin, kids.id, coach.id)
    const t = await h.student('a')
    await seat(h, t, id, kids.id)
    h.clock.now = venueInstant('2026-10-24', 9 * 60)
    await cancelUnderfilledSessions(h.deps)
    expect(live(h, id)).toHaveLength(1)
    h.clock.now = venueInstant('2026-10-24', 10 * 60)
    await cancelUnderfilledSessions(h.deps)
    expect(live(h, id)).toHaveLength(0)
  })

  it('leaves a session scheduled after its deadline alone', async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h, { minStudents: 2 })
    const admin = await h.admin()
    const res = await schedule(h, admin, {
      lessonTypeId: kids.id,
      coachId: coach.id,
      date: '2026-10-23',
      hour: 18,
    })
    const id = res.json.ids[0]
    const t = await h.student('a')
    await seat(h, t, id, kids.id)
    await cancelUnderfilledSessions(h.deps)
    expect(live(h, id)).toHaveLength(1)
  })
})

describe('session capacity', () => {
  it('never goes below the students booked, and renumbers seats when lowered', async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h, { capacity: 6 })
    const admin = await h.admin()
    const id = await session(h, admin, kids.id, coach.id)
    const tokens = await students(h, 'a', 'b', 'c')
    const ids: number[] = []
    for (const t of tokens) ids.push(await seat(h, t, id, kids.id))
    // Seats 1 and 2 free up; seat 3 stays.
    await h.call('POST', `/bookings/${ids[0]}/cancel`, {}, tokens[0])
    await h.call('POST', `/bookings/${ids[1]}/cancel`, {}, tokens[1])
    const below = await h.call('PATCH', `/admin/slots/${id}`, { capacity: 2 }, admin)
    expect(below.status).toBe(204)
    expect(live(h, id).map((b) => b.seat)).toEqual([1])
    const t = await h.student('d')
    await seat(h, t, id, kids.id)
    const tooLow = await h.call('PATCH', `/admin/slots/${id}`, { capacity: 1 }, admin)
    expect(tooLow.status).toBe(400)
    const raised = await h.call('PATCH', `/admin/slots/${id}`, { capacity: 6 }, admin)
    expect(raised.status).toBe(204)
    const t2 = await h.student('e')
    const t3 = await h.student('f')
    await seat(h, t2, id, kids.id)
    expect(
      (await h.call('PATCH', `/admin/slots/${id}`, { capacity: 2 }, admin)).json.error.code,
    ).toBe('capacity_below_booked')
    await seat(h, t3, id, kids.id)
    expect(live(h, id)).toHaveLength(4)
  })

  it('lists who booked each session for the admin', async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h)
    const admin = await h.admin()
    const id = await session(h, admin, kids.id, coach.id)
    const [a, b] = await students(h, 'a', 'b')
    await seat(h, a, id, kids.id)
    await seat(h, b, id, kids.id)
    const from = venueInstant('2026-10-26', 0).toISOString()
    const to = venueInstant('2026-10-27', 0).toISOString()
    const rows = (await h.call('GET', `/admin/slots?from=${from}&to=${to}`, undefined, admin)).json
    expect(rows).toEqual([
      expect.objectContaining({ id, capacity: 4, lessonTypeId: kids.id, booking: null }),
    ])
    expect(rows[0].bookings).toHaveLength(2)
  })
})

describe('one lesson for 课程详情', () => {
  it('shows the session, its seats, its feedback and what was done to it', async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h, { capacity: 6 })
    const admin = await h.admin()
    const slotId = await session(h, admin, kids.id, coach.id)
    const other = await session(h, admin, kids.id, coach.id, 14)
    const [a, b, c] = await students(h, '甲', '乙', '丙')
    const first = await seat(h, a, slotId, kids.id)
    const second = await seat(h, b, slotId, kids.id)
    await seat(h, c, other, kids.id)

    const detail = await h.call('GET', `/admin/slots/${slotId}`, undefined, admin)
    expect(detail.status).toBe(200)
    expect(detail.json).toMatchObject({
      id: slotId,
      capacity: 4,
      coach: { id: coach.id, name: coach.name },
      lessonType: { id: kids.id, name: '少儿小班课' },
      cancelledAt: null,
    })
    expect((await h.call('GET', '/admin/slots/99999', undefined, admin)).status).toBe(404)

    const seats = await h.call('GET', `/admin/bookings?slotId=${slotId}`, undefined, admin)
    expect(seats.json.map((s: { id: number }) => s.id)).toEqual([first, second])
    expect(seats.json[0]).toMatchObject({ slotId })
    const one = await h.call('GET', `/admin/bookings?id=${second}`, undefined, admin)
    expect(one.json.map((s: { id: number }) => s.id)).toEqual([second])

    h.db
      .insert(lessonFeedback)
      .values({ bookingId: first, text: '反手进步了', updatedAt: h.clock.now })
      .run()
    const feedback = await h.call('GET', `/admin/feedback?slotId=${slotId}`, undefined, admin)
    expect(feedback.json.map((f: { bookingId: number }) => f.bookingId)).toEqual([first])
    expect((await h.call('GET', `/admin/feedback?slotId=${other}`, undefined, admin)).json).toEqual(
      [],
    )

    expect((await h.call('PATCH', `/admin/slots/${slotId}`, { capacity: 6 }, admin)).status).toBe(
      204,
    )
    expect(
      (await h.call('POST', `/admin/bookings/${second}/cancel`, { reason: '请假' }, admin)).status,
    ).toBe(200)
    const log = await h.call('GET', `/admin/actions?slotId=${slotId}`, undefined, admin)
    expect(log.json.map((e: { action: string }) => e.action)).toEqual([
      'booking.cancel',
      'session.update',
      'session.create',
    ])
    const otherLog = await h.call('GET', `/admin/actions?slotId=${other}`, undefined, admin)
    expect(otherLog.json.map((e: { action: string }) => e.action)).toEqual(['session.create'])
  })
})
