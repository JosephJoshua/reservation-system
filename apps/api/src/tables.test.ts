import { venueInstant } from '@rs/shared'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { bookings, coaches, coachLessonTypes, orders, refunds, slots } from './db/schema'
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

/** A 60-minute slot starting at a venue time given in minutes after midnight. */
function slotAt(h: Harness, coachId: number, minute: number) {
  return h.db
    .insert(slots)
    .values({
      coachId,
      startsAt: venueInstant('2026-10-25', minute),
      endsAt: venueInstant('2026-10-25', minute + 60),
    })
    .returning()
    .get()
}

const book = (h: Harness, t: string, slotId: number, lessonTypeId: number) =>
  h.call('POST', '/bookings', { slotId, lessonTypeId }, t)

async function pay(h: Harness, res: { json: { orderId: number | null } }) {
  if (res.json.orderId) await h.call('POST', `/dev/fake-pay/${res.json.orderId}`)
}

describe('table limit', () => {
  it('refuses a booking once every table is in use, and frees it on cancel', async () => {
    const h = setup()
    const v = venue(h, 3, 2)
    const a = h.slot(v.coach(0)).id
    const b = h.slot(v.coach(1)).id
    const c = h.slot(v.coach(2)).id
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
    const listed = (await h.call('GET', '/slots?date=2026-10-25', undefined, t3)).json
    expect(listed.find((s: { id: number }) => s.id === c).available).toBe(false)

    await h.call('POST', `/bookings/${first.json.bookingId}/cancel`, {}, t1)
    const listedAgain = (await h.call('GET', '/slots?date=2026-10-25', undefined, t3)).json
    expect(listedAgain.find((s: { id: number }) => s.id === c).available).toBe(true)
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
    expect(listed.find((s: { id: number }) => s.id === half.id).available).toBe(true)
    // Another student's booking cannot be used to free a table.
    const t3 = await h.student('s3')
    const peek = (
      await h.call(
        'GET',
        `/slots?date=2026-10-25&coachId=${v.coach(2)}&moving=${id}`,
        undefined,
        t3,
      )
    ).json
    expect(peek.find((s: { id: number }) => s.id === half.id).available).toBe(false)

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
    await h.call('POST', `/dev/fake-pay/${held.json.orderId}`)
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
    const other = slotAt(h, v.coach(1), 10 * 60 + 30)
    const admin = await h.admin()
    const range = `from=${venueInstant('2026-10-25', 0).toISOString()}&to=${venueInstant('2026-10-26', 0).toISOString()}`
    const adminRows = (await h.call('GET', `/admin/slots?${range}`, undefined, admin)).json
    expect(adminRows.map((s: { tableFull: boolean }) => s.tableFull)).toEqual([false, true])
    // Moving the 10:00 lesson frees its table.
    const movingRows = (
      await h.call('GET', `/admin/slots?${range}&moving=${own.json.bookingId}`, undefined, admin)
    ).json
    expect(movingRows.map((s: { tableFull: boolean }) => s.tableFull)).toEqual([false, false])

    const { code } = (await h.call('POST', `/admin/coaches/${v.coach(1)}/bind-code`, {}, admin))
      .json
    const coach = (await h.call('POST', '/coach/bind', { code: 'dev:coach', bindCode: code })).json
      .token as string
    const schedule = (
      await h.call('GET', '/coach/schedule?from=2026-10-25&to=2026-10-25', undefined, coach)
    ).json
    expect(schedule).toMatchObject([{ id: other.id, tableFull: true }])
    // Another coach's lesson does not count as the one being moved.
    const peek = (
      await h.call(
        'GET',
        `/coach/schedule?from=2026-10-25&to=2026-10-25&moving=${own.json.bookingId}`,
        undefined,
        coach,
      )
    ).json
    expect(peek).toMatchObject([{ id: other.id, tableFull: true }])
  })
})
