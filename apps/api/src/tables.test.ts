import { venueInstant } from '@rs/shared'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
  bookings,
  coaches,
  coachLessonTypes,
  lessonTypes,
  orders,
  refunds,
  scheduleExceptions,
  slots,
} from './db/schema'
import { type Harness, setup } from './test/harness'

// The harness clock is 2026-10-23 10:00 at the venue. Every lesson here is on 10-25.

/** `n` coaches teaching the seeded lesson, the seeded coach first. */
function venue(h: Harness, n: number, tables: number | null) {
  const seeded = h.seed()
  const list = [seeded.coach]
  for (let i = 1; i < n; i++) {
    const coach = h.db
      .insert(coaches)
      .values({ name: `教练${i}` })
      .returning()
      .get()
    h.db
      .insert(coachLessonTypes)
      .values({ coachId: coach.id, lessonTypeId: seeded.lesson.id })
      .run()
    list.push(coach)
  }
  h.settings((s) => {
    s.booking.tables = tables
  })
  // A coach by position, as an id.
  const coach = (i: number) => list[i]?.id ?? 0
  return { ...seeded, coach }
}

/**
 * A 60-minute private lesson time starting at a venue time given in minutes after midnight: the
 * coach works then, and the lesson row exists so it can be booked by id.
 */
function slotAt(h: Harness, coachId: number, minute: number) {
  const span = {
    startsAt: venueInstant('2026-10-25', minute),
    endsAt: venueInstant('2026-10-25', minute + 60),
  }
  h.db
    .insert(scheduleExceptions)
    .values({ coachId, kind: 'extra', ...span })
    .run()
  return h.db
    .insert(slots)
    .values({ coachId, ...span })
    .returning()
    .get()
}

/** Whether the private time at a lesson row's coach and start shows as bookable. */
function listedAvailable(
  listed: { coachId: number; startsAt: string; available: boolean }[],
  slot: { coachId: number; startsAt: Date },
) {
  return listed.find(
    (s) => s.coachId === slot.coachId && s.startsAt === slot.startsAt.toISOString(),
  )?.available
}

const book = (h: Harness, t: string, slotId: number, lessonTypeId: number) =>
  h.call('POST', '/bookings', { slotId, lessonTypeId }, t)

async function pay(h: Harness, res: { json: { orderId: number | null } }) {
  if (res.json.orderId) await h.fakePay(res.json.orderId)
}

describe('table limit', () => {
  it('refuses a booking once every table is in use, and frees it on cancel', async () => {
    const h = setup()
    const v = venue(h, 3, 2)
    const a = h.slot(v.coach(0)).id
    const b = h.slot(v.coach(1)).id
    const cSlot = h.slot(v.coach(2))
    const c = cSlot.id
    const t1 = await h.student('s1')
    const t2 = await h.student('s2')
    const t3 = await h.student('s3')
    const first = await book(h, t1, a, v.lesson.id)
    expect(first.status).toBe(201)
    // An unpaid hold uses a table too.
    expect((await book(h, t2, b, v.lesson.id)).status).toBe(201)
    const third = await book(h, t3, c, v.lesson.id)
    expect(third.status).toBe(409)
    expect(third.json.error).toMatchObject({ code: 'tables_full', message: '该时段球台已满' })

    // The student sees the third coach's time as full.
    const list = `/slots?date=2026-10-25&lessonTypeId=${v.lesson.id}`
    const listed = (await h.call('GET', list, undefined, t3)).json
    expect(listedAvailable(listed, cSlot)).toBe(false)

    await h.call('POST', `/bookings/${first.json.bookingId}/cancel`, {}, t1)
    const listedAgain = (await h.call('GET', list, undefined, t3)).json
    expect(listedAvailable(listedAgain, cSlot)).toBe(true)
    expect((await book(h, t3, c, v.lesson.id)).status).toBe(201)
  })

  it('has no limit when the setting is empty', async () => {
    const h = setup()
    const v = venue(h, 3, null)
    for (const i of [0, 1, 2]) {
      const t = await h.student(`s${i}`)
      expect((await book(h, t, h.slot(v.coach(i)).id, v.lesson.id)).status).toBe(201)
    }
  })

  it('counts lessons running at once, not lessons touching the time', async () => {
    const h = setup()
    const v = venue(h, 4, 2)
    const t0 = await h.student('s0')
    const t1 = await h.student('s1')
    const t2 = await h.student('s2')
    const t3 = await h.student('s3')
    expect((await book(h, t0, slotAt(h, v.coach(0), 9 * 60 + 30).id, v.lesson.id)).status).toBe(201)
    expect((await book(h, t1, slotAt(h, v.coach(1), 10 * 60 + 30).id, v.lesson.id)).status).toBe(
      201,
    )
    // 10:00-11:00 overlaps both, but they never run together, so one table is still free.
    expect((await book(h, t2, slotAt(h, v.coach(2), 10 * 60).id, v.lesson.id)).status).toBe(201)
    const full = await book(h, t3, slotAt(h, v.coach(3), 10 * 60).id, v.lesson.id)
    expect(full.json.error?.code).toBe('tables_full')
    // Right after the 10:30 lesson ends there is room again.
    expect((await book(h, t3, slotAt(h, v.coach(3), 11 * 60 + 30).id, v.lesson.id)).status).toBe(
      201,
    )
  })

  it('applies to front-desk bookings', async () => {
    const h = setup()
    const v = venue(h, 2, 1)
    const t1 = await h.student('s1')
    await h.student('s2')
    await pay(h, await book(h, t1, h.slot(v.coach(0)).id, v.lesson.id))
    const admin = await h.admin()
    const res = await h.call(
      'POST',
      '/admin/bookings',
      {
        studentId: 2,
        slotId: h.slot(v.coach(1)).id,
        lessonTypeId: v.lesson.id,
        payWith: 'offline',
        amount: 20000,
      },
      admin,
    )
    expect(res.status).toBe(409)
    expect(res.json.error.code).toBe('tables_full')
  })

  it('lets a lesson move within its own time but not onto a full one', async () => {
    const h = setup()
    const v = venue(h, 3, 2)
    const t1 = await h.student('s1')
    const t2 = await h.student('s2')
    const own = await book(h, t1, slotAt(h, v.coach(0), 10 * 60).id, v.lesson.id)
    await pay(h, own)
    await pay(h, await book(h, t2, slotAt(h, v.coach(1), 10 * 60).id, v.lesson.id))
    const id = own.json.bookingId as number

    // Both tables are in use at 10:00, but the lesson gives up its own when it moves.
    const half = slotAt(h, v.coach(2), 10 * 60 + 30)
    const listed = (
      await h.call(
        'GET',
        `/slots?date=2026-10-25&coachId=${v.coach(2)}&moving=${id}`,
        undefined,
        t1,
      )
    ).json
    expect(listedAvailable(listed, half)).toBe(true)
    // Another student's booking cannot be used to free a table.
    const t3 = await h.student('s3')
    const peek = (
      await h.call(
        'GET',
        `/slots?date=2026-10-25&coachId=${v.coach(2)}&lessonTypeId=${v.lesson.id}&moving=${id}`,
        undefined,
        t3,
      )
    ).json
    expect(listedAvailable(peek, half)).toBe(false)

    const admin = await h.admin()
    const moved = await h.call('POST', `/admin/bookings/${id}/move`, { slotId: half.id }, admin)
    expect(moved.status).toBe(204)

    // A third lesson at 11:00 overlaps the moved one until 11:30, which fills both tables then.
    await pay(h, await book(h, t3, slotAt(h, v.coach(0), 11 * 60).id, v.lesson.id))
    const other = h.db.select().from(bookings).where(eq(bookings.studentId, 2)).get()
    const res = await h.call(
      'POST',
      `/admin/bookings/${other?.id}/move`,
      { slotId: slotAt(h, v.coach(1), 11 * 60).id },
      admin,
    )
    expect(res.status).toBe(409)
    expect(res.json.error.code).toBe('tables_full')
  })

  it('does not revive an expired hold once its table is gone, and refunds the payment', async () => {
    const h = setup()
    const v = venue(h, 2, 1)
    const t1 = await h.student('s1')
    const t2 = await h.student('s2')
    const held = await book(h, t1, h.slot(v.coach(0)).id, v.lesson.id)
    // The hold runs out and the table goes to someone else.
    h.clock.now = new Date(h.clock.now.getTime() + 11 * 60_000)
    h.db
      .update(bookings)
      .set({ status: 'expired' })
      .where(eq(bookings.id, held.json.bookingId))
      .run()
    h.db.update(orders).set({ status: 'closed' }).where(eq(orders.id, held.json.orderId)).run()
    await pay(h, await book(h, t2, h.slot(v.coach(1)).id, v.lesson.id))
    // The late payment lands.
    await h.fakePay(held.json.orderId)
    const row = h.db.select().from(bookings).where(eq(bookings.id, held.json.bookingId)).get()
    expect(row?.status).toBe('expired')
    const refund = h.db.select().from(refunds).where(eq(refunds.orderId, held.json.orderId)).get()
    expect(refund?.amount).toBe(20000)
  })

  it('marks full times for the front desk and the coach', async () => {
    const h = setup()
    const v = venue(h, 2, 1)
    const t1 = await h.student('s1')
    const own = await book(h, t1, slotAt(h, v.coach(0), 10 * 60).id, v.lesson.id)
    await pay(h, own)
    slotAt(h, v.coach(1), 10 * 60 + 30)
    const admin = await h.admin()
    const times = async (q: string) =>
      (
        await h.call(
          'GET',
          `/admin/open-times?date=2026-10-25&coachId=${v.coach(1)}&${q}`,
          undefined,
          admin,
        )
      ).json.map((t: { startsAt: string; tableFull: boolean }) => [t.startsAt, t.tableFull])
    expect(await times(`lessonTypeId=${v.lesson.id}`)).toEqual([
      [venueInstant('2026-10-25', 10 * 60 + 30).toISOString(), true],
    ])
    // Moving the 10:00 lesson frees its table.
    expect(await times(`moving=${own.json.bookingId}`)).toEqual([
      [venueInstant('2026-10-25', 10 * 60 + 30).toISOString(), false],
    ])

    // The coach moving a lesson of their own sees the same.
    const theirs = await book(
      h,
      await h.student('s2'),
      slotAt(h, v.coach(1), 14 * 60).id,
      v.lesson.id,
    )
    await pay(h, theirs)
    const { code } = (await h.call('POST', `/admin/coaches/${v.coach(1)}/bind-code`, {}, admin))
      .json
    const coach = (await h.call('POST', '/coach/bind', { code: 'dev:coach', bindCode: code })).json
      .token as string
    const moveTimes = (
      await h.call(
        'GET',
        `/coach/move-times?bookingId=${theirs.json.bookingId}&from=2026-10-25&to=2026-10-25`,
        undefined,
        coach,
      )
    ).json
    expect(moveTimes).toEqual([
      {
        coachId: v.coach(1),
        startsAt: venueInstant('2026-10-25', 10 * 60 + 30).toISOString(),
        endsAt: venueInstant('2026-10-25', 11 * 60 + 30).toISOString(),
        tableFull: true,
      },
    ])
    // Another coach's lesson is not theirs to move.
    const peek = await h.call(
      'GET',
      `/coach/move-times?bookingId=${own.json.bookingId}&from=2026-10-25&to=2026-10-25`,
      undefined,
      coach,
    )
    expect(peek.status).toBe(404)
  })

  it('counts a group session as one table however many join', async () => {
    const h = setup()
    const v = venue(h, 2, 1)
    const kids = h.db
      .insert(lessonTypes)
      .values({ name: '少儿小班课', durationMinutes: 60, price: 8000, capacity: 4 })
      .returning()
      .get()
    for (const i of [0, 1]) {
      h.db
        .insert(coachLessonTypes)
        .values({ coachId: v.coach(i), lessonTypeId: kids.id })
        .run()
    }
    const admin = await h.admin()
    const created = await h.call(
      'POST',
      '/admin/sessions',
      {
        lessonTypeId: kids.id,
        capacity: 4,
        sessions: [0, 1].map((i) => ({
          coachId: v.coach(i),
          startsAt: venueInstant('2026-10-25', 10 * 60).toISOString(),
          endsAt: venueInstant('2026-10-25', 11 * 60).toISOString(),
        })),
      },
      admin,
    )
    expect(created.status).toBe(201)
    const [first, second] = created.json.ids as number[]
    const t1 = await h.student('k1')
    const t2 = await h.student('k2')
    const t3 = await h.student('k3')
    await pay(h, await book(h, t1, first ?? 0, kids.id))
    // A second student joins the same session: no new table.
    const join = await book(h, t2, first ?? 0, kids.id)
    expect(join.status).toBe(201)
    // The other coach's empty session would need a second table.
    const other = await book(h, t3, second ?? 0, kids.id)
    expect(other.json.error?.code).toBe('tables_full')
    const listed = (await h.call('GET', '/slots?date=2026-10-25', undefined, t3)).json
    expect(listed.find((s: { id: number }) => s.id === first).available).toBe(true)
    expect(listed.find((s: { id: number }) => s.id === second).available).toBe(false)
  })

  it('gives a group session a table per students-per-table', async () => {
    const h = setup()
    const v = venue(h, 2, 2)
    const kids = h.db
      .insert(lessonTypes)
      .values({
        name: '少儿小班课',
        durationMinutes: 60,
        price: 8000,
        capacity: 6,
        studentsPerTable: 2,
      })
      .returning()
      .get()
    h.db
      .insert(coachLessonTypes)
      .values({ coachId: v.coach(0), lessonTypeId: kids.id })
      .run()
    const admin = await h.admin()
    const created = await h.call(
      'POST',
      '/admin/sessions',
      {
        lessonTypeId: kids.id,
        capacity: 6,
        sessions: [
          {
            coachId: v.coach(0),
            startsAt: venueInstant('2026-10-25', 10 * 60).toISOString(),
            endsAt: venueInstant('2026-10-25', 11 * 60).toISOString(),
          },
        ],
      },
      admin,
    )
    const sessionId = created.json.ids[0] as number
    const kidTokens = await Promise.all(['k1', 'k2', 'k3', 'k4', 'k5'].map((n) => h.student(n)))
    const join = (i: number) => book(h, kidTokens[i] ?? '', sessionId, kids.id)
    // Two kids share the first table, so a private lesson still fits on the second.
    expect((await join(0)).status).toBe(201)
    expect((await join(1)).status).toBe(201)
    const adult = await h.student('adult')
    const privateSlot = slotAt(h, v.coach(1), 10 * 60)
    const listed = (
      await h.call('GET', `/slots?date=2026-10-25&lessonTypeId=${kids.id}`, undefined, kidTokens[2])
    ).json
    expect(listed.find((s: { id: number }) => s.id === sessionId).available).toBe(true)
    expect((await book(h, adult, privateSlot.id, v.lesson.id)).status).toBe(201)
    // A third kid would need a second table, which the private lesson now uses.
    const third = await join(2)
    expect(third.json.error?.code).toBe('tables_full')
    const after = (await h.call('GET', '/slots?date=2026-10-25', undefined, kidTokens[2])).json
    expect(after.find((s: { id: number }) => s.id === sessionId).available).toBe(false)

    // Once the private lesson is cancelled, the class grows to two tables, four kids.
    const own = h.db.select().from(bookings).where(eq(bookings.slotId, privateSlot.id)).get()
    await h.call('POST', `/bookings/${own?.id}/cancel`, {}, adult)
    expect((await join(2)).status).toBe(201)
    expect((await join(3)).status).toBe(201)
    expect((await join(4)).json.error?.code).toBe('tables_full')
  })
})
