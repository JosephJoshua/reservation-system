import { REFUND_PAID_TWICE, REFUND_UNDONE_AFTER_SETTLE, REFUND_WECHAT_CONFIRMED } from '@rs/shared'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { actionLog, refunds } from './db/schema'
import { GatewayError } from './pay/gateway'
import { ABNORMAL_NOTE, settleRefund } from './services/refunds'
import { type Harness, setup } from './test/harness'

/** A paid lesson the venue cancelled, whose WeChat Pay refund failed for good. */
async function failedRefund(h: Harness) {
  const { coach, lesson } = h.seed()
  const slot = h.slot(coach.id)
  const t = await h.student('a')
  await h.call('PUT', '/me', { name: '小红' }, t)
  const b = await h.call('POST', '/bookings', { slotId: slot.id, lessonTypeId: lesson.id }, t)
  await h.fakePay(b.json.orderId)
  h.gateway.refundMode = 'fail'
  const admin = await h.admin()
  const c = await h.call(
    'POST',
    `/admin/bookings/${b.json.bookingId}/cancel`,
    { reason: '教练生病' },
    admin,
  )
  expect(c.status).toBeLessThan(300)
  const refund = h.db.select().from(refunds).get()
  expect(refund?.status).toBe('failed')
  return { t, admin, orderId: b.json.orderId as number, refundId: refund?.id as number }
}

describe('a failed WeChat Pay refund settled outside the system', () => {
  it('stops blocking 注销 and 发票 once settled, and is logged once', async () => {
    const h = setup()
    const { t, admin, orderId, refundId } = await failedRefund(h)
    expect((await h.call('DELETE', '/me', undefined, t)).status).toBe(409)

    const settle = () =>
      h.call(
        'POST',
        `/admin/refunds/${refundId}/settled`,
        { how: 'offline', note: '已现金退还' },
        admin,
        {
          'Idempotency-Key': 'settle-1',
        },
      )
    const res = await settle()
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ status: 'succeeded', settled: true })
    expect((await settle()).status).toBe(200)
    // The same settle again without the key is a repeat too.
    const bare = await h.call(
      'POST',
      `/admin/refunds/${refundId}/settled`,
      { how: 'offline', note: '已现金退还' },
      admin,
    )
    expect(bare.status).toBe(200)
    const row = h.db.select().from(refunds).where(eq(refunds.id, refundId)).get()
    expect(row).toMatchObject({ status: 'succeeded', settledNote: '已现金退还' })
    const logged = h.db.select().from(actionLog).where(eq(actionLog.action, 'refund.settled')).all()
    expect(logged).toHaveLength(1)
    expect(logged[0]?.summary).toContain('已另行退款（线下另付）：已现金退还')

    // Fully refunded now, so no invoice; and nothing is owed, so the account can go.
    const inv = await h.call(
      'POST',
      '/invoices',
      { orderId, kind: 'personal', name: '小红', email: 'a@b.cn' },
      t,
    )
    expect(inv.json.error.code).toBe('order_refunded')
    const exported = await h.app.request(
      '/api/admin/exports/refunds?from=2026-10-01&to=2026-10-31',
      {
        headers: { Authorization: `Bearer ${admin}` },
      },
    )
    const csv = await exported.text()
    expect(csv).toContain('已另行退款')
    expect(csv).toContain('线下另付；已现金退还；微信支付退款失败：fake failure')
    expect((await h.call('DELETE', '/me', undefined, t)).status).toBe(204)
  })

  it('tells the student how the refund was paid back', async () => {
    const h = setup()
    const { t, admin, refundId } = await failedRefund(h)
    const bookingId = h.db.select().from(refunds).get()?.bookingId
    const view = async () => (await h.call('GET', `/bookings/${bookingId}`, undefined, t)).json
    expect((await view()).refund).toEqual({ amount: 20000, status: 'failed', settledHow: null })
    const res = await h.call(
      'POST',
      `/admin/refunds/${refundId}/settled`,
      { how: 'offline', note: '已现金退还' },
      admin,
    )
    expect(res.status).toBe(200)
    expect((await view()).refund).toEqual({
      amount: 20000,
      status: 'succeeded',
      settledHow: 'offline',
    })
  })

  it('needs a note, the finance role, and a refund that failed', async () => {
    const h = setup()
    const { admin, refundId } = await failedRefund(h)
    const empty = await h.call(
      'POST',
      `/admin/refunds/${refundId}/settled`,
      { how: 'offline', note: ' ' },
      admin,
    )
    expect(empty.status).toBe(400)
    const noWay = await h.call(
      'POST',
      `/admin/refunds/${refundId}/settled`,
      { note: '已现金退还' },
      admin,
    )
    expect(noWay.json.error.message).toContain('处理方式')
    const desk = await h.call(
      'POST',
      '/admin/staff',
      { name: '前台', username: 'desk', password: 'password1', roles: ['front_desk'] },
      admin,
    )
    expect(desk.status).toBe(201)
    const deskToken = await h.admin('desk', 'password1')
    const refused = await h.call(
      'POST',
      `/admin/refunds/${refundId}/settled`,
      { how: 'offline', note: '已现金退还' },
      deskToken,
    )
    expect(refused.status).toBe(403)
    await h.call(
      'POST',
      `/admin/refunds/${refundId}/settled`,
      { how: 'offline', note: '已现金退还' },
      admin,
    )
    // Settled already, as another staff member would find it from a stale page.
    const other = await h.call(
      'POST',
      `/admin/refunds/${refundId}/settled`,
      { how: 'offline', note: '另一种说法' },
      admin,
    )
    expect(other.status).toBe(200)
    expect(other.json).toMatchObject({ settled: false, message: '该退款已标为另行退款' })
    expect(h.db.select().from(refunds).get()?.settledNote).toBe('已现金退还')
    const logged = h.db.select().from(actionLog).where(eq(actionLog.action, 'refund.settled')).all()
    expect(logged).toHaveLength(1)
  })

  it('records a refund WeChat Pay had done after all instead of settling it', async () => {
    const h = setup()
    const { admin, refundId } = await failedRefund(h)
    const row = h.db.select().from(refunds).where(eq(refunds.id, refundId)).get()
    vi.spyOn(h.gateway, 'queryRefund').mockResolvedValue({
      status: 'succeeded',
      refundId: 'wx-late',
    })
    const res = await h.call(
      'POST',
      `/admin/refunds/${refundId}/settled`,
      { how: 'offline', note: '已现金退还' },
      admin,
    )
    expect(res.json).toMatchObject({ status: 'succeeded', settled: false })
    const after = h.db.select().from(refunds).where(eq(refunds.id, refundId)).get()
    expect(after).toMatchObject({ settledNote: null, providerRefundId: 'wx-late' })
    expect(after?.outRefundNo).toBe(row?.outRefundNo)
  })

  it('is not settled while WeChat Pay cannot be asked', async () => {
    const h = setup()
    const { admin, refundId } = await failedRefund(h)
    vi.spyOn(h.gateway, 'queryRefund').mockRejectedValue(
      new GatewayError('down', 'SYSTEM_ERROR', 500),
    )
    const res = await h.call(
      'POST',
      `/admin/refunds/${refundId}/settled`,
      { how: 'offline', note: '已现金退还' },
      admin,
    )
    expect(res.status).toBe(502)
    expect(h.db.select().from(refunds).get()?.status).toBe('failed')
  })

  it('tells staff a WeChat Pay refund is not handed back at the desk', async () => {
    const h = setup()
    const { admin, refundId } = await failedRefund(h)
    const res = await h.call('POST', `/admin/refunds/${refundId}/paid-back`, {}, admin)
    expect(res.status).toBe(409)
    expect(res.json.error).toMatchObject({
      code: 'refund_not_offline',
      message: '这笔退款走微信支付，请重试或标为已另行退款',
    })
  })

  it('reports a settle that a retry overtook as not settled, and logs no settle', async () => {
    const h = setup()
    const { admin, refundId } = await failedRefund(h)
    h.gateway.refundMode = 'succeeded'
    const query = h.gateway.queryRefund.bind(h.gateway)
    let first = true
    // The settle's query to WeChat Pay answers only after the retry is done.
    h.gateway.queryRefund = async (no: string) => {
      const state = await query(no)
      if (first) {
        first = false
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
      return state
    }
    const settling = h.call(
      'POST',
      `/admin/refunds/${refundId}/settled`,
      { how: 'offline', note: '已现金退还' },
      admin,
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    const retry = await h.call('POST', `/admin/refunds/${refundId}/retry`, {}, admin)
    expect(retry.json).toMatchObject({ status: 'succeeded', resent: true })
    const settle = await settling
    expect(settle.json).toMatchObject({
      status: 'succeeded',
      settled: false,
      message: '微信支付已退款，无需另行退款',
    })
    expect(h.db.select().from(refunds).get()?.settledNote).toBeNull()
    const actions = h.db.select({ action: actionLog.action }).from(actionLog).all()
    expect(actions.map((a) => a.action)).not.toContain('refund.settled')
  })

  it('warns staff when WeChat Pay later refunds one they paid back 线下另付', async () => {
    const h = setup()
    const { admin, refundId } = await failedRefund(h)
    await h.call(
      'POST',
      `/admin/refunds/${refundId}/settled`,
      { how: 'offline', note: '已现金退还' },
      admin,
    )
    const row = h.db.select().from(refunds).where(eq(refunds.id, refundId)).get()
    // Next month: the refund stays in the month it was settled.
    h.clock.now = new Date('2026-11-05T02:00:00Z')
    settleRefund(h.deps, row?.outRefundNo ?? '', { status: 'succeeded', refundId: 'wx-late' })
    settleRefund(h.deps, row?.outRefundNo ?? '', { status: 'succeeded', refundId: 'wx-late' })
    expect(h.db.select().from(refunds).where(eq(refunds.id, refundId)).get()).toMatchObject({
      status: 'succeeded',
      settledNote: '已现金退还',
      settledHow: 'offline',
      providerRefundId: 'wx-late',
      failure: REFUND_PAID_TWICE,
      updatedAt: row?.updatedAt,
    })
    // Logged once, however often WeChat Pay says so.
    expect(h.logs.filter((l) => l.message.includes('also made by wechat'))).toHaveLength(1)
    const exported = await h.app.request(
      '/api/admin/exports/refunds?from=2026-10-01&to=2026-10-31',
      { headers: { Authorization: `Bearer ${await h.admin()}` } },
    )
    const csv = await exported.text()
    expect(csv).toContain(`线下另付；已现金退还；${REFUND_PAID_TWICE}`)
    expect(csv).not.toContain(`微信支付退款失败：${REFUND_PAID_TWICE}`)
  })

  it('warns too for one WeChat Pay had numbered before it failed', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const t = await h.student('a')
    const b = await h.call(
      'POST',
      '/bookings',
      { slotId: h.slot(coach.id).id, lessonTypeId: lesson.id },
      t,
    )
    await h.fakePay(b.json.orderId)
    h.gateway.refundMode = 'processing'
    const admin = await h.admin()
    await h.call(
      'POST',
      `/admin/bookings/${b.json.bookingId}/cancel`,
      { reason: '教练生病' },
      admin,
    )
    const refund = h.db.select().from(refunds).get()
    settleRefund(h.deps, refund?.outRefundNo ?? '', { status: 'failed', reason: 'CLOSED' })
    h.db.update(refunds).set({ providerRefundId: 'wx-first' }).run()
    vi.spyOn(h.gateway, 'queryRefund').mockResolvedValue({ status: 'failed', reason: 'CLOSED' })
    const settled = await h.call(
      'POST',
      `/admin/refunds/${refund?.id}/settled`,
      { how: 'offline', note: '已现金退还' },
      admin,
    )
    expect(settled.json.settled).toBe(true)
    settleRefund(h.deps, refund?.outRefundNo ?? '', { status: 'succeeded', refundId: 'wx-late' })
    expect(h.db.select().from(refunds).get()).toMatchObject({
      providerRefundId: 'wx-late',
      failure: REFUND_PAID_TWICE,
    })
  })

  it('only records the refund id for one put right 商户平台处理', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const t = await h.student('a')
    const b = await h.call(
      'POST',
      '/bookings',
      { slotId: h.slot(coach.id).id, lessonTypeId: lesson.id },
      t,
    )
    await h.fakePay(b.json.orderId)
    h.gateway.refundMode = 'abnormal'
    const admin = await h.admin()
    await h.call(
      'POST',
      `/admin/bookings/${b.json.bookingId}/cancel`,
      { reason: '教练生病' },
      admin,
    )
    const refund = h.db.select().from(refunds).get()
    const settled = await h.call(
      'POST',
      `/admin/refunds/${refund?.id}/settled`,
      { how: 'platform', note: '已在商户平台处理' },
      admin,
    )
    expect(settled.json.settled).toBe(true)
    const before = h.db.select().from(refunds).get()
    h.clock.now = new Date('2026-11-05T02:00:00Z')
    settleRefund(h.deps, refund?.outRefundNo ?? '', { status: 'succeeded', refundId: 'wx-fixed' })
    expect(h.db.select().from(refunds).get()).toMatchObject({
      status: 'succeeded',
      settledHow: 'platform',
      providerRefundId: 'wx-fixed',
      failure: REFUND_WECHAT_CONFIRMED,
      updatedAt: before?.updatedAt,
    })
    expect(before?.failure).toBe(ABNORMAL_NOTE)
  })

  it('settles one WeChat Pay reports as 退款异常 too', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const t = await h.student('a')
    const b = await h.call(
      'POST',
      '/bookings',
      { slotId: h.slot(coach.id).id, lessonTypeId: lesson.id },
      t,
    )
    await h.fakePay(b.json.orderId)
    h.gateway.refundMode = 'abnormal'
    const admin = await h.admin()
    await h.call(
      'POST',
      `/admin/bookings/${b.json.bookingId}/cancel`,
      { reason: '教练生病' },
      admin,
    )
    const refund = h.db.select().from(refunds).get()
    expect(refund).toMatchObject({ status: 'processing', abnormal: true })
    const res = await h.call(
      'POST',
      `/admin/refunds/${refund?.id}/settled`,
      { how: 'platform', note: '已在商户平台处理' },
      admin,
    )
    expect(res.json).toMatchObject({ status: 'succeeded', settled: true })
    expect(h.db.select().from(refunds).get()).toMatchObject({
      status: 'succeeded',
      abnormal: false,
      settledNote: '已在商户平台处理',
    })
    // A refund on its way normally is left to WeChat Pay.
    const h2 = setup()
    const other = await failedRefund(h2)
    h2.db.update(refunds).set({ status: 'processing' }).run()
    const refused = await h2.call(
      'POST',
      `/admin/refunds/${other.refundId}/settled`,
      { how: 'offline', note: '已现金退还' },
      other.admin,
    )
    expect(refused.json).toMatchObject({
      status: 'processing',
      settled: false,
      message: '退款已在微信支付处理中，无需另行退款',
    })
    expect(h2.db.select().from(refunds).get()).toMatchObject({
      status: 'processing',
      settledNote: null,
    })
  })

  it('answers a settle from a stale page after another tab retried it', async () => {
    const h = setup()
    const { admin, refundId } = await failedRefund(h)
    const settle = () =>
      h.call(
        'POST',
        `/admin/refunds/${refundId}/settled`,
        { how: 'offline', note: '已现金退还' },
        admin,
      )
    // Retried into WeChat Pay's queue: still on its way.
    h.gateway.refundMode = 'processing'
    expect((await h.call('POST', `/admin/refunds/${refundId}/retry`, {}, admin)).status).toBe(200)
    const onItsWay = await settle()
    expect(onItsWay.status).toBe(200)
    expect(onItsWay.json).toMatchObject({
      status: 'processing',
      settled: false,
      message: '退款已在微信支付处理中，无需另行退款',
    })
    // Then done.
    const row = h.db.select().from(refunds).get()
    settleRefund(h.deps, row?.outRefundNo ?? '', { status: 'succeeded', refundId: 'wx-retry' })
    const done = await settle()
    expect(done.status).toBe(200)
    expect(done.json).toMatchObject({
      status: 'succeeded',
      settled: false,
      message: '微信支付已退款，无需另行退款',
    })
    expect(h.db.select().from(refunds).get()).toMatchObject({ settledNote: null })
    const actions = h.db.select({ action: actionLog.action }).from(actionLog).all()
    expect(actions.map((a) => a.action)).not.toContain('refund.settled')
  })
})

/** A paid lesson the venue cancelled, whose WeChat Pay refund is stuck as 退款异常. */
async function abnormalRefund(h: Harness) {
  const { coach, lesson } = h.seed()
  const t = await h.student('a')
  const b = await h.call(
    'POST',
    '/bookings',
    { slotId: h.slot(coach.id).id, lessonTypeId: lesson.id },
    t,
  )
  await h.fakePay(b.json.orderId)
  h.gateway.refundMode = 'abnormal'
  const admin = await h.admin()
  await h.call('POST', `/admin/bookings/${b.json.bookingId}/cancel`, { reason: '教练生病' }, admin)
  const refund = h.db.select().from(refunds).get()
  expect(refund).toMatchObject({ status: 'processing', abnormal: true })
  return { admin, refundId: refund?.id as number, outRefundNo: refund?.outRefundNo ?? '' }
}

async function refundsCsv(h: Harness) {
  const res = await h.app.request('/api/admin/exports/refunds?from=2026-10-01&to=2026-10-31', {
    headers: { Authorization: `Bearer ${await h.admin()}` },
  })
  return res.text()
}

describe('WeChat Pay reporting on a refund staff already settled', () => {
  it('warns staff when one put right 商户平台处理 is then reported closed', async () => {
    const h = setup()
    const { admin, refundId, outRefundNo } = await abnormalRefund(h)
    const res = await h.call(
      'POST',
      `/admin/refunds/${refundId}/settled`,
      { how: 'platform', note: '已在商户平台处理' },
      admin,
    )
    expect(res.json.settled).toBe(true)
    const before = h.db.select().from(refunds).get()
    const toCheck = async () =>
      (await h.call('GET', '/admin/refunds?check=1', undefined, await h.admin())).json
    expect(await toCheck()).toHaveLength(0)
    h.clock.now = new Date('2026-11-05T02:00:00Z')
    settleRefund(h.deps, outRefundNo, { status: 'failed', reason: 'CLOSED' })
    settleRefund(h.deps, outRefundNo, { status: 'failed', reason: 'CLOSED' })
    // Found with 待核对.
    expect(await toCheck()).toHaveLength(1)
    expect(h.db.select().from(refunds).get()).toMatchObject({
      status: 'succeeded',
      settledHow: 'platform',
      failure: REFUND_UNDONE_AFTER_SETTLE.closed,
      updatedAt: before?.updatedAt,
    })
    expect(h.logs.filter((l) => l.message.includes('later reported not done'))).toHaveLength(1)
    // Shown in the refunds list and the export.
    const list = await h.call('GET', '/admin/refunds', undefined, await h.admin())
    expect(JSON.stringify(list.json)).toContain(REFUND_UNDONE_AFTER_SETTLE.closed)
    const csv = await refundsCsv(h)
    expect(csv).toContain(`商户平台处理；已在商户平台处理；${REFUND_UNDONE_AFTER_SETTLE.closed}`)
    expect(csv).not.toContain('请在微信支付商户平台处理')
  })

  it('warns when one settled from a failure is then reported 退款异常, not on a repeat', async () => {
    const h = setup()
    const { admin, refundId } = await failedRefund(h)
    await h.call(
      'POST',
      `/admin/refunds/${refundId}/settled`,
      { how: 'offline', note: '已现金退还' },
      admin,
    )
    const no = h.db.select().from(refunds).get()?.outRefundNo ?? ''
    // WeChat Pay sends again what it said before the settle: nothing new.
    settleRefund(h.deps, no, { status: 'failed', reason: 'fake failure' })
    settleRefund(h.deps, no, { status: 'processing', refundId: 'wx-1' })
    expect(h.db.select().from(refunds).get()?.failure).toBe('fake failure')
    expect(h.logs.filter((l) => l.message.includes('later reported not done'))).toHaveLength(0)
    settleRefund(h.deps, no, { status: 'processing', refundId: 'wx-1', abnormal: true })
    expect(h.db.select().from(refunds).get()).toMatchObject({
      status: 'succeeded',
      failure: REFUND_UNDONE_AFTER_SETTLE.abnormal,
    })
  })

  it('keeps the warning that WeChat Pay refunded one paid back 线下另付 too', async () => {
    const h = setup()
    const { admin, refundId } = await failedRefund(h)
    await h.call(
      'POST',
      `/admin/refunds/${refundId}/settled`,
      { how: 'offline', note: '已现金退还' },
      admin,
    )
    const no = h.db.select().from(refunds).get()?.outRefundNo ?? ''
    settleRefund(h.deps, no, { status: 'succeeded', refundId: 'wx-late' })
    settleRefund(h.deps, no, { status: 'failed', reason: 'CLOSED' })
    expect(h.db.select().from(refunds).get()?.failure).toBe(REFUND_PAID_TWICE)
  })

  it('does not ask staff to handle a settled 退款异常 in the export', async () => {
    const h = setup()
    const { admin, refundId } = await abnormalRefund(h)
    await h.call(
      'POST',
      `/admin/refunds/${refundId}/settled`,
      { how: 'platform', note: '已在商户平台处理' },
      admin,
    )
    const csv = await refundsCsv(h)
    expect(csv).toContain('商户平台处理；已在商户平台处理；微信支付退款异常')
    expect(csv).not.toContain('请在微信支付商户平台处理')
    expect(csv).not.toContain('微信支付退款失败')
  })

  it('records what WeChat Pay said when settled, for one closed since it was 退款异常', async () => {
    const h = setup()
    const { admin, refundId, outRefundNo } = await abnormalRefund(h)
    vi.spyOn(h.gateway, 'queryRefund').mockResolvedValue({ status: 'failed', reason: 'CLOSED' })
    await h.call(
      'POST',
      `/admin/refunds/${refundId}/settled`,
      { how: 'offline', note: '已现金退还' },
      admin,
    )
    expect(h.db.select().from(refunds).get()).toMatchObject({
      status: 'succeeded',
      failure: 'CLOSED',
    })
    // WeChat Pay's own notice of that close is then no news.
    settleRefund(h.deps, outRefundNo, { status: 'failed', reason: 'CLOSED' })
    expect(h.db.select().from(refunds).get()?.failure).toBe('CLOSED')
    expect(await refundsCsv(h)).toContain('线下另付；已现金退还；微信支付退款失败：CLOSED')
  })

  it('takes CLOSED as final: a 退款异常 sent again after it raises no warning', async () => {
    const h = setup()
    const { admin, refundId, outRefundNo } = await abnormalRefund(h)
    // The 退款异常 notice got no answer; WeChat Pay then closed the refund.
    settleRefund(h.deps, outRefundNo, { status: 'failed', reason: 'CLOSED' })
    vi.spyOn(h.gateway, 'queryRefund').mockResolvedValue({ status: 'failed', reason: 'CLOSED' })
    const res = await h.call(
      'POST',
      `/admin/refunds/${refundId}/settled`,
      { how: 'offline', note: '已现金退还' },
      admin,
    )
    expect(res.json.settled).toBe(true)
    settleRefund(h.deps, outRefundNo, { status: 'processing', refundId: 'wx-1', abnormal: true })
    settleRefund(h.deps, outRefundNo, { status: 'processing', refundId: 'wx-1' })
    expect(h.db.select().from(refunds).get()).toMatchObject({
      status: 'succeeded',
      failure: 'CLOSED',
    })
    const check = await h.call('GET', '/admin/refunds?check=1', undefined, admin)
    expect(JSON.stringify(check.json)).not.toContain(String(outRefundNo))
    expect(h.logs.filter((l) => l.message.includes('later reported not done'))).toHaveLength(0)
    // A success after it still says the money may have gone back twice.
    settleRefund(h.deps, outRefundNo, { status: 'succeeded', refundId: 'wx-2' })
    expect(h.db.select().from(refunds).get()?.failure).toBe(REFUND_PAID_TWICE)
  })

  it('clears the warning once WeChat Pay reports one put right 商户平台处理 done', async () => {
    const h = setup()
    const { admin, refundId, outRefundNo } = await abnormalRefund(h)
    await h.call(
      'POST',
      `/admin/refunds/${refundId}/settled`,
      { how: 'platform', note: '已在商户平台处理' },
      admin,
    )
    settleRefund(h.deps, outRefundNo, { status: 'failed', reason: 'CLOSED' })
    expect(h.db.select().from(refunds).get()?.failure).toBe(REFUND_UNDONE_AFTER_SETTLE.closed)
    settleRefund(h.deps, outRefundNo, { status: 'succeeded', refundId: 'wx-fixed' })
    expect(h.db.select().from(refunds).get()).toMatchObject({
      status: 'succeeded',
      providerRefundId: 'wx-fixed',
      failure: REFUND_WECHAT_CONFIRMED,
    })
    // The earlier CLOSED sent again, or any older report, is no news after the success.
    settleRefund(h.deps, outRefundNo, { status: 'failed', reason: 'CLOSED' })
    settleRefund(h.deps, outRefundNo, { status: 'processing', refundId: 'wx-1', abnormal: true })
    expect(h.db.select().from(refunds).get()?.failure).toBe(REFUND_WECHAT_CONFIRMED)
    expect(h.logs.filter((l) => l.message.includes('later reported not done'))).toHaveLength(1)
    const csv = await refundsCsv(h)
    expect(csv).toContain(`商户平台处理；已在商户平台处理；${REFUND_WECHAT_CONFIRMED}`)
    expect(csv).not.toContain('微信支付退款失败')
  })

  it('says the refund changed when it is still to settle but changed during the query', async () => {
    const h = setup()
    const { admin, refundId } = await abnormalRefund(h)
    vi.spyOn(h.gateway, 'queryRefund').mockImplementation(async () => {
      // As a sweep that rewrote the note of a refund still stuck as 退款异常.
      h.db.update(refunds).set({ failure: '其他说明' }).where(eq(refunds.id, refundId)).run()
      return { status: 'processing', refundId: 'wx-1', abnormal: true }
    })
    const res = await h.call(
      'POST',
      `/admin/refunds/${refundId}/settled`,
      { how: 'platform', note: '已在商户平台处理' },
      admin,
    )
    expect(res.json).toMatchObject({
      status: 'processing',
      settled: false,
      message: '退款状态已变更，请刷新后查看',
    })
    expect(h.db.select().from(refunds).get()?.settledNote).toBeNull()
  })

  it('warns for a refund settled before warnings existed, and for one with no note', async () => {
    const h = setup()
    const { refundId, outRefundNo } = await abnormalRefund(h)
    // As an earlier version left a settled 退款异常: the note kept, the flag cleared.
    const settledBefore = {
      status: 'succeeded' as const,
      settledNote: '已在商户平台处理',
      settledHow: 'platform' as const,
      abnormal: false,
    }
    h.db.update(refunds).set(settledBefore).where(eq(refunds.id, refundId)).run()
    expect(h.db.select().from(refunds).get()?.failure).toBe(ABNORMAL_NOTE)
    settleRefund(h.deps, outRefundNo, { status: 'processing', refundId: 'wx-1', abnormal: true })
    expect(h.db.select().from(refunds).get()?.failure).toBe(ABNORMAL_NOTE)
    settleRefund(h.deps, outRefundNo, { status: 'failed', reason: 'CLOSED' })
    expect(h.db.select().from(refunds).get()?.failure).toBe(REFUND_UNDONE_AFTER_SETTLE.closed)

    h.db.update(refunds).set({ failure: null }).where(eq(refunds.id, refundId)).run()
    settleRefund(h.deps, outRefundNo, { status: 'processing', refundId: 'wx-1', abnormal: true })
    expect(h.db.select().from(refunds).get()?.failure).toBe(REFUND_UNDONE_AFTER_SETTLE.abnormal)
    expect(await refundsCsv(h)).toContain(
      `商户平台处理；已在商户平台处理；${REFUND_UNDONE_AFTER_SETTLE.abnormal}`,
    )
  })

  it('does not settle over a CLOSED report that lands while WeChat Pay is asked', async () => {
    const h = setup()
    const { admin, refundId, outRefundNo } = await abnormalRefund(h)
    vi.spyOn(h.gateway, 'queryRefund').mockImplementation(async () => {
      // The callback lands between the query and its answer.
      settleRefund(h.deps, outRefundNo, { status: 'failed', reason: 'CLOSED' })
      return { status: 'processing', refundId: 'wx-1', abnormal: true }
    })
    const res = await h.call(
      'POST',
      `/admin/refunds/${refundId}/settled`,
      { how: 'platform', note: '已在商户平台处理' },
      admin,
    )
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({
      status: 'failed',
      settled: false,
      message: '退款状态已变更，请刷新后查看',
    })
    expect(h.db.select().from(refunds).get()).toMatchObject({
      status: 'failed',
      failure: 'CLOSED',
      settledNote: null,
    })
    const actions = h.db.select({ action: actionLog.action }).from(actionLog).all()
    expect(actions.map((a) => a.action)).not.toContain('refund.settled')
  })
})
