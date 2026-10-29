// Payments whose callback is late or lost, as when the app is closed mid-payment, and repeats of
// requests whose answer never reached the phone.
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { orders, packageProducts, refunds } from './db/schema'
import { type Harness, setup } from './test/harness'

/** Pays an order at the fake WeChat Pay without telling the API, like a lost callback. */
function payWithoutCallback(h: Harness, orderId: number) {
  return h.fakePay(orderId, '?callback=lost')
}

async function pendingBooking(h: Harness) {
  const { coach, lesson } = h.seed()
  const slot = h.slot(coach.id)
  const t = await h.student('a')
  const res = await h.call('POST', '/bookings', { slotId: slot.id, lessonTypeId: lesson.id }, t)
  expect(res.json.status).toBe('pending_payment')
  return { t, slot, lesson, bookingId: res.json.bookingId, orderId: res.json.orderId }
}

function product(h: Harness, lessonTypeId: number) {
  return h.db
    .insert(packageProducts)
    .values({ name: '10 节课', lessonTypeId, lessonCount: 10, price: 180000, validityDays: 90 })
    .returning()
    .get()
}

describe('a payment whose callback was lost', () => {
  it('shows the booking as paid when the student opens it again', async () => {
    const h = setup()
    const { t, bookingId, orderId } = await pendingBooking(h)
    await payWithoutCallback(h, orderId)

    const detail = await h.call('GET', `/bookings/${bookingId}`, undefined, t)
    expect(detail.json.status).toBe('confirmed')
    const order = h.db.select().from(orders).where(eq(orders.id, orderId)).get()
    expect(order?.status).toBe('paid')
  })

  it('shows the booking as paid in the upcoming list', async () => {
    const h = setup()
    const { t, bookingId, orderId } = await pendingBooking(h)
    await payWithoutCallback(h, orderId)

    const list = await h.call('GET', '/bookings', undefined, t)
    expect(list.json.find((b: { id: number }) => b.id === bookingId).status).toBe('confirmed')
  })

  it('answers order_paid instead of opening the cashier again', async () => {
    const h = setup()
    const { t, bookingId, orderId } = await pendingBooking(h)
    await payWithoutCallback(h, orderId)

    const res = await h.call('POST', `/orders/${orderId}/payment`, undefined, t)
    expect(res.status).toBe(409)
    expect(res.json.error.code).toBe('order_paid')
    expect((await h.call('GET', `/bookings/${bookingId}`, undefined, t)).json.status).toBe(
      'confirmed',
    )
  })

  it('answers order_paid for an order the callback already settled', async () => {
    const h = setup()
    const { t, orderId } = await pendingBooking(h)
    await h.fakePay(orderId)

    const res = await h.call('POST', `/orders/${orderId}/payment`, undefined, t)
    expect(res.json.error.code).toBe('order_paid')
  })

  it('gives a repeated booking request no cashier once it is paid', async () => {
    const h = setup()
    const { t, slot, lesson, bookingId, orderId } = await pendingBooking(h)
    await payWithoutCallback(h, orderId)

    const again = await h.call('POST', '/bookings', { slotId: slot.id, lessonTypeId: lesson.id }, t)
    expect(again.status).toBe(201)
    expect(again.json).toMatchObject({ bookingId, payment: null })
    expect((await h.call('GET', `/bookings/${bookingId}`, undefined, t)).json.status).toBe(
      'confirmed',
    )
    expect(h.db.select().from(orders).all()).toHaveLength(1)
  })

  it('shows a package paid without a callback, and a repeated purchase does not charge again', async () => {
    const h = setup()
    const { lesson } = h.seed()
    const p = product(h, lesson.id)
    const t = await h.student('a')
    const first = await h.call('POST', '/packages/purchase', { productId: p.id }, t)
    await payWithoutCallback(h, first.json.orderId)

    const again = await h.call('POST', '/packages/purchase', { productId: p.id }, t)
    expect(again.json).toMatchObject({ orderId: first.json.orderId, payment: null })
    const packages = (await h.call('GET', '/packages', undefined, t)).json
    expect(packages).toHaveLength(1)
    expect(packages[0]).toMatchObject({ lessonsRemaining: 10, status: 'active' })
    expect(h.db.select().from(orders).all()).toHaveLength(1)
  })

  it('shows a package paid without a callback on the packages list alone', async () => {
    const h = setup()
    const { lesson } = h.seed()
    const p = product(h, lesson.id)
    const t = await h.student('a')
    const res = await h.call('POST', '/packages/purchase', { productId: p.id }, t)
    expect((await h.call('GET', '/packages', undefined, t)).json).toHaveLength(0)
    // The page is shown again a little later, once the student has paid.
    h.clock.now = new Date(h.clock.now.getTime() + 15_000)
    await payWithoutCallback(h, res.json.orderId)
    expect((await h.call('GET', '/packages', undefined, t)).json).toHaveLength(1)
  })

  it('will not reopen the cashier for a booking cancelled on another phone', async () => {
    const h = setup()
    const { t, bookingId, orderId } = await pendingBooking(h)
    // The cashier was already open on one phone; the other cancels, which closes the order.
    expect((await h.call('POST', `/bookings/${bookingId}/cancel`, {}, t)).json.status).toBe(
      'cancelled',
    )
    const res = await h.call('POST', `/orders/${orderId}/payment`, undefined, t)
    expect(res.json.error.code).toBe('order_not_payable')
    expect(h.db.select().from(refunds).all()).toHaveLength(0)
  })

  it('keeps going when WeChat Pay cannot be asked', async () => {
    const h = setup()
    const { t, bookingId, orderId } = await pendingBooking(h)
    h.gateway.queryOrder = async () => {
      throw new Error('network down')
    }
    expect((await h.call('GET', `/bookings/${bookingId}`, undefined, t)).json.status).toBe(
      'pending_payment',
    )
    const res = await h.call('POST', `/orders/${orderId}/payment`, undefined, t)
    expect(res.status).toBe(200)
    expect(res.json.package).toMatch(/^prepay_id=/)
  })

  it('answers within a few seconds while WeChat Pay hangs', async () => {
    const h = setup()
    const { t, bookingId } = await pendingBooking(h)
    h.gateway.queryOrder = () => new Promise(() => {})
    const started = Date.now()
    const res = await h.call('GET', `/bookings/${bookingId}`, undefined, t)
    expect(res.json.status).toBe('pending_payment')
    expect(Date.now() - started).toBeLessThan(5000)
  })
})
