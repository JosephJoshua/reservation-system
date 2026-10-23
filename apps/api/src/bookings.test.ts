import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { bookings, orders, packageProducts, refunds, slots } from './db/schema'
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
    expect([a.status, b.status].sort()).toEqual([201, 409])
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

  it('uses the coach price and a running sale', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const { coachLessonTypes, lessonTypes } = await import('./db/schema')
    h.db
      .update(coachLessonTypes)
      .set({ price: 30000 })
      .where(eq(coachLessonTypes.lessonTypeId, lesson.id))
      .run()
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
    const res = await h.call('POST', `/bookings/${bookingId}/cancel`, undefined, t)
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
    await h.call('POST', `/bookings/${bookingId}/cancel`, undefined, t)
    expect(
      (await h.call('POST', `/bookings/${bookingId}/cancel`, undefined, t)).json.error.code,
    ).toBe('not_cancellable')
    expect(h.db.select().from(refunds).all()).toHaveLength(1)
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
      (await h.call('POST', `/admin/refunds/${refund?.id}/retry`, undefined, admin)).status,
    ).toBe(204)
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

describe('packages', () => {
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

  it('returns the lesson on an early cancel and keeps it on a late one', async () => {
    const h = setup()
    const { coach, lesson, t } = await withPackage(h)
    const early = await book(h, t, h.slot(coach.id, '2026-10-26', 10).id, lesson.id)
    const late = await book(h, t, h.slot(coach.id, '2026-10-24', 10).id, lesson.id)
    expect((await h.call('GET', '/packages', undefined, t)).json[0].lessonsRemaining).toBe(8)
    h.clock.now = new Date('2026-10-23T12:00:00Z') // 20 hours before the 24th, 44 before the 26th
    await h.call('POST', `/bookings/${early.json.bookingId}/cancel`, undefined, t)
    await h.call('POST', `/bookings/${late.json.bookingId}/cancel`, undefined, t)
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
      (await h.call('POST', `/admin/refunds/${refund.id}/approve`, { amount: 150000 }, admin))
        .status,
    ).toBe(204)
    const [pkg] = (await h.call('GET', '/packages', undefined, t)).json
    expect(pkg).toMatchObject({
      status: 'refunded',
      lessonsRemaining: 0,
      refund: { amount: 150000, status: 'succeeded' },
    })
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
})

describe('auth', () => {
  it('needs a session for student and admin routes', async () => {
    const h = setup()
    expect((await h.call('GET', '/catalog')).status).toBe(401)
    expect((await h.call('GET', '/admin/settings')).status).toBe(401)
    expect((await h.call('POST', '/admin/login', { password: 'wrong' })).status).toBe(401)
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
})
