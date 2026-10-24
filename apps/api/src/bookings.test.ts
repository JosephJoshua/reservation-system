import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
  bookings,
  coaches,
  coachLessonTypes,
  orders,
  packageProducts,
  refunds,
  slots,
} from './db/schema'
import { sweep } from './sweeper'
import { type Harness, setup } from './test/harness'

async function book(
  h: Harness,
  token: string,
  slotId: number,
  lessonTypeId: number,
  payWith?: string,
) {
  return h.call('POST', '/bookings', { slotId, lessonTypeId, payWith }, token)
}

async function pay(h: Harness, orderId: number) {
  return h.call('POST', `/dev/fake-pay/${orderId}`)
}

describe('booking one slot concurrently', () => {
  it('lets exactly one of many students hold a slot', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const slot = h.slot(coach.id)
    const tokens = await Promise.all(Array.from({ length: 20 }, (_, i) => h.student(`s${i}`)))
    const results = await Promise.all(tokens.map((t) => book(h, t, slot.id, lesson.id)))
    expect(results.filter((r) => r.status === 201)).toHaveLength(1)
    const losers = results.filter((r) => r.status !== 201)
    expect(losers).toHaveLength(19)
    for (const r of losers) {
      expect(r.status).toBe(409)
      expect(r.json.error.code).toBe('slot_taken')
    }
    expect(h.db.select().from(bookings).all()).toHaveLength(1)
    expect(h.db.select().from(orders).all()).toHaveLength(1)
  })

  it('treats a double tap as one booking', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const slot = h.slot(coach.id)
    const t = await h.student('a')
    const [a, b] = await Promise.all([
      book(h, t, slot.id, lesson.id),
      book(h, t, slot.id, lesson.id),
    ])
    // The second tap gets the same booking and order back, not "slot taken" by themself.
    expect([a.status, b.status]).toEqual([201, 201])
    expect(b.json).toMatchObject({ bookingId: a.json.bookingId, orderId: a.json.orderId })
    expect(b.json.payment.package).toBe(a.json.payment.package)
    expect(h.db.select().from(bookings).all()).toHaveLength(1)
    expect(h.db.select().from(orders).all()).toHaveLength(1)
  })

  it('refuses a second live booking at the database level', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const slot = h.slot(coach.id)
    const t1 = await h.student('a')
    await h.student('b')
    expect((await book(h, t1, slot.id, lesson.id)).status).toBe(201)
    const row = h.db.select().from(bookings).get()
    if (!row) throw new Error('no booking')
    expect(() =>
      h.db
        .insert(bookings)
        .values({ ...row, id: undefined, studentId: 2, status: 'confirmed' })
        .run(),
    ).toThrow(/UNIQUE/)
  })

  it('blocks a student from holding two overlapping lessons', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const { coachLessonTypes, coaches } = await import('./db/schema')
    const other = h.db.insert(coaches).values({ name: '李教练' }).returning().get()
    h.db.insert(coachLessonTypes).values({ coachId: other.id, lessonTypeId: lesson.id }).run()
    const s1 = h.slot(coach.id)
    const s2 = h.slot(other.id)
    const t = await h.student('a')
    expect((await book(h, t, s1.id, lesson.id)).status).toBe(201)
    const res = await book(h, t, s2.id, lesson.id)
    expect(res.json.error.code).toBe('student_clash')
  })
})

describe('pay per class', () => {
  it('confirms the booking only once payment arrives', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const slot = h.slot(coach.id)
    const t = await h.student('a')
    const res = await book(h, t, slot.id, lesson.id)
    expect(res.json.status).toBe('pending_payment')
    expect(res.json.payment.package).toMatch(/^prepay_id=/)
    const orderId = res.json.orderId
    expect((await h.call('GET', `/orders/${orderId}`, undefined, t)).json.status).toBe('pending')

    expect((await pay(h, orderId)).status).toBe(204)
    const status = await h.call('GET', `/orders/${orderId}`, undefined, t)
    expect(status.json).toMatchObject({ status: 'paid', bookingStatus: 'confirmed', amount: 20000 })
    // A repeated callback changes nothing.
    expect((await pay(h, orderId)).status).toBe(204)
    expect(h.db.select().from(refunds).all()).toHaveLength(0)
  })

  it('releases an unpaid slot after the timeout so someone else can book', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const slot = h.slot(coach.id)
    const a = await h.student('a')
    const b = await h.student('b')
    const first = await book(h, a, slot.id, lesson.id)
    expect((await book(h, b, slot.id, lesson.id)).json.error.code).toBe('slot_taken')

    // Timeout is 10 minutes, plus a 2 minute grace before release.
    h.clock.now = new Date(h.clock.now.getTime() + 11 * 60_000)
    await sweep(h.deps)
    expect((await book(h, b, slot.id, lesson.id)).json.error.code).toBe('slot_taken')

    h.clock.now = new Date(h.clock.now.getTime() + 2 * 60_000)
    await sweep(h.deps)
    const booking = h.db.select().from(bookings).where(eq(bookings.id, first.json.bookingId)).get()
    expect(booking?.status).toBe('expired')
    expect(h.gateway.orders.values().next().value?.state.state).toBe('closed')
    expect((await book(h, b, slot.id, lesson.id)).status).toBe(201)
  })

  it('keeps the booking if payment lands during the grace period', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const slot = h.slot(coach.id)
    const a = await h.student('a')
    const res = await book(h, a, slot.id, lesson.id)
    h.clock.now = new Date(h.clock.now.getTime() + 13 * 60_000)
    // Paid at WeChat, callback lost: the sweeper finds it when closing.
    const order = h.db.select().from(orders).get()
    h.gateway.pay(order?.outTradeNo ?? '')
    await sweep(h.deps)
    const booking = h.db.select().from(bookings).where(eq(bookings.id, res.json.bookingId)).get()
    expect(booking?.status).toBe('confirmed')
  })

  it('refunds a payment that arrives after the slot went to someone else', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const slot = h.slot(coach.id)
    const a = await h.student('a')
    const b = await h.student('b')
    const first = await book(h, a, slot.id, lesson.id)
    h.clock.now = new Date(h.clock.now.getTime() + 13 * 60_000)
    // Force the local expiry without telling the fake gateway, as if the close raced the payment.
    h.db.update(orders).set({ status: 'closed' }).run()
    h.db.update(bookings).set({ status: 'expired' }).run()
    expect((await book(h, b, slot.id, lesson.id)).status).toBe(201)

    const outTradeNo =
      h.db.select().from(orders).where(eq(orders.id, first.json.orderId)).get()?.outTradeNo ?? ''
    h.gateway.pay(outTradeNo)
    const { applyPayment } = await import('./services/orders')
    applyPayment(h.deps, outTradeNo, {
      state: 'paid',
      transactionId: 't1',
      paidAt: h.deps.now(),
      amount: 20000,
    })
    await new Promise((r) => setTimeout(r, 10))
    const refund = h.db.select().from(refunds).get()
    expect(refund).toMatchObject({
      amount: 20000,
      status: 'succeeded',
      bookingId: first.json.bookingId,
    })
    const live = h.db.select().from(bookings).where(eq(bookings.status, 'confirmed')).all()
    expect(live).toHaveLength(0)
  })

  it('lets the student cancel before paying, freeing the slot at once', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const slot = h.slot(coach.id)
    const a = await h.student('a')
    const b = await h.student('b')
    const res = await book(h, a, slot.id, lesson.id)
    const cancel = await h.call('POST', `/bookings/${res.json.bookingId}/cancel`, undefined, a)
    expect(cancel.json.status).toBe('cancelled')
    expect((await pay(h, res.json.orderId)).json.error.code).toBe('fake_pay_failed')
    expect((await book(h, b, slot.id, lesson.id)).status).toBe(201)
  })

  it('releases the slot when WeChat Pay refuses the order', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const slot = h.slot(coach.id)
    const a = await h.student('a')
    h.gateway.failCreate = true
    const res = await book(h, a, slot.id, lesson.id)
    expect(res.status).toBe(502)
    h.gateway.failCreate = false
    expect((await book(h, a, slot.id, lesson.id)).status).toBe(201)
  })

  it('requires a package when pay per class is off', async () => {
    const h = setup()
    h.settings((s) => {
      s.payment.perClassEnabled = false
    })
    const { coach, lesson } = h.seed()
    const slot = h.slot(coach.id)
    const a = await h.student('a')
    expect((await book(h, a, slot.id, lesson.id)).json.error.code).toBe('package_required')
    expect(h.db.select().from(bookings).all()).toHaveLength(0)
  })

  it('uses the category price and a running sale', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const { lessonTypes } = await import('./db/schema')
    h.category(coach.id, '主教练', [{ lessonTypeId: lesson.id, price: 30000 }])
    h.db
      .update(lessonTypes)
      .set({
        salePercent: 80,
        saleStartsAt: new Date('2026-10-01T00:00:00Z'),
        saleEndsAt: new Date('2026-11-01T00:00:00Z'),
      })
      .where(eq(lessonTypes.id, lesson.id))
      .run()
    const slot = h.slot(coach.id)
    const a = await h.student('a')
    const catalog = await h.call('GET', '/catalog', undefined, a)
    expect(catalog.json.coaches[0].lessons[0].price).toEqual({ price: 24000, originalPrice: 30000 })
    await book(h, a, slot.id, lesson.id)
    expect(h.db.select().from(orders).get()?.amount).toBe(24000)
  })
  it('refuses to charge a price other than the one the student saw', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const { lessonTypes } = await import('./db/schema')
    const slot = h.slot(coach.id)
    const a = await h.student('a')
    const quoted = (
      await h.call(
        'GET',
        `/bookings/quote?slotId=${slot.id}&lessonTypeId=${lesson.id}`,
        undefined,
        a,
      )
    ).json.price.price
    h.db
      .update(lessonTypes)
      .set({ price: quoted + 3300 })
      .where(eq(lessonTypes.id, lesson.id))
      .run()
    const body = {
      slotId: slot.id,
      lessonTypeId: lesson.id,
      payWith: 'wechat',
      expectedPrice: quoted,
    }
    const stale = await h.call('POST', '/bookings', body, a)
    expect(stale.status).toBe(409)
    expect(stale.json.error.code).toBe('price_changed')
    expect(h.db.select().from(bookings).all()).toHaveLength(0)
    const fresh = await h.call('POST', '/bookings', { ...body, expectedPrice: quoted + 3300 }, a)
    expect(fresh.status).toBe(201)
    expect(h.db.select().from(orders).get()?.amount).toBe(quoted + 3300)
  })
})

describe('booking window', () => {
  it('rejects lessons too soon, too far, or in the past', async () => {
    const h = setup() // now: 2026-10-23 10:00 at the venue
    const { coach, lesson } = h.seed()
    const a = await h.student('a')
    const soon = h.slot(coach.id, '2026-10-23', 11)
    const far = h.slot(coach.id, '2026-11-07', 10)
    const past = h.slot(coach.id, '2026-10-22', 10)
    expect((await book(h, a, soon.id, lesson.id)).json.error.code).toBe('too_soon')
    expect((await book(h, a, far.id, lesson.id)).json.error.code).toBe('too_far')
    expect((await book(h, a, past.id, lesson.id)).json.error.code).toBe('started')
  })

  it('refuses closed slots and mismatched lesson lengths', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const a = await h.student('a')
    const closed = h.slot(coach.id)
    h.db.update(slots).set({ open: false }).where(eq(slots.id, closed.id)).run()
    expect((await book(h, a, closed.id, lesson.id)).json.error.code).toBe('slot_closed')
    const { lessonTypes } = await import('./db/schema')
    h.db.update(lessonTypes).set({ durationMinutes: 90 }).where(eq(lessonTypes.id, lesson.id)).run()
    const open = h.slot(coach.id, '2026-10-26')
    expect((await book(h, a, open.id, lesson.id)).json.error.code).toBe('duration_mismatch')
  })

  it('says why a slot whose coach, lesson or slot went away cannot be booked', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const a = await h.student('a')
    const gone = await book(h, a, 9999, lesson.id)
    expect(gone.json.error).toMatchObject({ code: 'not_found', message: '该时段已取消' })
    const slot = h.slot(coach.id)
    h.db.update(coaches).set({ active: false }).where(eq(coaches.id, coach.id)).run()
    const off = await book(h, a, slot.id, lesson.id)
    expect(off.json.error).toMatchObject({
      code: 'coach_not_teaching',
      message: '该教练暂不可预约',
    })
    h.db.update(coaches).set({ active: true }).where(eq(coaches.id, coach.id)).run()
    const { lessonTypes } = await import('./db/schema')
    h.db.update(lessonTypes).set({ active: false }).where(eq(lessonTypes.id, lesson.id)).run()
    const hidden = await book(h, a, slot.id, lesson.id)
    expect(hidden.json.error).toMatchObject({ code: 'not_found', message: '该课程暂不可预约' })
  })
})

describe('cancelling a paid lesson', () => {
  async function paidBooking(h: Harness) {
    const { coach, lesson } = h.seed()
    const slot = h.slot(coach.id, '2026-10-26', 10)
    const t = await h.student('a')
    const res = await book(h, t, slot.id, lesson.id)
    await pay(h, res.json.orderId)
    return { t, bookingId: res.json.bookingId as number }
  }

  it('refunds in full before the deadline', async () => {
    const h = setup()
    const { t, bookingId } = await paidBooking(h)
    const res = await h.call('POST', `/bookings/${bookingId}/cancel`, undefined, t)
    expect(res.json).toMatchObject({
      status: 'cancelled',
      late: false,
      refund: { amount: 20000, status: 'succeeded' },
    })
  })

  it('forfeits after the deadline', async () => {
    const h = setup()
    const { t, bookingId } = await paidBooking(h)
    h.clock.now = new Date('2026-10-25T03:00:00Z') // 23 hours before
    // The student must have seen that this cancel is late.
    const unaware = await h.call('POST', `/bookings/${bookingId}/cancel`, undefined, t)
    expect(unaware.json.error.code).toBe('late_now')
    expect(h.db.select().from(bookings).get()?.status).toBe('confirmed')
    const res = await h.call('POST', `/bookings/${bookingId}/cancel`, { acceptLate: true }, t)
    expect(res.json).toMatchObject({ status: 'cancelled', late: true, refund: null })
  })

  it('refunds in full when the venue cancels, even late', async () => {
    const h = setup()
    const { t, bookingId } = await paidBooking(h)
    h.clock.now = new Date('2026-10-26T01:30:00Z')
    const admin = await h.admin()
    expect(
      (await h.call('POST', `/admin/bookings/${bookingId}/cancel`, { reason: '教练请假' }, admin))
        .status,
    ).toBe(204)
    const view = await h.call('GET', `/bookings/${bookingId}`, undefined, t)
    expect(view.json).toMatchObject({
      cancelledBy: 'venue',
      refund: { amount: 20000, status: 'succeeded' },
    })
  })

  it('cannot be cancelled twice or after it started', async () => {
    const h = setup()
    const { t, bookingId } = await paidBooking(h)
    h.clock.now = new Date('2026-10-26T02:30:00Z')
    expect(
      (await h.call('POST', `/bookings/${bookingId}/cancel`, undefined, t)).json.error.code,
    ).toBe('started')
    h.clock.now = new Date('2026-10-23T02:00:00Z')
    const first = await h.call('POST', `/bookings/${bookingId}/cancel`, undefined, t)
    // A repeated cancel is answered with the cancelled booking and refunds nothing more.
    const again = await h.call('POST', `/bookings/${bookingId}/cancel`, undefined, t)
    expect(again.status).toBe(200)
    expect(again.json).toEqual(first.json)
    expect(h.db.select().from(refunds).all()).toHaveLength(1)
    // The venue cancelling what the student already cancelled still fails.
    const admin = await h.admin()
    const venue = await h.call(
      'POST',
      `/admin/bookings/${bookingId}/cancel`,
      { reason: '补录' },
      admin,
    )
    expect(venue.json.error.code).toBe('not_cancellable')
  })

  it('keeps a refund pending through a network failure and retries it', async () => {
    const h = setup()
    const { t, bookingId } = await paidBooking(h)
    const realRefund = h.gateway.refund.bind(h.gateway)
    const { GatewayError } = await import('./pay/gateway')
    h.gateway.refund = async () => {
      throw new GatewayError('down', 'NETWORK', 0)
    }
    const res = await h.call('POST', `/bookings/${bookingId}/cancel`, undefined, t)
    expect(res.json.refund.status).toBe('pending')
    h.gateway.refund = realRefund
    h.clock.now = new Date(h.clock.now.getTime() + 2 * 60_000)
    await sweep(h.deps)
    expect(h.db.select().from(refunds).get()?.status).toBe('succeeded')
  })

  it('marks a rejected refund failed so the admin can retry it', async () => {
    const h = setup()
    const { t, bookingId } = await paidBooking(h)
    h.gateway.refundMode = 'fail'
    await h.call('POST', `/bookings/${bookingId}/cancel`, undefined, t)
    const refund = h.db.select().from(refunds).get()
    expect(refund?.status).toBe('failed')
    h.gateway.refundMode = 'succeeded'
    h.gateway.refunds.clear()
    const admin = await h.admin()
    expect(
      (await h.call('POST', `/admin/refunds/${refund?.id}/retry`, undefined, admin)).json.status,
    ).toBe('succeeded')
    expect(h.db.select().from(refunds).get()?.status).toBe('succeeded')
  })
})

describe('trial lessons', () => {
  it('allows one trial per student, again after an early cancellation', async () => {
    const h = setup()
    const { coach, trial } = h.seed()
    const s1 = h.slot(coach.id, '2026-10-26', 10)
    const s2 = h.slot(coach.id, '2026-10-26', 12)
    const t = await h.student('a')
    const first = await book(h, t, s1.id, trial.id)
    expect(first.status).toBe(201)
    expect(h.db.select().from(orders).get()).toMatchObject({ kind: 'trial', amount: 5000 })
    expect((await book(h, t, s2.id, trial.id)).json.error.code).toBe('trial_used')
    await h.call('POST', `/bookings/${first.json.bookingId}/cancel`, undefined, t)
    expect((await book(h, t, s2.id, trial.id)).status).toBe(201)
  })

  it('is hidden and refused when trials are off', async () => {
    const h = setup()
    h.settings((s) => {
      s.payment.trialEnabled = false
    })
    const { coach, trial } = h.seed()
    const t = await h.student('a')
    const catalog = await h.call('GET', '/catalog', undefined, t)
    expect(catalog.json.lessonTypes.map((l: { isTrial: boolean }) => l.isTrial)).toEqual([false])
    expect((await book(h, t, h.slot(coach.id).id, trial.id)).json.error.code).toBe('trial_off')
  })
})

async function withPackage(h: Harness, lessonCount = 10) {
  const { coach, lesson } = h.seed()
  const product = h.db
    .insert(packageProducts)
    .values({
      name: '10 次课',
      lessonTypeId: lesson.id,
      lessonCount,
      price: 180000,
      validityDays: 90,
    })
    .returning()
    .get()
  const t = await h.student('a')
  const res = await h.call('POST', '/packages/purchase', { productId: product.id }, t)
  expect(res.status).toBe(201)
  await pay(h, res.json.orderId)
  return { coach, lesson, product, t }
}

describe('packages', () => {
  it('creates the package once paid and uses it for bookings', async () => {
    const h = setup()
    const { coach, lesson, t } = await withPackage(h)
    const [pkg] = (await h.call('GET', '/packages', undefined, t)).json
    expect(pkg).toMatchObject({ lessonsRemaining: 10, status: 'active', pricePaid: 180000 })
    expect(pkg.expiresAt).toBe('2027-01-21T16:00:00.000Z')

    const res = await book(h, t, h.slot(coach.id).id, lesson.id)
    expect(res.json).toMatchObject({ status: 'confirmed', orderId: null, payment: null })
    expect((await h.call('GET', '/packages', undefined, t)).json[0].lessonsRemaining).toBe(9)
  })

  it('can still pay per class when asked', async () => {
    const h = setup()
    const { coach, lesson, t } = await withPackage(h)
    const res = await book(h, t, h.slot(coach.id).id, lesson.id, 'wechat')
    expect(res.json.status).toBe('pending_payment')
    expect((await h.call('GET', '/packages', undefined, t)).json[0].lessonsRemaining).toBe(10)
  })

  it('books with a package whatever price the page showed', async () => {
    const h = setup()
    const { coach, lesson, t } = await withPackage(h)
    const body = { slotId: h.slot(coach.id).id, lessonTypeId: lesson.id, expectedPrice: 1 }
    const res = await h.call('POST', '/bookings', body, t)
    expect(res.json).toMatchObject({ status: 'confirmed', orderId: null })
  })

  it('returns the lesson on an early cancel and keeps it on a late one', async () => {
    const h = setup()
    const { coach, lesson, t } = await withPackage(h)
    const early = await book(h, t, h.slot(coach.id, '2026-10-26', 10).id, lesson.id)
    const late = await book(h, t, h.slot(coach.id, '2026-10-24', 10).id, lesson.id)
    expect((await h.call('GET', '/packages', undefined, t)).json[0].lessonsRemaining).toBe(8)
    h.clock.now = new Date('2026-10-23T12:00:00Z') // 20 hours before the 24th, 44 before the 26th
    await h.call('POST', `/bookings/${early.json.bookingId}/cancel`, undefined, t)
    const lateCancel = await h.call(
      'POST',
      `/bookings/${late.json.bookingId}/cancel`,
      { acceptLate: true },
      t,
    )
    expect(lateCancel.json).toMatchObject({ status: 'cancelled', late: true })
    expect((await h.call('GET', '/packages', undefined, t)).json[0].lessonsRemaining).toBe(9)
  })

  it('never spends the last lesson twice', async () => {
    const h = setup()
    const { coach, lesson, t } = await withPackage(h, 1)
    const s1 = h.slot(coach.id, '2026-10-25', 10)
    const s2 = h.slot(coach.id, '2026-10-25', 12)
    const results = await Promise.all([
      book(h, t, s1.id, lesson.id, 'package'),
      book(h, t, s2.id, lesson.id, 'package'),
    ])
    expect(results.map((r) => r.status).sort()).toEqual([201, 409])
    expect((await h.call('GET', '/packages', undefined, t)).json[0].lessonsRemaining).toBe(0)
  })

  it('does not cover lessons after it expires', async () => {
    const h = setup()
    const { coach, lesson } = await withPackage(h)
    h.settings((s) => {
      s.booking.advanceDays = 90
    })
    h.clock.now = new Date('2027-01-15T02:00:00Z')
    const again = await h.student('a')
    const res = await book(h, again, h.slot(coach.id, '2027-01-25', 10).id, lesson.id, 'package')
    expect(res.json.error.code).toBe('no_package')
  })

  it('refunds the unused part after admin approval', async () => {
    const h = setup()
    const { coach, lesson, t } = await withPackage(h)
    const used = await book(h, t, h.slot(coach.id, '2026-10-23', 14).id, lesson.id)
    expect(used.status).toBe(201)
    const pkgId = (await h.call('GET', '/packages', undefined, t)).json[0].id
    // An upcoming booking on the package blocks the request.
    expect(
      (await h.call('POST', `/packages/${pkgId}/refund-request`, undefined, t)).json.error.code,
    ).toBe('package_in_use')
    h.clock.now = new Date('2026-10-23T08:00:00Z') // after the lesson
    const req = await h.call('POST', `/packages/${pkgId}/refund-request`, undefined, t)
    expect(req.json).toMatchObject({
      status: 'refund_requested',
      refund: { amount: 160000, status: 'requested' },
    })
    // A frozen package is not used for new bookings.
    expect(
      (await book(h, t, h.slot(coach.id, '2026-10-26', 10).id, lesson.id, 'package')).json.error
        .code,
    ).toBe('no_package')

    const admin = await h.admin()
    const [refund] = (await h.call('GET', '/admin/refunds?status=requested', undefined, admin)).json
    expect(refund.package.lessonsRemaining).toBe(9)
    const tooMuch = await h.call(
      'POST',
      `/admin/refunds/${refund.id}/approve`,
      { amount: 180001 },
      admin,
    )
    expect(tooMuch.json.error.code).toBe('refund_too_large')
    expect(
      (await h.call('POST', `/admin/refunds/${refund.id}/approve`, { amount: 150000 }, admin)).json
        .status,
    ).toBe('succeeded')
    const [pkg] = (await h.call('GET', '/packages', undefined, t)).json
    expect(pkg).toMatchObject({
      status: 'refunded',
      lessonsRemaining: 0,
      refund: { amount: 150000, status: 'succeeded' },
    })
  })

  it('tells the admin when WeChat refuses an approved refund at once', async () => {
    const h = setup()
    const { t } = await withPackage(h)
    const pkgId = (await h.call('GET', '/packages', undefined, t)).json[0].id
    await h.call('POST', `/packages/${pkgId}/refund-request`, undefined, t)
    const admin = await h.admin()
    const [refund] = (await h.call('GET', '/admin/refunds', undefined, admin)).json
    h.gateway.refundMode = 'fail'
    const res = await h.call(
      'POST',
      `/admin/refunds/${refund.id}/approve`,
      { amount: 100000 },
      admin,
    )
    expect(res.json.status).toBe('failed')
    expect(res.json.failure).toBeTruthy()
  })

  it('puts the package back in use when the admin rejects the request', async () => {
    const h = setup()
    const { t } = await withPackage(h)
    const pkgId = (await h.call('GET', '/packages', undefined, t)).json[0].id
    await h.call('POST', `/packages/${pkgId}/refund-request`, undefined, t)
    const admin = await h.admin()
    const [refund] = (await h.call('GET', '/admin/refunds', undefined, admin)).json
    await h.call('POST', `/admin/refunds/${refund.id}/reject`, { note: '已超过退款期限' }, admin)
    const [pkg] = (await h.call('GET', '/packages', undefined, t)).json
    expect(pkg).toMatchObject({ status: 'active', refund: { status: 'rejected' } })
  })

  it('records a front-desk sale and lets the admin grant and extend', async () => {
    const h = setup()
    const { lesson } = h.seed()
    const product = h.db
      .insert(packageProducts)
      .values({
        name: '5 次课',
        lessonTypeId: lesson.id,
        lessonCount: 5,
        price: 95000,
        validityDays: 30,
      })
      .returning()
      .get()
    const t = await h.student('a')
    const admin = await h.admin()
    const sale = await h.call(
      'POST',
      '/admin/packages/offline-sale',
      { studentId: 1, productId: product.id, amount: 90000, method: 'alipay', note: '前台支付宝' },
      admin,
    )
    expect(sale.status).toBe(201)
    await h.call(
      'POST',
      `/admin/packages/${sale.json.packageId}/grant`,
      { lessons: 2, note: '补课' },
      admin,
    )
    await h.call('POST', `/admin/packages/${sale.json.packageId}/extend`, { days: 10 }, admin)
    const [pkg] = (await h.call('GET', '/packages', undefined, t)).json
    expect(pkg).toMatchObject({
      lessonsRemaining: 7,
      pricePaid: 90000,
      expiresAt: '2026-12-02T16:00:00.000Z',
    })
    const order = h.db.select().from(orders).get()
    expect(order).toMatchObject({ provider: 'offline', offlineMethod: 'alipay', status: 'paid' })
  })

  it('cannot be bought when packages are off', async () => {
    const h = setup()
    h.settings((s) => {
      s.payment.packagesEnabled = false
    })
    const { lesson } = h.seed()
    const product = h.db
      .insert(packageProducts)
      .values({
        name: '5 次课',
        lessonTypeId: lesson.id,
        lessonCount: 5,
        price: 95000,
        validityDays: 30,
      })
      .returning()
      .get()
    const t = await h.student('a')
    expect((await h.call('GET', '/catalog', undefined, t)).json.packageProducts).toEqual([])
    expect(
      (await h.call('POST', '/packages/purchase', { productId: product.id }, t)).json.error.code,
    ).toBe('packages_off')
  })
})

describe('slots', () => {
  it('shows taken slots as unavailable and hides closed ones', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const s1 = h.slot(coach.id, '2026-10-25', 10)
    const s2 = h.slot(coach.id, '2026-10-25', 12)
    const s3 = h.slot(coach.id, '2026-10-25', 14)
    h.db.update(slots).set({ open: false }).where(eq(slots.id, s3.id)).run()
    const a = await h.student('a')
    const b = await h.student('b')
    await book(h, a, s1.id, lesson.id)
    const res = await h.call(
      'GET',
      `/slots?date=2026-10-25&lessonTypeId=${lesson.id}`,
      undefined,
      b,
    )
    expect(res.json.map((s: { id: number; available: boolean }) => [s.id, s.available])).toEqual([
      [s1.id, false],
      [s2.id, true],
    ])
  })

  it('lists the days in the window with a slot that can be booked now', async () => {
    // 10:00 at the venue on 10-23, with 2 hours' notice and 14 days ahead.
    const h = setup()
    const { coach, lesson } = h.seed()
    const other = h.db.insert(coaches).values({ name: '李教练' }).returning().get()
    h.db.insert(coachLessonTypes).values({ coachId: other.id, lessonTypeId: lesson.id }).run()
    h.slot(coach.id, '2026-10-23', 11) // too soon
    const taken = h.slot(coach.id, '2026-10-24', 10)
    h.slot(coach.id, '2026-10-26', 10)
    h.slot(coach.id, '2026-10-26', 15)
    const closed = h.slot(coach.id, '2026-10-27', 10)
    h.db.update(slots).set({ open: false }).where(eq(slots.id, closed.id)).run()
    h.slot(coach.id, '2026-11-06', 9) // last day of the window, 14 days ahead
    h.slot(coach.id, '2026-11-07', 9) // past it
    h.slot(other.id, '2026-10-25', 10)
    const a = await h.student('a')
    await book(h, a, taken.id, lesson.id)
    const days = (q: string) => h.call('GET', `/slots/open-days?${q}`, undefined, a)
    expect((await days(`lessonTypeId=${lesson.id}&coachId=${coach.id}`)).json).toEqual([
      '2026-10-26',
      '2026-11-06',
    ])
    expect((await days(`lessonTypeId=${lesson.id}`)).json).toEqual([
      '2026-10-25',
      '2026-10-26',
      '2026-11-06',
    ])
    expect((await days(`lessonTypeId=${lesson.id}&coachId=${other.id}`)).json).toEqual([
      '2026-10-25',
    ])
    expect((await days('lessonTypeId=999')).status).toBe(404)
    expect((await h.call('GET', `/slots/open-days?lessonTypeId=${lesson.id}`)).status).toBe(401)
  })

  it('refuses overlapping slots for one coach when the admin creates them', async () => {
    const h = setup()
    const { coach } = h.seed()
    const admin = await h.admin()
    const res = await h.call(
      'POST',
      '/admin/slots',
      {
        slots: [
          { coachId: coach.id, startsAt: '2026-10-25T02:00:00Z', endsAt: '2026-10-25T03:00:00Z' },
          { coachId: coach.id, startsAt: '2026-10-25T02:30:00Z', endsAt: '2026-10-25T03:30:00Z' },
        ],
      },
      admin,
    )
    expect(res.json.error.code).toBe('slot_overlap')
    // Names the venue time, so the admin can find it in a batch of hundreds.
    expect(res.json.error.message).toBe('10月25日 10:30 与该教练已有时段重叠')
    expect(h.db.select().from(slots).all()).toHaveLength(0)
  })

  it('refuses slots in the past', async () => {
    const h = setup()
    const { coach } = h.seed()
    const admin = await h.admin()
    const res = await h.call(
      'POST',
      '/admin/slots',
      {
        slots: [
          { coachId: coach.id, startsAt: '2026-10-23T01:00:00Z', endsAt: '2026-10-23T02:00:00Z' },
        ],
      },
      admin,
    )
    expect(res.json.error.code).toBe('slot_in_past')
  })

  it('refuses slots that run past midnight at the venue', async () => {
    const h = setup()
    const { coach } = h.seed()
    const admin = await h.admin()
    const create = (startsAt: string, endsAt: string) =>
      h.call('POST', '/admin/slots', { slots: [{ coachId: coach.id, startsAt, endsAt }] }, admin)
    // 23:30 to 00:30 at the venue.
    const late = await create('2026-10-25T15:30:00Z', '2026-10-25T16:30:00Z')
    expect(late.json.error.code).toBe('crosses_midnight')
    // 23:00 to 24:00 ends on the same day.
    expect((await create('2026-10-25T15:00:00Z', '2026-10-25T16:00:00Z')).status).toBe(201)
  })
})

describe('auth', () => {
  it('needs a session for student and admin routes', async () => {
    const h = setup()
    expect((await h.call('GET', '/catalog')).status).toBe(401)
    expect((await h.call('GET', '/admin/settings')).status).toBe(401)
    expect(
      (await h.call('POST', '/admin/login', { username: 'admin', password: 'wrong' })).status,
    ).toBe(401)
    const student = await h.student('a')
    expect((await h.call('GET', '/admin/settings', undefined, student)).status).toBe(401)
  })

  it("hides another student's bookings", async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const a = await h.student('a')
    const b = await h.student('b')
    const res = await book(h, a, h.slot(coach.id).id, lesson.id)
    expect((await h.call('GET', `/bookings/${res.json.bookingId}`, undefined, b)).status).toBe(404)
    expect(
      (await h.call('POST', `/bookings/${res.json.bookingId}/cancel`, undefined, b)).status,
    ).toBe(404)
    expect((await h.call('GET', `/orders/${res.json.orderId}`, undefined, b)).status).toBe(404)
  })

  it('updates the profile with PUT, keeping fields left out', async () => {
    const h = setup()
    const a = await h.student('a')
    const named = await h.call('PUT', '/me', { name: '小明' }, a)
    expect(named.json).toMatchObject({ name: '小明', phone: '' })
    const phoned = await h.call('PUT', '/me', { phone: '13800138000' }, a)
    expect(phoned.json).toMatchObject({ name: '小明', phone: '13800138000' })
    expect((await h.call('PUT', '/me', { phone: '12345' }, a)).status).toBe(400)
  })
})

describe('review fixes', () => {
  it('refunds in full when a payment lands while the student cancels the unpaid booking', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    // Three hours ahead: a paid booking cancelled now would be late and forfeit.
    const slot = h.slot(coach.id, '2026-10-23', 13)
    const t = await h.student('a')
    const res = await book(h, t, slot.id, lesson.id)
    const outTradeNo =
      h.db.select().from(orders).where(eq(orders.id, res.json.orderId)).get()?.outTradeNo ?? ''
    h.gateway.pay(outTradeNo, h.deps.now()) // paid at WeChat, callback not here yet
    const cancel = await h.call('POST', `/bookings/${res.json.bookingId}/cancel`, undefined, t)
    expect(cancel.json).toMatchObject({
      status: 'cancelled',
      late: false,
      refund: { amount: 20000, status: 'succeeded' },
    })
  })

  it('records an admin cancel of an unpaid booking as the venue, with the reason', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const t = await h.student('a')
    const res = await book(h, t, h.slot(coach.id).id, lesson.id)
    const admin = await h.admin()
    await h.call(
      'POST',
      `/admin/bookings/${res.json.bookingId}/cancel`,
      { reason: '场地维修' },
      admin,
    )
    const row = h.db.select().from(bookings).get()
    expect(row).toMatchObject({
      status: 'cancelled',
      cancelledBy: 'venue',
      cancelReason: '场地维修',
    })
  })

  it('refuses a venue cancel once the lesson has ended', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const t = await h.student('a')
    const res = await book(h, t, h.slot(coach.id).id, lesson.id)
    await pay(h, res.json.orderId)
    const id = res.json.bookingId
    h.clock.now = new Date('2026-10-25T03:00:00Z') // the lesson has ended
    const admin = await h.admin()
    const late = await h.call('POST', `/admin/bookings/${id}/cancel`, { reason: '补录' }, admin)
    expect(late.json.error.code).toBe('ended')
    h.clock.now = new Date('2026-10-25T02:30:00Z') // mid-lesson, a coach who did not show up
    const mid = await h.call('POST', `/admin/bookings/${id}/cancel`, { reason: '教练缺席' }, admin)
    expect(mid.status).toBe(204)
  })

  it('does not confirm a payment whose amount differs from the order', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const t = await h.student('a')
    const res = await book(h, t, h.slot(coach.id).id, lesson.id)
    const order = h.db.select().from(orders).get()
    const { applyPayment } = await import('./services/orders')
    expect(() =>
      applyPayment(h.deps, order?.outTradeNo ?? '', {
        state: 'paid',
        transactionId: 't1',
        paidAt: h.deps.now(),
        amount: 1,
      }),
    ).toThrow()
    expect(h.db.select().from(orders).get()?.status).toBe('pending')
    expect(h.db.select().from(bookings).get()?.status).toBe('pending_payment')
    expect(res.status).toBe(201)
  })

  it('acknowledges a verified callback for an order it never had', async () => {
    const h = setup()
    h.gateway.parsePaymentNotification = () => ({
      outTradeNo: 'RS_unknown',
      order: { state: 'paid', transactionId: 't1', paidAt: h.deps.now(), amount: 100 },
    })
    const res = await h.app.request('/api/pay/wechat/notify', { method: 'POST', body: '{}' })
    expect(res.status).toBe(204)
  })

  it('rejects an empty profile update instead of failing', async () => {
    const h = setup()
    const t = await h.student('a')
    expect((await h.call('PUT', '/me', {}, t)).status).toBe(400)
    const admin = await h.admin()
    expect((await h.call('PATCH', '/admin/students/1', {}, admin)).status).toBe(400)
  })

  it('quotes the package the booking will use', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const t = await h.student('a')
    const slot = h.slot(coach.id)
    const before = await h.call(
      'GET',
      `/bookings/quote?slotId=${slot.id}&lessonTypeId=${lesson.id}`,
      undefined,
      t,
    )
    expect(before.json).toMatchObject({
      price: { price: 20000 },
      package: null,
      perClassEnabled: true,
    })
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
    const bought = await h.call('POST', '/packages/purchase', { productId: product.id }, t)
    await pay(h, bought.json.orderId)
    const after = await h.call(
      'GET',
      `/bookings/quote?slotId=${slot.id}&lessonTypeId=${lesson.id}`,
      undefined,
      t,
    )
    expect(after.json.package).toMatchObject({ name: '10 次课', lessonsRemaining: 10 })
  })

  it('suggests a package refund that charges used lessons before granted ones', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const product = h.db
      .insert(packageProducts)
      .values({
        name: '10 次课',
        lessonTypeId: lesson.id,
        lessonCount: 10,
        price: 150000,
        validityDays: 90,
      })
      .returning()
      .get()
    const t = await h.student('a')
    const bought = await h.call('POST', '/packages/purchase', { productId: product.id }, t)
    await pay(h, bought.json.orderId)
    const admin = await h.admin()
    const pkg = (await h.call('GET', '/packages', undefined, t)).json[0]
    await h.call('POST', `/admin/packages/${pkg.id}/grant`, { lessons: 2, note: '活动' }, admin)
    for (const hour of [10, 11, 12])
      await book(h, t, h.slot(coach.id, '2026-10-24', hour).id, lesson.id)
    h.clock.now = new Date('2026-10-24T06:00:00Z') // after the three lessons
    const res = await h.call('POST', `/packages/${pkg.id}/refund-request`, undefined, t)
    expect(res.json).toMatchObject({ lessonsGranted: 2, lessonsRemaining: 9 })
    // 1500 paid, 3 paid lessons used at 200: 900.
    expect(h.db.select().from(refunds).where(eq(refunds.packageId, pkg.id)).get()?.amount).toBe(
      90000,
    )
  })

  it("values used package lessons at each coach's category price, skipping returned ones", async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const { coachLessonTypes, coaches } = await import('./db/schema')
    // 王教练 is a ¥300 主教练; 李教练 has no category and is on the ¥200 list price.
    h.category(coach.id, '主教练', [{ lessonTypeId: lesson.id, price: 30000 }])
    const other = h.db.insert(coaches).values({ name: '李教练' }).returning().get()
    h.db.insert(coachLessonTypes).values({ coachId: other.id, lessonTypeId: lesson.id }).run()
    const product = h.db
      .insert(packageProducts)
      .values({
        name: '10 次课',
        lessonTypeId: lesson.id,
        lessonCount: 10,
        price: 250000,
        validityDays: 90,
      })
      .returning()
      .get()
    const t = await h.student('a')
    const bought = await h.call('POST', '/packages/purchase', { productId: product.id }, t)
    await pay(h, bought.json.orderId)
    await book(h, t, h.slot(coach.id, '2026-10-25', 10).id, lesson.id)
    await book(h, t, h.slot(other.id, '2026-10-25', 12).id, lesson.id)
    // Cancelled early, so the lesson goes back and is not charged.
    const returned = await book(h, t, h.slot(coach.id, '2026-10-26', 10).id, lesson.id)
    await h.call('POST', `/bookings/${returned.json.bookingId}/cancel`, undefined, t)
    h.clock.now = new Date('2026-10-25T06:00:00Z') // after both lessons on the 25th
    const pkg = (await h.call('GET', '/packages', undefined, t)).json[0]
    expect(pkg.lessonsRemaining).toBe(8)
    await h.call('POST', `/packages/${pkg.id}/refund-request`, undefined, t)
    // 2500 paid, one lesson at 300 and one at 200: 2000.
    expect(h.db.select().from(refunds).where(eq(refunds.packageId, pkg.id)).get()?.amount).toBe(
      200000,
    )
  })

  it('locks the trial flag once a lesson type has bookings', async () => {
    const h = setup()
    const { coach, trial } = h.seed()
    const t = await h.student('a')
    await book(h, t, h.slot(coach.id).id, trial.id)
    const admin = await h.admin()
    const res = await h.call(
      'PUT',
      `/admin/lesson-types/${trial.id}`,
      { name: trial.name, durationMinutes: 60, price: 5000, isTrial: false },
      admin,
    )
    expect(res.json.error.code).toBe('trial_locked')
  })

  it('keeps package terms fixed while someone is paying for it', async () => {
    const h = setup()
    const { lesson } = h.seed()
    const admin = await h.admin()
    const body = {
      name: '10 次课',
      lessonTypeId: lesson.id,
      lessonCount: 10,
      price: 180000,
      validityDays: 90,
    }
    const product = (await h.call('POST', '/admin/package-products', body, admin)).json
    const t = await h.student('a')
    await h.call('POST', '/packages/purchase', { productId: product.id }, t)
    const fewer = await h.call(
      'PUT',
      `/admin/package-products/${product.id}`,
      { ...body, lessonCount: 5 },
      admin,
    )
    expect(fewer.json.error.code).toBe('product_in_payment')
    const cheaper = await h.call(
      'PUT',
      `/admin/package-products/${product.id}`,
      { ...body, price: 170000 },
      admin,
    )
    expect(cheaper.status).toBe(200)
  })
})

describe('review round 2', () => {
  async function orderOf(h: Harness, orderId: number) {
    const order = h.db.select().from(orders).where(eq(orders.id, orderId)).get()
    if (!order) throw new Error('no order')
    return order
  }

  it('refunds a late payment instead of reviving a booking that would clash', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const { coachLessonTypes, coaches } = await import('./db/schema')
    const other = h.db.insert(coaches).values({ name: '李教练' }).returning().get()
    h.db.insert(coachLessonTypes).values({ coachId: other.id, lessonTypeId: lesson.id }).run()
    const t = await h.student('a')
    const first = await book(h, t, h.slot(coach.id).id, lesson.id)
    const order = await orderOf(h, first.json.orderId)
    h.clock.now = new Date(h.clock.now.getTime() + 13 * 60_000)
    await sweep(h.deps)
    // The student books the same time with another coach and pays for it.
    const second = await book(h, t, h.slot(other.id).id, lesson.id)
    await pay(h, second.json.orderId)
    // The first payment was made in time at WeChat; its callback only arrives now.
    const { applyPayment } = await import('./services/orders')
    applyPayment(h.deps, order.outTradeNo, {
      state: 'paid',
      transactionId: 'late',
      paidAt: h.deps.now(),
      amount: order.amount,
    })
    const rows = h.db.select().from(bookings).all()
    expect(rows.find((b) => b.id === first.json.bookingId)?.status).toBe('expired')
    expect(rows.find((b) => b.id === second.json.bookingId)?.status).toBe('confirmed')
    const refund = h.db.select().from(refunds).get()
    expect(refund).toMatchObject({ orderId: order.id, amount: 20000 })
  })

  it('refunds a late payment for a slot the admin closed meanwhile', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const slot = h.slot(coach.id)
    const t = await h.student('a')
    const res = await book(h, t, slot.id, lesson.id)
    const order = await orderOf(h, res.json.orderId)
    h.clock.now = new Date(h.clock.now.getTime() + 13 * 60_000)
    await sweep(h.deps)
    h.db.update(slots).set({ open: false }).where(eq(slots.id, slot.id)).run()
    const { applyPayment } = await import('./services/orders')
    applyPayment(h.deps, order.outTradeNo, {
      state: 'paid',
      transactionId: 'late',
      paidAt: h.deps.now(),
      amount: order.amount,
    })
    expect(h.db.select().from(bookings).get()?.status).toBe('expired')
    expect(h.db.select().from(refunds).get()?.amount).toBe(20000)
  })

  it('still revives a booking paid in time when the slot is free', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const t = await h.student('a')
    const res = await book(h, t, h.slot(coach.id).id, lesson.id)
    const order = await orderOf(h, res.json.orderId)
    h.clock.now = new Date(h.clock.now.getTime() + 13 * 60_000)
    await sweep(h.deps)
    const { applyPayment } = await import('./services/orders')
    applyPayment(h.deps, order.outTradeNo, {
      state: 'paid',
      transactionId: 'late',
      paidAt: h.deps.now(),
      amount: order.amount,
    })
    expect(h.db.select().from(bookings).get()?.status).toBe('confirmed')
    expect(h.db.select().from(refunds).all()).toHaveLength(0)
  })

  it('never lets an order stay payable past the lesson start', async () => {
    const h = setup()
    h.settings((s) => {
      s.booking.minNoticeMinutes = 0
    })
    const { coach, lesson } = h.seed()
    const t = await h.student('a')
    // 2026-10-23 10:00 at the venue; now is 10:00, so 11:00 starts in an hour.
    const slot = h.slot(coach.id, '2026-10-23', 11)
    h.clock.now = new Date(slot.startsAt.getTime() - 5 * 60_000)
    const res = await book(h, t, slot.id, lesson.id)
    const order = await orderOf(h, res.json.orderId)
    expect(order.expiresAt?.getTime()).toBe(slot.startsAt.getTime())
  })

  it('limits how many unpaid bookings one student can hold', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const t = await h.student('a')
    for (const hour of [9, 10, 11]) {
      expect((await book(h, t, h.slot(coach.id, '2026-10-25', hour).id, lesson.id)).status).toBe(
        201,
      )
    }
    const fourth = await book(h, t, h.slot(coach.id, '2026-10-25', 12).id, lesson.id)
    expect(fourth.json.error.code).toBe('too_many_unpaid')
  })

  it('refuses a student cancel once the lesson started, even if the payment only lands then', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const t = await h.student('a')
    const slot = h.slot(coach.id)
    const res = await book(h, t, slot.id, lesson.id)
    const order = await orderOf(h, res.json.orderId)
    h.gateway.pay(order.outTradeNo, h.deps.now()) // paid in time, callback lost
    h.clock.now = new Date(slot.startsAt.getTime() + 60_000)
    const cancel = await h.call('POST', `/bookings/${res.json.bookingId}/cancel`, undefined, t)
    expect(cancel.json.error.code).toBe('started')
    expect(h.db.select().from(bookings).get()?.status).toBe('confirmed')
    expect(h.db.select().from(refunds).all()).toHaveLength(0)
  })

  it('reports a cancel as done when the late payment was refunded because the slot was gone', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const slot = h.slot(coach.id)
    const a = await h.student('a')
    const b = await h.student('b')
    const res = await book(h, a, slot.id, lesson.id)
    const order = await orderOf(h, res.json.orderId)
    // While the cancel waits on WeChat, the hold expires, b takes the slot and a's payment lands.
    h.gateway.closeOrder = async (outTradeNo) => {
      h.db
        .update(bookings)
        .set({ status: 'expired' })
        .where(eq(bookings.id, res.json.bookingId))
        .run()
      expect((await book(h, b, slot.id, lesson.id)).status).toBe(201)
      const state = h.gateway.pay(outTradeNo, h.deps.now()).order
      if (state.state !== 'paid') throw new Error('not paid')
      return state
    }
    const cancel = await h.call('POST', `/bookings/${res.json.bookingId}/cancel`, undefined, a)
    expect(cancel.json).toMatchObject({ status: 'expired', refund: { amount: 20000 } })
    expect(h.db.select().from(refunds).get()).toMatchObject({ orderId: order.id, amount: 20000 })
  })

  it('refuses a package refund while a lesson from it is in progress', async () => {
    const h = setup()
    const { coach, lesson, t } = await withPackage(h)
    const slot = h.slot(coach.id, '2026-10-25', 10)
    await book(h, t, slot.id, lesson.id)
    h.clock.now = new Date(slot.startsAt.getTime() + 30 * 60_000)
    const pkg = (await h.call('GET', '/packages', undefined, t)).json[0]
    const res = await h.call('POST', `/packages/${pkg.id}/refund-request`, undefined, t)
    expect(res.json.error.code).toBe('package_in_use')
  })

  it('keeps a revived trial within the trial limit', async () => {
    const h = setup()
    const { coach, trial } = h.seed()
    const t = await h.student('a')
    const first = await book(h, t, h.slot(coach.id, '2026-10-25', 10).id, trial.id)
    const order = await orderOf(h, first.json.orderId)
    h.clock.now = new Date(h.clock.now.getTime() + 13 * 60_000)
    await sweep(h.deps)
    const second = await book(h, t, h.slot(coach.id, '2026-10-26', 10).id, trial.id)
    await pay(h, second.json.orderId)
    const { applyPayment } = await import('./services/orders')
    applyPayment(h.deps, order.outTradeNo, {
      state: 'paid',
      transactionId: 'late',
      paidAt: h.deps.now(),
      amount: order.amount,
    })
    const first2 = h.db.select().from(bookings).where(eq(bookings.id, first.json.bookingId)).get()
    expect(first2?.status).toBe('expired')
    expect(h.db.select().from(refunds).get()).toMatchObject({ orderId: order.id, amount: 5000 })
  })

  it('confirms nothing when the payment reports no amount', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const t = await h.student('a')
    const res = await book(h, t, h.slot(coach.id).id, lesson.id)
    const order = await orderOf(h, res.json.orderId)
    const { applyPayment } = await import('./services/orders')
    expect(() =>
      applyPayment(h.deps, order.outTradeNo, {
        state: 'paid',
        transactionId: 't1',
        paidAt: h.deps.now(),
        amount: 0,
      }),
    ).toThrow()
    expect(h.db.select().from(bookings).get()?.status).toBe('pending_payment')
  })

  it('retries a failed refund under a new refund number', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const t = await h.student('a')
    const res = await book(h, t, h.slot(coach.id).id, lesson.id)
    await pay(h, res.json.orderId)
    h.gateway.refundMode = 'fail'
    await h.call('POST', `/bookings/${res.json.bookingId}/cancel`, undefined, t)
    const failed = h.db.select().from(refunds).get()
    expect(failed?.status).toBe('failed')
    h.gateway.refundMode = 'succeeded'
    const admin = await h.admin()
    expect(
      (await h.call('POST', `/admin/refunds/${failed?.id}/retry`, undefined, admin)).json.status,
    ).toBe('succeeded')
    const retried = h.db.select().from(refunds).get()
    expect(retried?.status).toBe('succeeded')
    expect(retried?.outRefundNo).not.toBe(failed?.outRefundNo)
  })

  it('keeps retrying a refund WeChat rate limited', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const t = await h.student('a')
    const res = await book(h, t, h.slot(coach.id).id, lesson.id)
    await pay(h, res.json.orderId)
    const { GatewayError } = await import('./pay/gateway')
    const original = h.gateway.refund.bind(h.gateway)
    h.gateway.refund = async () => {
      throw new GatewayError('too fast', 'FREQUENCY_LIMITED', 429)
    }
    await h.call('POST', `/bookings/${res.json.bookingId}/cancel`, undefined, t)
    expect(h.db.select().from(refunds).get()?.status).toBe('pending')
    h.gateway.refund = original
    h.clock.now = new Date(h.clock.now.getTime() + 2 * 60_000)
    await sweep(h.deps)
    expect(h.db.select().from(refunds).get()?.status).toBe('succeeded')
  })

  it('slows down admin password guessing', async () => {
    const h = setup()
    for (let i = 0; i < 10; i++) {
      const res = await h.call('POST', '/admin/login', { username: 'admin', password: `guess${i}` })
      expect(res.status).toBe(401)
    }
    expect(
      (await h.call('POST', '/admin/login', { username: 'admin', password: 'guess' })).status,
    ).toBe(429)
    // Even the right password waits out the window.
    expect(
      (await h.call('POST', '/admin/login', { username: 'admin', password: 'test-password' }))
        .status,
    ).toBe(429)
    h.clock.now = new Date(h.clock.now.getTime() + 16 * 60_000)
    expect(
      (await h.call('POST', '/admin/login', { username: 'admin', password: 'test-password' }))
        .status,
    ).toBe(200)
  })
})

describe('admin booking list', () => {
  it('lists the next lesson first, can flip the order and splits upcoming from completed', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const studentId = (await h.call('GET', '/me', undefined, await h.student('order'))).json.id
    const at = (date: string, hour: number) => {
      const slot = h.slot(coach.id, date, hour)
      return h.db
        .insert(bookings)
        .values({
          slotId: slot.id,
          studentId,
          lessonTypeId: lesson.id,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          status: 'confirmed',
          paidWith: 'order',
          price: 0,
        })
        .returning()
        .get().id
    }
    const later = at('2026-10-26', 10)
    const first = at('2026-10-25', 10)
    const second = at('2026-10-25', 12)
    h.clock.now = new Date('2026-10-25T03:30:00Z') // 11:30 venue time, the first lesson is over
    const admin = await h.admin()
    const list = async (query: string) =>
      (await h.call('GET', `/admin/bookings?${query}`, undefined, admin)).json.map(
        (b: { id: number }) => b.id,
      )

    expect(await list('')).toEqual([first, second, later])
    expect(await list('order=desc')).toEqual([later, second, first])
    expect(await list('status=completed')).toEqual([first])
    expect(await list('status=confirmed')).toEqual([second, later])
  })
})
