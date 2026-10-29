import { venueInstant } from '@rs/shared'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { immediate } from './db/client'
import {
  bookings,
  coaches,
  lessonTypes,
  orders,
  packageProducts,
  packages,
  refunds,
  students,
} from './db/schema'
import { GatewayError, type RefundInput } from './pay/gateway'
import { cancelBooking } from './services/bookings'
import { applyPayment, closeOrder, expireOrders } from './services/orders'
import { createRefund, settleRefund, sweepRefunds } from './services/refunds'
import { type Harness, setup } from './test/harness'

const at = (date: string, hhmm: string) =>
  venueInstant(date, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))).toISOString()

/** A student with a paid private lesson, and the refund calls WeChat Pay received. */
async function paidLesson(h: Harness) {
  const { coach, lesson } = h.seed()
  const slot = h.slot(coach.id)
  const t = await h.student('b')
  await h.call('PUT', '/me', { name: '小红' }, t)
  const b = await h.call('POST', '/bookings', { slotId: slot.id, lessonTypeId: lesson.id }, t)
  await h.fakePay(b.json.orderId)
  const sent: RefundInput[] = []
  const real = h.gateway.refund.bind(h.gateway)
  h.gateway.refund = (input) => {
    sent.push(input)
    return real(input)
  }
  return { bookingId: b.json.bookingId as number, orderId: b.json.orderId as number, sent }
}

const onlyRefund = (h: Harness) => {
  const all = h.db.select().from(refunds).all()
  expect(all).toHaveLength(1)
  return all[0] as typeof refunds.$inferSelect
}

const later = (h: Harness, minutes: number) => {
  h.clock.now = new Date(h.clock.now.getTime() + minutes * 60_000)
}

describe('refunds whose outcome is unknown', () => {
  it('keeps a refund pending when WeChat Pay took it but its answer cannot be verified', async () => {
    const h = setup()
    const { bookingId, sent } = await paidLesson(h)
    const real = h.gateway.refund
    h.gateway.refund = async (input) => {
      await real(input)
      throw new GatewayError('unreadable response: bad signature', 'BAD_RESPONSE', 200)
    }
    await cancelBooking(h.deps, bookingId, 'venue', { reason: 'x' })
    expect(onlyRefund(h).status).toBe('pending')
    // The sweeper asks about the same number and records the success without sending again.
    later(h, 2)
    await sweepRefunds(h.deps)
    expect(onlyRefund(h).status).toBe('succeeded')
    expect(sent).toHaveLength(1)
  })

  it('sends a stuck pending refund only when WeChat Pay never got it, under the same number', async () => {
    const h = setup()
    const { bookingId, sent } = await paidLesson(h)
    const real = h.gateway.refund
    h.gateway.refund = async () => {
      throw new GatewayError('network error: reset', 'NETWORK', 0)
    }
    await cancelBooking(h.deps, bookingId, 'venue', { reason: 'x' })
    const pending = onlyRefund(h)
    expect(pending.status).toBe('pending')
    h.gateway.refund = real
    later(h, 2)
    await sweepRefunds(h.deps)
    expect(onlyRefund(h)).toMatchObject({ status: 'succeeded', outRefundNo: pending.outRefundNo })
    expect(sent.map((r) => r.outRefundNo)).toEqual([pending.outRefundNo])
  })

  it('applies a later success to a refund marked failed under the same number', async () => {
    const h = setup()
    const { bookingId } = await paidLesson(h)
    h.gateway.refund = async () => {
      throw new GatewayError('基本账户余额不足', 'NOT_ENOUGH', 403)
    }
    await cancelBooking(h.deps, bookingId, 'venue', { reason: 'x' })
    const failed = onlyRefund(h)
    expect(failed.status).toBe('failed')
    settleRefund(h.deps, failed.outRefundNo, { status: 'succeeded', refundId: 'r1' })
    expect(onlyRefund(h)).toMatchObject({
      status: 'succeeded',
      providerRefundId: 'r1',
      failure: null,
    })
    // A late failure never undoes a success.
    settleRefund(h.deps, failed.outRefundNo, { status: 'failed', reason: 'CLOSED' })
    expect(onlyRefund(h).status).toBe('succeeded')
  })

  it('keeps an ABNORMAL refund open with a note for staff until it settles', async () => {
    const h = setup()
    const { bookingId } = await paidLesson(h)
    h.gateway.refund = async () => ({ status: 'processing', refundId: 'r1', abnormal: true })
    await cancelBooking(h.deps, bookingId, 'venue', { reason: 'x' })
    const row = onlyRefund(h)
    expect(row.status).toBe('processing')
    expect(row.failure).toMatch(/商户平台/)
    expect(row.abnormal).toBe(true)
    // Staff see it on the overview and can list it.
    const admin = await h.admin()
    const summary = async () =>
      (await h.call('GET', '/admin/summary', undefined, admin)).json.abnormalRefunds
    expect(await summary()).toBe(1)
    const listed = await h.call('GET', '/admin/refunds?abnormal=1', undefined, admin)
    expect(listed.json.map((r: { id: number }) => r.id)).toEqual([row.id])
    settleRefund(h.deps, row.outRefundNo, { status: 'succeeded', refundId: 'r1' })
    expect(onlyRefund(h)).toMatchObject({ status: 'succeeded', failure: null, abnormal: false })
    expect(await summary()).toBe(0)
  })

  it('warns when a refund marked failed went through on top of its replacement', async () => {
    const h = setup()
    const { bookingId, orderId } = await paidLesson(h)
    h.gateway.refundMode = 'fail'
    await cancelBooking(h.deps, bookingId, 'venue', { reason: 'x' })
    const failed = onlyRefund(h)
    // Staff refunded the order again another way meanwhile.
    immediate(h.db, (tx) =>
      createRefund(tx, h.deps.now(), { orderId, amount: 20000, reason: '手工退款' }),
    )
    h.db.update(refunds).set({ status: 'succeeded' }).where(eq(refunds.reason, '手工退款')).run()
    settleRefund(h.deps, failed.outRefundNo, { status: 'succeeded', refundId: 'r1' })
    const settled = h.db.select().from(refunds).where(eq(refunds.id, failed.id)).get()
    expect(settled?.status).toBe('succeeded')
    expect(settled?.failure).toMatch(/超过实付金额/)
    expect(h.logs.map((l) => l.message)).toContain(
      'refund settled after a replacement, order over-refunded',
    )
  })
})

describe('retrying a failed refund', () => {
  it('records a refund that went through after all instead of refunding twice', async () => {
    const h = setup()
    const { bookingId, sent } = await paidLesson(h)
    // WeChat Pay accepted it, but the refusal-looking answer marked it failed here.
    const real = h.gateway.refund
    h.gateway.refund = async (input) => {
      await real(input)
      throw new GatewayError('bad request', 'INVALID_REQUEST', 400)
    }
    await cancelBooking(h.deps, bookingId, 'venue', { reason: 'x' })
    const failed = onlyRefund(h)
    expect(failed.status).toBe('failed')
    h.gateway.refund = real
    const admin = await h.admin()
    const retry = await h.call('POST', `/admin/refunds/${failed.id}/retry`, undefined, admin)
    expect(retry.status).toBe(200)
    expect(retry.json).toMatchObject({ status: 'succeeded', resent: false })
    expect(onlyRefund(h)).toMatchObject({ status: 'succeeded', outRefundNo: failed.outRefundNo })
    expect(sent).toHaveLength(1)
    // Logged as a status update, not as a retry.
    const actions = (await h.call('GET', '/admin/actions', undefined, admin)).json
    expect(actions.map((a: { action: string }) => a.action)).toEqual(['refund.synced'])
  })

  it('logs a retry that sends the refund again as a retry', async () => {
    const h = setup()
    const { bookingId } = await paidLesson(h)
    h.gateway.refundMode = 'fail'
    await cancelBooking(h.deps, bookingId, 'venue', { reason: 'x' })
    h.gateway.refundMode = 'succeeded'
    const admin = await h.admin()
    const retry = await h.call('POST', `/admin/refunds/${onlyRefund(h).id}/retry`, undefined, admin)
    expect(retry.json).toMatchObject({ status: 'succeeded', resent: true })
    const actions = (await h.call('GET', '/admin/actions', undefined, admin)).json
    expect(actions.map((a: { action: string }) => a.action)).toEqual(['refund.retry'])
  })

  it('refuses to send a failed refund again when the order has no room left for it', async () => {
    const h = setup()
    const { bookingId, orderId } = await paidLesson(h)
    h.gateway.refundMode = 'fail'
    await cancelBooking(h.deps, bookingId, 'venue', { reason: 'x' })
    const failed = onlyRefund(h)
    immediate(h.db, (tx) =>
      createRefund(tx, h.deps.now(), { orderId, amount: 15000, reason: '手工退款' }),
    )
    h.gateway.refundMode = 'succeeded'
    const admin = await h.admin()
    const retry = await h.call('POST', `/admin/refunds/${failed.id}/retry`, undefined, admin)
    expect(retry.status).toBe(409)
    expect(retry.json.error.code).toBe('refund_too_large')
    expect(h.db.select().from(refunds).where(eq(refunds.id, failed.id)).get()?.status).toBe(
      'failed',
    )
  })

  it('sends again under the same number one WeChat Pay never received', async () => {
    const h = setup()
    const { bookingId, sent } = await paidLesson(h)
    const real = h.gateway.refund
    h.gateway.refund = async (input) => {
      sent.push(input)
      throw new GatewayError('bad request', 'INVALID_REQUEST', 400)
    }
    await cancelBooking(h.deps, bookingId, 'venue', { reason: 'x' })
    const failed = onlyRefund(h)
    h.gateway.refund = real
    const admin = await h.admin()
    await h.call('POST', `/admin/refunds/${failed.id}/retry`, undefined, admin)
    expect(onlyRefund(h)).toMatchObject({ status: 'succeeded', outRefundNo: failed.outRefundNo })
  })

  it('leaves the refund as it is when WeChat Pay cannot be asked', async () => {
    const h = setup()
    const { bookingId } = await paidLesson(h)
    h.gateway.refundMode = 'fail'
    await cancelBooking(h.deps, bookingId, 'venue', { reason: 'x' })
    const failed = onlyRefund(h)
    h.gateway.queryRefund = async () => {
      throw new GatewayError('network error', 'NETWORK', 0)
    }
    const admin = await h.admin()
    const retry = await h.call('POST', `/admin/refunds/${failed.id}/retry`, undefined, admin)
    expect(retry.status).toBe(502)
    expect(onlyRefund(h)).toMatchObject({ status: 'failed', outRefundNo: failed.outRefundNo })
  })
})

describe('package terms', () => {
  async function product(h: Harness) {
    const { coach, lesson } = h.seed()
    const p = h.db
      .insert(packageProducts)
      .values({
        name: '10次',
        lessonTypeId: lesson.id,
        coachIds: [coach.id],
        lessonCount: 10,
        price: 100000,
        validityDays: 90,
      })
      .returning()
      .get()
    const t = await h.student('a')
    await h.call('PUT', '/me', { name: '小明' }, t)
    const shown = {
      lessonTypeId: p.lessonTypeId,
      coachIds: p.coachIds,
      lessonCount: p.lessonCount,
      validityDays: p.validityDays,
    }
    return { p, t, shown, coach }
  }

  it('refuses a purchase when what the package grants changed since it was shown', async () => {
    const h = setup()
    const { p, t, shown } = await product(h)
    h.db
      .update(packageProducts)
      .set({ lessonCount: 5, validityDays: 7 })
      .where(eq(packageProducts.id, p.id))
      .run()
    const res = await h.call(
      'POST',
      '/packages/purchase',
      { productId: p.id, expectedPrice: 100000, expectedTerms: shown },
      t,
    )
    expect(res.status).toBe(409)
    expect(res.json.error.code).toBe('package_changed')
    expect(h.db.select().from(orders).all()).toEqual([])
    // With the terms now shown it goes through.
    const ok = await h.call(
      'POST',
      '/packages/purchase',
      {
        productId: p.id,
        expectedPrice: 100000,
        expectedTerms: { ...shown, lessonCount: 5, validityDays: 7 },
      },
      t,
    )
    expect(ok.status).toBe(201)
  })

  it('makes the package from the terms bought, not the product as it is at payment', async () => {
    const h = setup()
    const { p, t, shown } = await product(h)
    const res = await h.call(
      'POST',
      '/packages/purchase',
      {
        productId: p.id,
        expectedPrice: 100000,
        expectedTerms: { ...shown, coachIds: [...shown.coachIds].reverse() },
      },
      t,
    )
    expect(res.status).toBe(201)
    h.db
      .update(packageProducts)
      .set({ lessonCount: 5, validityDays: 7, coachIds: [], name: '改名' })
      .where(eq(packageProducts.id, p.id))
      .run()
    await h.fakePay(res.json.orderId)
    const pkg = h.db.select().from(packages).get()
    expect(pkg).toMatchObject({
      name: '10次',
      lessonsPurchased: 10,
      lessonsRemaining: 10,
      coachIds: shown.coachIds,
      productId: p.id,
    })
    // 90 days from the payment, to the end of that venue day.
    expect(pkg?.expiresAt.toISOString()).toBe(venueInstant('2027-01-21', 24 * 60).toISOString())
  })

  it('still makes a package for an order placed before terms were kept', async () => {
    const h = setup()
    const { p, t } = await product(h)
    const res = await h.call('POST', '/packages/purchase', { productId: p.id }, t)
    h.db.update(orders).set({ packageTerms: null }).where(eq(orders.id, res.json.orderId)).run()
    await h.fakePay(res.json.orderId)
    expect(h.db.select().from(packages).get()?.lessonsPurchased).toBe(10)
  })

  it('refuses a front-desk sale when the package changed since the dialog loaded', async () => {
    const h = setup()
    const { p, shown } = await product(h)
    const admin = await h.admin()
    const student = h.db.select().from(students).get()?.id
    const sale = (expectedTerms: typeof shown) =>
      h.call(
        'POST',
        '/admin/packages/offline-sale',
        { studentId: student, productId: p.id, amount: 100000, method: 'cash', expectedTerms },
        admin,
      )
    const refused = await sale({ ...shown, lessonCount: 12 })
    expect(refused.status).toBe(409)
    expect(refused.json.error.code).toBe('package_changed')
    const ok = await sale(shown)
    expect(ok.status).toBe(201)
    expect(h.db.select().from(orders).get()?.packageTerms).toMatchObject({ lessonCount: 10 })
  })
})

describe('a cancel while WeChat Pay is placing the order', () => {
  it('gives no cashier for the closed order and closes it at WeChat Pay', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const slot = h.slot(coach.id)
    const t = await h.student('c')
    await h.call('PUT', '/me', { name: '小刚' }, t)
    const real = h.gateway.createOrder.bind(h.gateway)
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    h.gateway.createOrder = async (i) => {
      await gate
      return real(i)
    }
    const booking = h.call('POST', '/bookings', { slotId: slot.id, lessonTypeId: lesson.id }, t)
    await new Promise((r) => setTimeout(r, 20))
    const bk = h.db.select().from(bookings).get()
    const cancel = await h.call('POST', `/bookings/${bk?.id}/cancel`, undefined, t)
    expect(cancel.status).toBe(200)
    release()
    const res = await booking
    expect(res.status).toBe(409)
    expect(res.json.error.code).toBe('order_not_payable')
    const order = h.db.select().from(orders).get()
    expect(order).toMatchObject({ status: 'closed', prepayId: null })
    expect(h.gateway.orders.get(order?.outTradeNo ?? '')?.state.state).toBe('closed')
    expect((await h.fakePay(order?.id ?? 0)).status).not.toBe(204)
    expect(h.db.select().from(refunds).all()).toEqual([])
  })
})

describe('late payment revival', () => {
  async function expiredHold(h: Harness) {
    const { coach, lesson } = h.seed()
    h.hours(coach.id, [{ weekday: 0, from: '09:00', to: '13:00' }])
    const a = await h.student('a')
    const ra = await h.call(
      'POST',
      '/bookings',
      { coachId: coach.id, startsAt: at('2026-10-25', '10:00'), lessonTypeId: lesson.id },
      a,
    )
    expect(ra.status).toBe(201)
    later(h, 60)
    await expireOrders(h.deps)
    const order = h.db.select().from(orders).where(eq(orders.bookingId, ra.json.bookingId)).get()
    const payLate = () =>
      applyPayment(h.deps, order?.outTradeNo ?? '', {
        state: 'paid',
        amount: order?.amount ?? 0,
        paidAt: h.deps.now(),
        transactionId: 't1',
      })
    const status = () =>
      h.db.select().from(bookings).where(eq(bookings.id, ra.json.bookingId)).get()?.status
    return { coach, lesson, payLate, status }
  }

  it('revives a hold that ran out when the time is still free', async () => {
    const h = setup()
    const { payLate, status } = await expiredHold(h)
    expect(status()).toBe('expired')
    payLate()
    expect(status()).toBe('confirmed')
    expect(h.db.select().from(refunds).all()).toEqual([])
  })

  it('refunds instead of reviving a lesson inside the buffer of one booked meanwhile', async () => {
    const h = setup()
    h.settings((s) => {
      s.booking.bufferMinutes = 30
    })
    const { coach, lesson, payLate, status } = await expiredHold(h)
    const b = await h.student('b')
    const rb = await h.call(
      'POST',
      '/bookings',
      { coachId: coach.id, startsAt: at('2026-10-25', '11:00'), lessonTypeId: lesson.id },
      b,
    )
    expect(rb.status).toBe(201)
    payLate()
    expect(status()).toBe('expired')
    expect(onlyRefund(h).reason).toBe('时段已被预约，自动退款')
  })

  it('refunds instead of reviving when the coach was turned off', async () => {
    const h = setup()
    const { coach, payLate, status } = await expiredHold(h)
    h.db.update(coaches).set({ active: false }).where(eq(coaches.id, coach.id)).run()
    payLate()
    expect(status()).toBe('expired')
    expect(onlyRefund(h).amount).toBe(20000)
  })

  it('refunds instead of reviving when the lesson type was turned off', async () => {
    const h = setup()
    const { lesson, payLate, status } = await expiredHold(h)
    h.db.update(lessonTypes).set({ active: false }).where(eq(lessonTypes.id, lesson.id)).run()
    payLate()
    expect(status()).toBe('expired')
    onlyRefund(h)
  })

  it('refunds instead of reviving a time 排班 no longer offers', async () => {
    const h = setup()
    const { coach, payLate, status } = await expiredHold(h)
    const { coachHours } = await import('./db/schema')
    h.db.delete(coachHours).where(eq(coachHours.coachId, coach.id)).run()
    payLate()
    expect(status()).toBe('expired')
    onlyRefund(h)
  })
})

describe('closing an order WeChat Pay reports oddly', () => {
  it('reports an order flagged for staff as closed, not paid', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const t = await h.student('a')
    const b = await h.call(
      'POST',
      '/bookings',
      { slotId: h.slot(coach.id).id, lessonTypeId: lesson.id },
      t,
    )
    const order = h.db.select().from(orders).get()
    // Paid at WeChat Pay with another amount, and the callback lost.
    h.gateway.pay(order?.outTradeNo ?? '', h.deps.now(), 'mismatch')
    expect(await closeOrder(h.deps, b.json.orderId)).toBe('closed')
    expect(h.db.select().from(orders).get()).toMatchObject({
      status: 'closed',
      anomaly: 'amount_mismatch',
      anomalyAmount: 20001,
    })
    expect(h.db.select().from(bookings).get()?.status).toBe('expired')
  })
})

describe('fake gateway modes for QA', () => {
  it('pays oddly and refunds as ABNORMAL or with an unknown outcome on request', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const t = await h.student('a')
    const book = (hour: number) =>
      h.call(
        'POST',
        '/bookings',
        { slotId: h.slot(coach.id, '2026-10-25', hour).id, lessonTypeId: lesson.id },
        t,
      )
    const a = await book(10)
    expect((await h.fakePay(a.json.orderId, '?as=refunded')).status).toBe(204)
    expect(h.db.select().from(orders).where(eq(orders.id, a.json.orderId)).get()?.anomaly).toBe(
      'refunded',
    )
    const b = await book(12)
    await h.fakePay(b.json.orderId, '?as=mismatch')
    expect(h.db.select().from(orders).where(eq(orders.id, b.json.orderId)).get()?.anomaly).toBe(
      'amount_mismatch',
    )
    // Switching refund modes needs a session.
    expect((await h.call('POST', '/dev/fake-refund-mode', { mode: 'abnormal' })).status).toBe(401)
    expect((await h.call('POST', '/dev/fake-refund-mode', { mode: 'odd' }, t)).status).toBe(400)
    expect((await h.call('POST', '/dev/fake-refund-mode', { mode: 'abnormal' }, t)).status).toBe(
      204,
    )
    const c = await book(14)
    await h.fakePay(c.json.orderId)
    await cancelBooking(h.deps, c.json.bookingId, 'venue', { reason: 'x' })
    expect(onlyRefund(h)).toMatchObject({ status: 'processing', abnormal: true })
    await h.call('POST', '/dev/fake-refund-mode', { mode: 'unknown' }, t)
    const d = await book(16)
    await h.fakePay(d.json.orderId)
    await cancelBooking(h.deps, d.json.bookingId, 'venue', { reason: 'x' })
    const unknown = h.db.select().from(refunds).where(eq(refunds.bookingId, d.json.bookingId)).get()
    expect(unknown?.status).toBe('pending')
    later(h, 2)
    await sweepRefunds(h.deps)
    expect(
      h.db.select().from(refunds).where(eq(refunds.bookingId, d.json.bookingId)).get()?.status,
    ).toBe('succeeded')
  })
})
