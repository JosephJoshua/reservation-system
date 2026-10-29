import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { bookings, orders, packageLedger, packageProducts, packages, refunds } from './db/schema'
import { applyPayment } from './services/orders'
import { type Harness, setup } from './test/harness'

/** Sends a request with an Idempotency-Key, as a client does for a submit it may repeat. */
async function keyed(h: Harness, path: string, body: unknown, token: string, key: string) {
  const res = await h.app.request(`/api${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': key,
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}

function product(h: Harness, lessonTypeId: number) {
  return h.db
    .insert(packageProducts)
    .values({ name: '10 次课', lessonTypeId, lessonCount: 10, price: 180000, validityDays: 90 })
    .returning()
    .get()
}

async function boughtPackage(h: Harness) {
  const { coach, lesson } = h.seed()
  const p = product(h, lesson.id)
  const t = await h.student('a')
  const res = await h.call('POST', '/packages/purchase', { productId: p.id }, t)
  await h.fakePay(res.json.orderId)
  const pkg = (await h.call('GET', '/packages', undefined, t)).json[0]
  return { coach, lesson, product: p, t, pkg, orderId: res.json.orderId as number }
}

describe('Idempotency-Key', () => {
  it('records a front desk sale once however often the submit is repeated', async () => {
    const h = setup()
    const { lesson } = h.seed()
    const p = product(h, lesson.id)
    await h.student('a')
    const admin = await h.admin()
    const body = { studentId: 1, productId: p.id, amount: 180000, method: 'cash' }
    const [a, b] = await Promise.all([
      keyed(h, '/admin/packages/offline-sale', body, admin, 'sale-1'),
      keyed(h, '/admin/packages/offline-sale', body, admin, 'sale-1'),
    ])
    const c = await keyed(h, '/admin/packages/offline-sale', body, admin, 'sale-1')
    expect([a.status, b.status, c.status]).toEqual([201, 201, 201])
    expect(b.json).toEqual(a.json)
    expect(c.json).toEqual(a.json)
    expect(h.db.select().from(packages).all()).toHaveLength(1)
    expect(h.db.select().from(orders).all()).toHaveLength(1)
    // A new key is a new sale.
    await keyed(h, '/admin/packages/offline-sale', body, admin, 'sale-2')
    expect(h.db.select().from(packages).all()).toHaveLength(2)
  })

  it('grants and extends once per key', async () => {
    const h = setup()
    const { pkg } = await boughtPackage(h)
    const admin = await h.admin()
    for (let i = 0; i < 3; i++) {
      await keyed(h, `/admin/packages/${pkg.id}/grant`, { lessons: 2, note: '补课' }, admin, 'g1')
      await keyed(h, `/admin/packages/${pkg.id}/extend`, { days: 10 }, admin, 'e1')
    }
    const row = h.db.select().from(packages).get()
    expect(row?.lessonsRemaining).toBe(12)
    const kinds = h.db
      .select()
      .from(packageLedger)
      .all()
      .map((l) => l.kind)
    expect(kinds.filter((k) => k === 'grant')).toHaveLength(1)
    expect(kinds.filter((k) => k === 'extend')).toHaveLength(1)
  })

  it('does not keep a failed request, so it can be retried', async () => {
    const h = setup()
    const { lesson } = h.seed()
    const p = product(h, lesson.id)
    const admin = await h.admin()
    const body = { studentId: 1, productId: p.id, amount: 180000, method: 'cash' }
    // No student yet: the first attempt fails.
    expect((await keyed(h, '/admin/packages/offline-sale', body, admin, 'k')).status).toBe(404)
    await h.student('a')
    expect((await keyed(h, '/admin/packages/offline-sale', body, admin, 'k')).status).toBe(201)
  })

  it('keeps keys apart per caller and per endpoint', async () => {
    const h = setup()
    const { pkg } = await boughtPackage(h)
    const admin = await h.admin()
    const other = await h.admin()
    await keyed(h, `/admin/packages/${pkg.id}/grant`, { lessons: 1, note: 'a' }, admin, 'same')
    await keyed(h, `/admin/packages/${pkg.id}/grant`, { lessons: 1, note: 'b' }, other, 'same')
    await keyed(h, `/admin/packages/${pkg.id}/extend`, { days: 1 }, admin, 'same')
    expect(h.db.select().from(packages).get()?.lessonsRemaining).toBe(12)
  })

  it('never reruns a request that was cut off, since its work may be done', async () => {
    const h = setup()
    const { pkg } = await boughtPackage(h)
    const admin = await h.admin()
    const { idempotencyKeys } = await import('./db/schema')
    const send = () =>
      keyed(h, `/admin/packages/${pkg.id}/grant`, { lessons: 1, note: 'a' }, admin, 'cut')
    await send()
    // Make the stored key look like a request that never finished.
    h.db.update(idempotencyKeys).set({ status: null, body: null }).run()
    h.clock.now = new Date(h.clock.now.getTime() + 3 * 60_000)
    expect((await send()).json.error.code).toBe('in_progress')
    expect(h.db.select().from(packages).get()?.lessonsRemaining).toBe(11)
  })

  it('refuses a reused key with a different body', async () => {
    const h = setup()
    const { pkg } = await boughtPackage(h)
    const admin = await h.admin()
    const grant = (lessons: number) =>
      keyed(h, `/admin/packages/${pkg.id}/grant`, { lessons, note: 'a' }, admin, 'k')
    expect((await grant(2)).status).toBe(204)
    expect((await grant(3)).json.error.code).toBe('idempotency_key_reused')
    expect(h.db.select().from(packages).get()?.lessonsRemaining).toBe(12)
  })

  it('caches nothing for callers who are not signed in', async () => {
    const h = setup()
    h.seed()
    const login = () =>
      h.app.request('/api/auth/student', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'shared' },
        body: JSON.stringify({ code: 'dev:a' }),
      })
    const a = (await (await login()).json()) as { token: string }
    const b = (await (await login()).json()) as { token: string }
    expect(a.token).not.toBe(b.token)
  })

  it('does not replay to a signed-out token', async () => {
    const h = setup()
    const { pkg } = await boughtPackage(h)
    const admin = await h.admin()
    const send = () =>
      keyed(h, `/admin/packages/${pkg.id}/grant`, { lessons: 1, note: 'a' }, admin, 'k')
    expect((await send()).status).toBe(204)
    await h.call('POST', '/admin/logout', undefined, admin)
    expect((await send()).status).toBe(401)
  })
})

describe('repeated requests without a key', () => {
  it('continues the open order when a package purchase is tapped twice', async () => {
    const h = setup()
    const { lesson } = h.seed()
    const p = product(h, lesson.id)
    const t = await h.student('a')
    const [a, b] = await Promise.all([
      h.call('POST', '/packages/purchase', { productId: p.id }, t),
      h.call('POST', '/packages/purchase', { productId: p.id }, t),
    ])
    expect(b.json.orderId).toBe(a.json.orderId)
    expect(h.db.select().from(orders).all()).toHaveLength(1)
    // Once that order is paid, buying again is a new purchase.
    await h.fakePay(a.json.orderId)
    const again = await h.call('POST', '/packages/purchase', { productId: p.id }, t)
    expect(again.json.orderId).not.toBe(a.json.orderId)
  })

  it('creates one package from duplicate payment callbacks', async () => {
    const h = setup()
    const { lesson } = h.seed()
    const p = product(h, lesson.id)
    const t = await h.student('a')
    const res = await h.call('POST', '/packages/purchase', { productId: p.id }, t)
    const order = h.db.select().from(orders).get()
    const paid = {
      state: 'paid' as const,
      transactionId: 'tx',
      paidAt: h.deps.now(),
      amount: order?.amount ?? 0,
    }
    for (let i = 0; i < 3; i++) applyPayment(h.deps, order?.outTradeNo ?? '', paid)
    await h.fakePay(res.json.orderId)
    expect(h.db.select().from(packages).all()).toHaveLength(1)
  })

  it('cancels an unpaid booking once when the cancel is repeated', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const t = await h.student('a')
    const res = await h.call(
      'POST',
      '/bookings',
      { slotId: h.slot(coach.id).id, lessonTypeId: lesson.id },
      t,
    )
    const [a, b] = await Promise.all([
      h.call('POST', `/bookings/${res.json.bookingId}/cancel`, undefined, t),
      h.call('POST', `/bookings/${res.json.bookingId}/cancel`, undefined, t),
    ])
    expect([a.status, b.status]).toEqual([200, 200])
    expect(h.db.select().from(bookings).get()).toMatchObject({
      status: 'cancelled',
      cancelledBy: 'student',
    })
  })

  it('answers a repeated refund request with the one already waiting', async () => {
    const h = setup()
    const { t, pkg } = await boughtPackage(h)
    const a = await h.call('POST', `/packages/${pkg.id}/refund-request`, undefined, t)
    const b = await h.call('POST', `/packages/${pkg.id}/refund-request`, undefined, t)
    expect(b.status).toBe(200)
    expect(b.json).toEqual(a.json)
    expect(h.db.select().from(refunds).all()).toHaveLength(1)
  })

  it('treats a repeated approval as done but refuses to approve a rejected request', async () => {
    const h = setup()
    const { t, pkg } = await boughtPackage(h)
    await h.call('POST', `/packages/${pkg.id}/refund-request`, undefined, t)
    const refund = h.db.select().from(refunds).get()
    const admin = await h.admin()
    const approve = (amount: number) =>
      h.call('POST', `/admin/refunds/${refund?.id}/approve`, { amount }, admin)
    expect((await approve(100000)).json.status).toBe('succeeded')
    expect((await approve(100000)).json.status).toBe('succeeded')
    expect((await approve(90000)).json.error.code).toBe('refund_not_requested')
    const rows = h.db.select().from(refunds).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ amount: 100000, status: 'succeeded' })
    expect(h.gateway.refunds.size).toBe(1)
    const reject = await h.call(
      'POST',
      `/admin/refunds/${refund?.id}/reject`,
      { note: '不退' },
      admin,
    )
    expect(reject.json.error.code).toBe('refund_not_requested')
  })

  it('treats a repeated rejection as done but refuses to approve after it', async () => {
    const h = setup()
    const { t, pkg } = await boughtPackage(h)
    await h.call('POST', `/packages/${pkg.id}/refund-request`, undefined, t)
    const refund = h.db.select().from(refunds).get()
    const admin = await h.admin()
    const reject = () =>
      h.call('POST', `/admin/refunds/${refund?.id}/reject`, { note: '不退' }, admin)
    expect((await reject()).status).toBe(204)
    expect((await reject()).status).toBe(204)
    const approve = await h.call(
      'POST',
      `/admin/refunds/${refund?.id}/approve`,
      { amount: 1000 },
      admin,
    )
    expect(approve.json.error.code).toBe('refund_not_requested')
    expect(h.db.select().from(packages).get()?.status).toBe('active')
  })

  it('treats a repeated refund retry as done', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const t = await h.student('a')
    const res = await h.call(
      'POST',
      '/bookings',
      { slotId: h.slot(coach.id, '2026-10-26').id, lessonTypeId: lesson.id },
      t,
    )
    await h.fakePay(res.json.orderId)
    h.gateway.refundMode = 'fail'
    await h.call('POST', `/bookings/${res.json.bookingId}/cancel`, undefined, t)
    h.gateway.refundMode = 'succeeded'
    const refund = h.db.select().from(refunds).get()
    const admin = await h.admin()
    const retry = () => h.call('POST', `/admin/refunds/${refund?.id}/retry`, undefined, admin)
    expect((await retry()).json.status).toBe('succeeded')
    expect((await retry()).json.status).toBe('succeeded')
    expect(
      h.db
        .select()
        .from(refunds)
        .where(eq(refunds.id, refund?.id ?? 0))
        .get()?.status,
    ).toBe('succeeded')
    expect(h.gateway.refunds.size).toBe(2) // the failed attempt and the one retry
  })

  it('does not close the order a first tap is paying when a repeat cannot reach WeChat', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const t = await h.student('a')
    const body = { slotId: h.slot(coach.id).id, lessonTypeId: lesson.id }
    const first = await h.call('POST', '/bookings', body, t)
    // The first tap is still waiting on WeChat: no prepay id yet, and WeChat now fails.
    h.db.update(orders).set({ prepayId: null }).run()
    h.gateway.failCreate = true
    const repeat = await h.call('POST', '/bookings', body, t)
    expect(repeat.status).toBe(502)
    expect(h.db.select().from(orders).get()?.status).toBe('pending')
    expect(h.db.select().from(bookings).get()?.status).toBe('pending_payment')
    expect(first.status).toBe(201)
  })

  it('keeps a coach cancel apart from an admin cancel of the same lesson', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const t = await h.student('a')
    const res = await h.call(
      'POST',
      '/bookings',
      { slotId: h.slot(coach.id, '2026-10-26').id, lessonTypeId: lesson.id },
      t,
    )
    await h.fakePay(res.json.orderId)
    const admin = await h.admin()
    const cancel = (reason: string) =>
      h.call('POST', `/admin/bookings/${res.json.bookingId}/cancel`, { reason }, admin)
    expect((await cancel('场地维修')).status).toBe(204)
    expect((await cancel('场地维修')).status).toBe(204)
    // Another venue cancel with its own reason did not happen, so it is not reported as done.
    expect((await cancel('教练请假')).json.error.code).toBe('not_cancellable')
    expect(h.db.select().from(refunds).all()).toHaveLength(1)
  })

  it('sends an approved refund to WeChat once when the approval is repeated', async () => {
    const h = setup()
    const { t, pkg } = await boughtPackage(h)
    await h.call('POST', `/packages/${pkg.id}/refund-request`, undefined, t)
    const refund = h.db.select().from(refunds).get()
    const admin = await h.admin()
    let sent = 0
    const original = h.gateway.refund.bind(h.gateway)
    h.gateway.refund = async (input) => {
      sent++
      return original(input)
    }
    const approve = () =>
      h.call('POST', `/admin/refunds/${refund?.id}/approve`, { amount: 100000 }, admin)
    await Promise.all([approve(), approve()])
    await approve()
    expect(sent).toBe(1)
  })
})

describe('Idempotency-Key waits', () => {
  async function blockedBooking(h: Harness) {
    const { coach, lesson } = h.seed()
    const t = await h.student('a')
    const real = h.gateway.createOrder.bind(h.gateway)
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    h.gateway.createOrder = async (input) => {
      await gate
      return real(input)
    }
    const body = { slotId: h.slot(coach.id).id, lessonTypeId: lesson.id, payWith: 'wechat' }
    return { t, body, release }
  }

  it('lets a repeat wait out a slow WeChat call', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const h = setup()
      const { t, body, release } = await blockedBooking(h)
      // The clock moves with the timers, as a real wait would.
      const pass = async (ms: number) => {
        for (let at = 0; at < ms; at += 1000) {
          h.clock.now = new Date(h.clock.now.getTime() + 1000)
          await vi.advanceTimersByTimeAsync(1000)
        }
      }
      const first = keyed(h, '/bookings', body, t, 'slow')
      await vi.advanceTimersByTimeAsync(0)
      // The mini program gives up after 15 seconds and sends the same request again.
      await pass(16_000)
      let repeated = false
      const repeat = keyed(h, '/bookings', body, t, 'slow').finally(() => {
        repeated = true
      })
      // The first is still running 36 seconds in, and the resend waits for it.
      await pass(20_000)
      expect(repeated).toBe(false)
      release()
      await vi.advanceTimersByTimeAsync(100)
      const [a, b] = await Promise.all([first, repeat])
      expect(a.status).toBe(201)
      expect(b).toEqual(a)
      expect(h.db.select().from(orders).all()).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('answers with the response even when it cannot be kept', async () => {
    const h = setup()
    const { t, body, release } = await blockedBooking(h)
    release()
    h.db.$client.exec(
      "create trigger keys_full before update on idempotency_keys begin select raise(abort, 'disk full'); end",
    )
    const res = await keyed(h, '/bookings', body, t, 'k')
    expect(res.status).toBe(201)
    expect(h.logs.map((l) => l.message)).toContain('idempotency key not saved')
    // The booking is done, so a repeat is not run again.
    h.clock.now = new Date(h.clock.now.getTime() + 60_000)
    expect((await keyed(h, '/bookings', body, t, 'k')).json.error.code).toBe('in_progress')
    expect(h.db.select().from(bookings).all()).toHaveLength(1)
  })
})
