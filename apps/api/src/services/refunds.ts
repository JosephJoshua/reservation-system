import { and, eq, inArray, lt, notInArray, sql } from 'drizzle-orm'
import { immediate, type Q } from '../db/client'
import { orders, refunds } from '../db/schema'
import type { Deps } from '../deps'
import { ApiError } from '../errors'
import { GatewayError, type RefundState } from '../pay/gateway'
import { newOutRefundNo } from './ids'

/** Fen already refunded or on its way back for an order. */
export function refundedSoFar(tx: Q, orderId: number): number {
  const row = tx
    .select({ total: sql<number>`coalesce(sum(${refunds.amount}), 0)` })
    .from(refunds)
    .where(
      and(
        eq(refunds.orderId, orderId),
        notInArray(refunds.status, ['failed', 'rejected', 'requested']),
      ),
    )
    .get()
  return row?.total ?? 0
}

/**
 * Adds a refund row inside the caller's transaction. Offline orders are refunded by hand at the
 * front desk, so their refund is recorded as done.
 */
export function createRefund(
  tx: Q,
  now: Date,
  input: {
    orderId: number
    amount: number
    reason: string
    bookingId?: number
    packageId?: number
    status?: 'pending' | 'requested'
  },
): number {
  const order = tx.select().from(orders).where(eq(orders.id, input.orderId)).get()
  if (order?.status !== 'paid') throw new ApiError(409, 'order_not_paid', '订单未支付')
  if (input.amount <= 0 || input.amount > order.amount - refundedSoFar(tx, order.id)) {
    throw new ApiError(409, 'refund_too_large', '退款金额超过可退金额')
  }
  const status = input.status ?? (order.provider === 'offline' ? 'succeeded' : 'pending')
  const row = tx
    .insert(refunds)
    .values({
      outRefundNo: newOutRefundNo(now),
      orderId: order.id,
      amount: input.amount,
      reason: input.reason,
      status,
      bookingId: input.bookingId,
      packageId: input.packageId,
      updatedAt: now,
    })
    .returning({ id: refunds.id })
    .get()
  return row.id
}

/** Sends a pending refund to WeChat Pay. Network and server errors leave it pending for a retry. */
export async function submitRefund(deps: Deps, refundId: number): Promise<void> {
  const { db } = deps
  const row = db
    .select({ refund: refunds, order: orders })
    .from(refunds)
    .innerJoin(orders, eq(orders.id, refunds.orderId))
    .where(eq(refunds.id, refundId))
    .get()
  if (row?.refund.status !== 'pending' || row.order.provider !== 'wechat') return
  let update: Partial<typeof refunds.$inferInsert>
  try {
    const result = await deps.gateway.refund({
      outTradeNo: row.order.outTradeNo,
      outRefundNo: row.refund.outRefundNo,
      amount: row.refund.amount,
      total: row.order.amount,
      reason: row.refund.reason,
    })
    update =
      result.status === 'failed'
        ? { status: 'failed', failure: result.reason }
        : { status: result.status, providerRefundId: result.refundId }
  } catch (e) {
    const retryable = !(e instanceof GatewayError) || e.code === 'NETWORK' || (e.status ?? 0) >= 500
    deps.log('refund submit failed', { refundId, error: (e as Error).message })
    if (retryable) return
    update = { status: 'failed', failure: (e as GatewayError).message.slice(0, 200) }
  }
  db.update(refunds)
    .set({ ...update, updatedAt: deps.now() })
    .where(and(eq(refunds.id, refundId), eq(refunds.status, 'pending')))
    .run()
}

/** Applies a refund result from a callback or query. */
export function settleRefund(deps: Deps, outRefundNo: string, result: RefundState) {
  if (result.status === 'processing') return
  deps.db
    .update(refunds)
    .set(
      result.status === 'failed'
        ? { status: 'failed', failure: result.reason, updatedAt: deps.now() }
        : { status: 'succeeded', providerRefundId: result.refundId, updatedAt: deps.now() },
    )
    .where(
      and(eq(refunds.outRefundNo, outRefundNo), inArray(refunds.status, ['pending', 'processing'])),
    )
    .run()
}

/** Retries stuck pending refunds and polls processing ones. Run by the sweeper. */
export async function sweepRefunds(deps: Deps) {
  const cutoff = new Date(deps.now().getTime() - 60_000)
  const rows = deps.db
    .select({ id: refunds.id, outRefundNo: refunds.outRefundNo, status: refunds.status })
    .from(refunds)
    .where(and(inArray(refunds.status, ['pending', 'processing']), lt(refunds.updatedAt, cutoff)))
    .all()
  for (const row of rows) {
    try {
      if (row.status === 'pending') await submitRefund(deps, row.id)
      else settleRefund(deps, row.outRefundNo, await deps.gateway.queryRefund(row.outRefundNo))
    } catch (e) {
      deps.log('refund sweep failed', { refundId: row.id, error: (e as Error).message })
    }
  }
}

/** Puts a failed refund back in the queue and sends it. */
export async function retryRefund(deps: Deps, refundId: number) {
  const changed = immediate(deps.db, (tx) =>
    tx
      .update(refunds)
      .set({ status: 'pending', failure: null, updatedAt: deps.now() })
      .where(and(eq(refunds.id, refundId), eq(refunds.status, 'failed')))
      .run(),
  )
  if (changed.changes === 0) throw new ApiError(409, 'refund_not_failed', '只能重试失败的退款')
  await submitRefund(deps, refundId)
}
