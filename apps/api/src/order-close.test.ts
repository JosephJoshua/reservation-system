import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { bookings, orders } from './db/schema'
import { GatewayError } from './pay/gateway'
import { startCoachSession } from './services/auth'
import { type Harness, setup } from './test/harness'

const later = (h: Harness, minutes: number) => {
  h.clock.now = new Date(h.clock.now.getTime() + minutes * 60_000)
}

/** An unpaid booking whose order was placed at WeChat Pay. */
async function unpaid(h: Harness) {
  const { coach, lesson } = h.seed()
  const slot = h.slot(coach.id)
  const t = await h.student('a')
  const b = await h.call('POST', '/bookings', { slotId: slot.id, lessonTypeId: lesson.id }, t)
  expect(b.json.status).toBe('pending_payment')
  return { coach, lesson, slot, t, b: b.json as { bookingId: number; orderId: number } }
}

describe('cancelling an unpaid booking while WeChat Pay cannot be reached', () => {
  it('answers 502 to the student, the desk and the coach, and keeps the hold', async () => {
    const h = setup()
    const { coach, t, b } = await unpaid(h)
    vi.spyOn(h.gateway, 'closeOrder').mockRejectedValue(
      new GatewayError('timeout', 'NETWORK_ERROR'),
    )
    const expected = {
      status: 502,
      json: { error: { code: 'payment_unavailable', message: '微信支付暂时不可用，请稍后再试' } },
    }
    expect(await h.call('POST', `/bookings/${b.bookingId}/cancel`, {}, t)).toMatchObject(expected)
    const admin = await h.admin()
    expect(
      await h.call('POST', `/admin/bookings/${b.bookingId}/cancel`, { reason: '场地维修' }, admin),
    ).toMatchObject(expected)
    h.db.$client.prepare('update coaches set openid = ? where id = ?').run('c-openid', coach.id)
    const ct = startCoachSession(h.deps, coach.id)
    expect(
      await h.call('POST', `/coach/lessons/${b.bookingId}/cancel`, { reason: '生病' }, ct),
    ).toMatchObject(expected)
    expect(h.db.select().from(bookings).get()?.status).toBe('pending_payment')
    expect(h.db.select().from(orders).get()?.status).toBe('pending')
    expect(h.logs.some((l) => l.message === 'unhandled error')).toBe(false)
  })
})

describe('booking the same time again after the payment time ran out', () => {
  it('closes the lapsed hold and books afresh before the sweeper gets to it', async () => {
    const h = setup()
    const { slot, lesson, t, b } = await unpaid(h)
    later(h, 11)
    const again = await h.call('POST', '/bookings', { slotId: slot.id, lessonTypeId: lesson.id }, t)
    expect(again.status).toBe(201)
    expect(again.json.orderId).not.toBe(b.orderId)
    expect(again.json.bookingId).not.toBe(b.bookingId)
    expect(again.json.payment).toBeTruthy()
    const old = h.db.select().from(bookings).where(eq(bookings.id, b.bookingId)).get()
    expect(old?.status).toBe('expired')
    expect(h.db.select().from(orders).where(eq(orders.id, b.orderId)).get()?.status).toBe('closed')
  })

  it('returns the booking as made when its payment landed in the last moment', async () => {
    const h = setup()
    const { slot, lesson, t, b } = await unpaid(h)
    later(h, 11)
    const order = h.db.select().from(orders).where(eq(orders.id, b.orderId)).get()
    h.gateway.pay(order?.outTradeNo ?? '', h.deps.now())
    const again = await h.call('POST', '/bookings', { slotId: slot.id, lessonTypeId: lesson.id }, t)
    expect(again.status).toBe(201)
    expect(again.json).toMatchObject({ bookingId: b.bookingId, status: 'confirmed' })
    expect(h.db.select().from(orders).get()?.status).toBe('paid')
  })

  it('closes the lapsed order when the student tries to pay it, freeing the time', async () => {
    const h = setup()
    const { slot, lesson, t, b } = await unpaid(h)
    later(h, 11)
    const pay = await h.call('POST', `/orders/${b.orderId}/payment`, {}, t)
    expect(pay.json.error.code).toBe('order_not_payable')
    expect(h.db.select().from(orders).where(eq(orders.id, b.orderId)).get()?.status).toBe('closed')
    const again = await h.call('POST', '/bookings', { slotId: slot.id, lessonTypeId: lesson.id }, t)
    expect(again.status).toBe(201)
    expect(again.json.status).toBe('pending_payment')
  })

  it('tells a student who paid in the last moment that it is paid', async () => {
    const h = setup()
    const { t, b } = await unpaid(h)
    later(h, 11)
    const order = h.db.select().from(orders).where(eq(orders.id, b.orderId)).get()
    // Paid, and the order's prepay id already lost to a restart before the query: WeChat Pay's
    // close answers that it is paid.
    h.gateway.pay(order?.outTradeNo ?? '', h.deps.now())
    vi.spyOn(h.gateway, 'queryOrder').mockRejectedValue(new GatewayError('down', 'SYSTEM_ERROR'))
    const pay = await h.call('POST', `/orders/${b.orderId}/payment`, {}, t)
    expect(pay.json.error.code).toBe('order_paid')
  })
})
