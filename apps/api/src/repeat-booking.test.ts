import { venueInstant } from '@rs/shared'
import { describe, expect, it } from 'vitest'
import {
  bookings,
  coachLessonTypes,
  lessonTypes,
  orders,
  packageProducts,
  packages,
} from './db/schema'
import { type Harness, setup } from './test/harness'

/** A ¥80 four-seat group session the seeded coach teaches on 2026-10-26 at 10:00. */
async function groupSession(h: Harness) {
  const seeded = h.seed()
  const kids = h.db
    .insert(lessonTypes)
    .values({ name: '少儿小班课', durationMinutes: 60, price: 8000, capacity: 4 })
    .returning()
    .get()
  h.db.insert(coachLessonTypes).values({ coachId: seeded.coach.id, lessonTypeId: kids.id }).run()
  const admin = await h.admin()
  const s = await h.call(
    'POST',
    '/admin/sessions',
    {
      lessonTypeId: kids.id,
      capacity: 4,
      sessions: [
        {
          coachId: seeded.coach.id,
          startsAt: venueInstant('2026-10-26', 600).toISOString(),
          endsAt: venueInstant('2026-10-26', 660).toISOString(),
        },
      ],
    },
    admin,
  )
  expect(s.status).toBe(201)
  return { kids, slotId: s.json.ids[0] as number }
}

const byWechat = (slotId: number, lessonTypeId: number, expectedPrice = 8000) => ({
  slotId,
  lessonTypeId,
  payWith: 'wechat',
  expectedPrice,
})

describe('booking a session the student already holds', () => {
  it('points a repeat on other terms to the unpaid hold instead of its old order', async () => {
    const h = setup()
    const { kids, slotId } = await groupSession(h)
    const t = await h.student('a')
    const first = await h.call('POST', '/bookings', byWechat(slotId, kids.id), t)
    expect(first.json.status).toBe('pending_payment')
    // The same terms again: the same hold and order.
    const same = await h.call('POST', '/bookings', byWechat(slotId, kids.id), t)
    expect(same.status).toBe(201)
    expect(same.json).toMatchObject({
      bookingId: first.json.bookingId,
      orderId: first.json.orderId,
      existing: true,
    })
    // Bought a package meanwhile, and books the same session with it.
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
    const bought = await h.call('POST', '/packages/purchase', { productId: product.id }, t)
    await h.fakePay(bought.json.orderId)
    const pkg = h.db.select().from(packages).get()
    const withPackage = await h.call(
      'POST',
      '/bookings',
      { slotId, lessonTypeId: kids.id, payWith: 'package', expectedPackageId: pkg?.id },
      t,
    )
    expect(withPackage.status).toBe(409)
    expect(withPackage.json.error).toEqual({
      code: 'already_booked',
      message: '你已预约这节课，待支付',
      bookingId: first.json.bookingId,
    })
    expect(h.db.select().from(packages).get()?.lessonsRemaining).toBe(10)
    // Another price than the hold's is not the same booking either.
    const cheaper = await h.call('POST', '/bookings', byWechat(slotId, kids.id, 1), t)
    expect(cheaper.status).toBe(409)
    expect(cheaper.json.error).toMatchObject({
      code: 'already_booked',
      bookingId: first.json.bookingId,
    })
    // Nor is paying with another package than the one shown.
    const otherPackage = await h.call(
      'POST',
      '/bookings',
      { slotId, lessonTypeId: kids.id, payWith: 'package', expectedPackageId: 999 },
      t,
    )
    expect(otherPackage.json.error.code).toBe('already_booked')
    // Still one seat, and one order for the class.
    expect(h.db.select().from(bookings).all()).toHaveLength(1)
    expect(
      h.db
        .select()
        .from(orders)
        .all()
        .filter((o) => o.kind === 'class'),
    ).toHaveLength(1)
  })

  it('returns a booked seat asked the same, and points one asked otherwise to it', async () => {
    const h = setup()
    const { kids, slotId } = await groupSession(h)
    const t = await h.student('a')
    const first = await h.call('POST', '/bookings', byWechat(slotId, kids.id), t)
    await h.fakePay(first.json.orderId)
    const again = await h.call('POST', '/bookings', byWechat(slotId, kids.id), t)
    expect(again.status).toBe(201)
    expect(again.json).toMatchObject({
      bookingId: first.json.bookingId,
      status: 'confirmed',
      orderId: null,
      existing: true,
    })
    const other = await h.call(
      'POST',
      '/bookings',
      { slotId, lessonTypeId: kids.id, payWith: 'package' },
      t,
    )
    expect(other.status).toBe(409)
    expect(other.json.error).toEqual({
      code: 'already_booked',
      message: '你已预约这节课',
      bookingId: first.json.bookingId,
    })
  })

  it('points a repeat under other rules to the hold, judged by the rules it was booked under', async () => {
    const h = setup()
    const { kids, slotId } = await groupSession(h)
    const t = await h.student('a')
    const first = await h.call('POST', '/bookings', byWechat(slotId, kids.id), t)
    const { terms } = (await h.call('GET', `/bookings/${first.json.bookingId}`, undefined, t)).json
    const withTerms = { ...byWechat(slotId, kids.id), expectedTerms: terms }
    const same = await h.call('POST', '/bookings', withTerms, t)
    expect(same.json).toMatchObject({ bookingId: first.json.bookingId, existing: true })
    const other = await h.call(
      'POST',
      '/bookings',
      {
        ...byWechat(slotId, kids.id),
        expectedTerms: { ...terms, cancelDeadlineHours: terms.cancelDeadlineHours + 1 },
      },
      t,
    )
    expect(other.status).toBe(409)
    expect(other.json.error).toMatchObject({
      code: 'already_booked',
      bookingId: first.json.bookingId,
    })
    // The venue's rules changed since: the hold keeps the ones it was booked under.
    h.settings((s) => {
      s.booking.cancelDeadlineHours = terms.cancelDeadlineHours + 5
    })
    const later = await h.call('POST', '/bookings', withTerms, t)
    expect(later.json).toMatchObject({ bookingId: first.json.bookingId, existing: true })
  })

  it('returns a booking asked for with a package it had none for, asked the same again', async () => {
    const h = setup()
    const { kids, slotId } = await groupSession(h)
    const t = await h.student('a')
    const body = { slotId, lessonTypeId: kids.id, expectedPackageId: 5, expectedPrice: 8000 }
    const first = await h.call('POST', '/bookings', body, t)
    expect(first.status).toBe(201)
    expect(first.json.status).toBe('pending_payment')
    const again = await h.call('POST', '/bookings', body, t)
    expect(again.status).toBe(201)
    expect(again.json).toMatchObject({
      bookingId: first.json.bookingId,
      orderId: first.json.orderId,
      existing: true,
    })
    // Asking to pay with that package is another booking than the one held.
    const withPackage = await h.call('POST', '/bookings', { ...body, payWith: 'package' }, t)
    expect(withPackage.json.error.code).toBe('already_booked')
  })

  it('judges a repeat that does not say how to pay by how a new booking would pay', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const product = h.db
      .insert(packageProducts)
      .values({
        name: '五节',
        lessonTypeId: lesson.id,
        lessonCount: 5,
        price: 90000,
        validityDays: 30,
      })
      .returning()
      .get()
    const slot = h.slot(coach.id, '2026-10-25', 10)
    const t = await h.student('a')
    const body = { slotId: slot.id, lessonTypeId: lesson.id }
    const first = await h.call('POST', '/bookings', body, t)
    expect(first.json.status).toBe('pending_payment')
    // No package yet: asked the same, it is the hold.
    expect((await h.call('POST', '/bookings', body, t)).json).toMatchObject({
      bookingId: first.json.bookingId,
      existing: true,
    })
    const buy = await h.call('POST', '/packages/purchase', { productId: product.id }, t)
    await h.fakePay(buy.json.orderId)
    const pkg = h.db.select().from(packages).get()
    expect(pkg).toBeDefined()
    // Now a new booking would use the package, so the WeChat hold is not what is asked for.
    for (const asked of [body, { ...body, expectedPackageId: pkg?.id }]) {
      const again = await h.call('POST', '/bookings', asked, t)
      expect(again.status).toBe(409)
      expect(again.json.error).toMatchObject({
        code: 'already_booked',
        bookingId: first.json.bookingId,
      })
    }
    // Saying WeChat Pay still gets the hold back.
    expect(
      (await h.call('POST', '/bookings', { ...body, payWith: 'wechat' }, t)).json,
    ).toMatchObject({ bookingId: first.json.bookingId, existing: true })
  })

  it('returns a lesson booked with the last lesson of a package, asked again the same', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const slot = h.slot(coach.id, '2026-10-25', 10)
    const t = await h.student('a')
    const product = h.db
      .insert(packageProducts)
      .values({
        name: '一节',
        lessonTypeId: lesson.id,
        lessonCount: 1,
        price: 18000,
        validityDays: 30,
      })
      .returning()
      .get()
    const buy = await h.call('POST', '/packages/purchase', { productId: product.id }, t)
    await h.fakePay(buy.json.orderId)
    const body = { slotId: slot.id, lessonTypeId: lesson.id }
    const first = await h.call('POST', '/bookings', body, t)
    expect(first.json.status).toBe('confirmed')
    // The package has no lesson left, but this booking holds it: still a repeat.
    expect((await h.call('POST', '/bookings', body, t)).json).toMatchObject({
      bookingId: first.json.bookingId,
      existing: true,
    })
  })

  it('points a repeat of a private lesson on other terms to the hold', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const slot = h.slot(coach.id)
    const t = await h.student('a')
    const body = {
      slotId: slot.id,
      lessonTypeId: lesson.id,
      payWith: 'wechat',
      expectedPrice: 20000,
    }
    const first = await h.call('POST', '/bookings', body, t)
    expect(first.json.status).toBe('pending_payment')
    expect((await h.call('POST', '/bookings', body, t)).json).toMatchObject({
      bookingId: first.json.bookingId,
      existing: true,
    })
    // Booked by coach and start rather than by the slot's id, at another price.
    const byTime = await h.call(
      'POST',
      '/bookings',
      {
        coachId: coach.id,
        startsAt: slot.startsAt.toISOString(),
        lessonTypeId: lesson.id,
        payWith: 'wechat',
        expectedPrice: 15000,
      },
      t,
    )
    expect(byTime.status).toBe(409)
    expect(byTime.json.error).toEqual({
      code: 'already_booked',
      message: '你已预约这节课，待支付',
      bookingId: first.json.bookingId,
    })
    const withPackage = await h.call('POST', '/bookings', { ...body, payWith: 'package' }, t)
    expect(withPackage.json.error).toMatchObject({
      code: 'already_booked',
      bookingId: first.json.bookingId,
    })
  })

  it('replays the first answer to its own key after a refusal on other terms', async () => {
    const h = setup()
    const { kids, slotId } = await groupSession(h)
    const t = await h.student('a')
    const send = (body: object, key: string) =>
      h.call('POST', '/bookings', body, t, { 'Idempotency-Key': key })
    const first = await send(byWechat(slotId, kids.id), 'book-1')
    expect(first.status).toBe(201)
    const other = await send(byWechat(slotId, kids.id, 1), 'book-2')
    expect(other.json.error.code).toBe('already_booked')
    const replay = await send(byWechat(slotId, kids.id), 'book-1')
    expect(replay.status).toBe(201)
    expect(replay.json).toEqual(first.json)
    expect(h.db.select().from(bookings).all()).toHaveLength(1)
  })

  it('marks the student’s own held or booked session in the slots, not as bookable', async () => {
    const h = setup({ now: '2026-10-25T02:00:00Z' })
    const { kids, slotId } = await groupSession(h)
    const t = await h.student('a')
    const other = await h.student('b')
    const list = async (token: string) =>
      (await h.call('GET', `/slots?date=2026-10-26&lessonTypeId=${kids.id}`, undefined, token))
        .json[0]
    expect(await list(t)).toMatchObject({ id: slotId, available: true, mine: null })
    const held = await h.call('POST', '/bookings', byWechat(slotId, kids.id), t)
    expect(await list(t)).toMatchObject({
      id: slotId,
      available: false,
      seatsLeft: 3,
      mine: { bookingId: held.json.bookingId, status: 'pending_payment' },
    })
    // Others still see the free seats.
    expect(await list(other)).toMatchObject({ available: true, seatsLeft: 3, mine: null })
    // Nor is it an open day for the student.
    const days = await h.call('GET', `/slots/open-days?lessonTypeId=${kids.id}`, undefined, t)
    expect(days.json).not.toContain('2026-10-26')
    await h.fakePay(held.json.orderId)
    expect(await list(t)).toMatchObject({
      available: false,
      mine: { bookingId: held.json.bookingId, status: 'confirmed' },
    })
    // A cancelled seat is the student's no more.
    await h.call('POST', `/bookings/${held.json.bookingId}/cancel`, {}, t)
    expect(await list(t)).toMatchObject({ available: true, mine: null })
  })

  it('offers a session again once the student’s hold of it ran out', async () => {
    const h = setup({ now: '2026-10-25T02:00:00Z' })
    const { kids, slotId } = await groupSession(h)
    const t = await h.student('a')
    const held = await h.call('POST', '/bookings', byWechat(slotId, kids.id), t)
    // Past the payment time, before the sweeper closed it: booking again books afresh.
    const order = h.db.select().from(orders).get()
    h.clock.now = new Date((order?.expiresAt?.getTime() ?? 0) + 1000)
    const res = await h.call('GET', `/slots?date=2026-10-26&lessonTypeId=${kids.id}`, undefined, t)
    expect(res.json[0]).toMatchObject({ id: slotId, available: true, mine: null })
    const again = await h.call('POST', '/bookings', byWechat(slotId, kids.id), t)
    expect(again.status).toBe(201)
    expect(again.json.bookingId).not.toBe(held.json.bookingId)
  })
})
