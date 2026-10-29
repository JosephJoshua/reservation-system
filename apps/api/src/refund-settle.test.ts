import { REFUND_PAID_TWICE } from '@rs/shared'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { actionLog, refunds } from './db/schema'
import { GatewayError } from './pay/gateway'
import { settleRefund } from './services/refunds'
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
    const other = await h.call(
      'POST',
      `/admin/refunds/${refundId}/settled`,
      { how: 'offline', note: '另一种说法' },
      admin,
    )
    expect(other.json.error.code).toBe('refund_not_failed')
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
      failure: before?.failure,
      updatedAt: before?.updatedAt,
    })
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
    expect(refused.json.error.code).toBe('refund_not_failed')
  })
})
