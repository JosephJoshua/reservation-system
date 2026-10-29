import {
  REFUND_PAID_TWICE,
  REFUND_UNDONE_AFTER_SETTLE,
  type RefundSettleWay,
  settledRefundWarning,
} from '@rs/shared'
import { and, eq, inArray, isNotNull, isNull, lt, ne, notInArray, or, sql } from 'drizzle-orm'
import { immediate, type Q } from '../db/client'
import { orders, refunds } from '../db/schema'
import type { Deps } from '../deps'
import { ApiError, notFound } from '../errors'
import { GatewayError, type RefundState, UNKNOWN_OUTCOME } from '../pay/gateway'
import { newOutRefundNo } from './ids'
import { closeRefundedRequests } from './invoices'

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
 * Adds a pending refund row inside the caller's transaction. WeChat Pay refunds are then sent;
 * offline ones stay pending until staff mark them paid back at the front desk.
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
  },
): number {
  const order = tx.select().from(orders).where(eq(orders.id, input.orderId)).get()
  if (order?.status !== 'paid') throw new ApiError(409, 'order_not_paid', '订单未支付')
  if (input.amount <= 0 || input.amount > order.amount - refundedSoFar(tx, order.id)) {
    throw new ApiError(409, 'refund_too_large', '退款金额超过可退金额')
  }
  const row = tx
    .insert(refunds)
    .values({
      outRefundNo: newOutRefundNo(now),
      orderId: order.id,
      amount: input.amount,
      reason: input.reason,
      status: 'pending',
      bookingId: input.bookingId,
      packageId: input.packageId,
      updatedAt: now,
    })
    .returning({ id: refunds.id })
    .get()
  return row.id
}

// Shown to staff on a refund marked failed that went through after all, on top of other refunds
// of the order that add up to more than was paid.
const OVER_REFUNDED_NOTE = '该退款实际已成功，与其他退款合计超过实付金额，请核对'

// Shown to staff on a refund WeChat Pay reports as ABNORMAL (the card the money goes back to was
// cancelled or frozen); it settles once handled on the merchant platform.
export const ABNORMAL_NOTE = '退款异常：原路退回失败，请在微信支付商户平台处理'

/** The row update for a refund state WeChat Pay reported. */
function stateUpdate(result: RefundState): Partial<typeof refunds.$inferInsert> {
  switch (result.status) {
    case 'succeeded':
      return {
        status: 'succeeded',
        providerRefundId: result.refundId,
        failure: null,
        abnormal: false,
      }
    case 'processing':
      return {
        status: 'processing',
        ...(result.refundId ? { providerRefundId: result.refundId } : {}),
        failure: result.abnormal ? ABNORMAL_NOTE : null,
        abnormal: result.abnormal === true,
      }
    case 'failed':
      return { status: 'failed', failure: result.reason, abnormal: false }
  }
}

/**
 * Sends a pending refund to WeChat Pay. A call whose outcome is unknown (network errors, rate
 * limits, server errors, an answer that cannot be verified) leaves it pending for the sweeper,
 * which asks WeChat Pay about the same refund number before sending it again.
 */
export async function submitRefund(deps: Deps, refundId: number): Promise<void> {
  const { db } = deps
  const row = db
    .select({ refund: refunds, order: orders })
    .from(refunds)
    .innerJoin(orders, eq(orders.id, refunds.orderId))
    .where(eq(refunds.id, refundId))
    .get()
  if (row?.refund.status !== 'pending' || row.order.provider !== 'wechat') return
  let result: RefundState
  try {
    result = await deps.gateway.refund({
      outTradeNo: row.order.outTradeNo,
      outRefundNo: row.refund.outRefundNo,
      amount: row.refund.amount,
      total: row.order.amount,
      reason: row.refund.reason,
    })
  } catch (e) {
    deps.log('refund submit failed', { refundId, error: (e as Error).message })
    if (outcomeUnknown(e)) return
    // WeChat Pay refused it outright, so no refund was made under this number.
    result = { status: 'failed', reason: (e as GatewayError).message.slice(0, 200) }
  }
  applyRefundState(deps, row.refund.outRefundNo, result, ['pending'])
}

/** Whether a failed call to WeChat Pay may still have taken effect, or is worth another try. */
function outcomeUnknown(e: unknown) {
  if (!(e instanceof GatewayError)) return true
  const status = e.status ?? 0
  return UNKNOWN_OUTCOME.has(e.code) || status === 429 || status >= 500
}

/**
 * Records what WeChat Pay says about a refund number, for a row in one of `from`. Returns
 * whether a row changed.
 */
function applyRefundState(
  deps: Deps,
  outRefundNo: string,
  result: RefundState,
  from: (typeof refunds.$inferSelect)['status'][],
) {
  return immediate(deps.db, (tx) => {
    const row = tx
      .select({ refund: refunds, total: orders.amount })
      .from(refunds)
      .innerJoin(orders, eq(orders.id, refunds.orderId))
      .where(and(eq(refunds.outRefundNo, outRefundNo), inArray(refunds.status, from)))
      .get()
    if (!row) return false
    const update = stateUpdate(result)
    // A refund marked failed that went through after all, while another refund of the same order
    // was made meanwhile: both are real, so record it, but warn staff that the order has been
    // refunded more than it was paid.
    if (
      row.refund.status === 'failed' &&
      result.status !== 'failed' &&
      refundedSoFar(tx, row.refund.orderId) + row.refund.amount > row.total
    ) {
      update.failure = OVER_REFUNDED_NOTE
      deps.log('refund settled after a replacement, order over-refunded', {
        refundId: row.refund.id,
        orderId: row.refund.orderId,
      })
    }
    tx.update(refunds)
      .set({ ...update, updatedAt: deps.now() })
      .where(eq(refunds.id, row.refund.id))
      .run()
    if (result.status === 'succeeded') closeRefundedRequests(tx, row.refund.orderId)
    return true
  })
}

/**
 * Applies a refund result from a callback or query. A success also settles a row marked failed
 * under the same number: WeChat Pay has the last word on whether the money went back.
 */
export function settleRefund(deps: Deps, outRefundNo: string, result: RefundState) {
  if (result.status === 'succeeded') recordPaidTwice(deps, outRefundNo, result.refundId)
  else recordUndoneAfterSettle(deps, outRefundNo, result)
  applyRefundState(
    deps,
    outRefundNo,
    result,
    result.status === 'succeeded' ? ['pending', 'processing', 'failed'] : ['pending', 'processing'],
  )
}

/** What WeChat Pay has under a refund number, or null when it never received it. */
async function lookUpRefund(deps: Deps, outRefundNo: string): Promise<RefundState | null> {
  try {
    return await deps.gateway.queryRefund(outRefundNo)
  } catch (e) {
    if (e instanceof GatewayError && e.code === 'RESOURCE_NOT_EXISTS') return null
    throw e
  }
}

/**
 * Settles stuck pending refunds and polls processing ones. Run by the sweeper. A pending refund
 * may have reached WeChat Pay with the answer lost, so it is asked about first and sent (under
 * the same number) only when WeChat Pay never got it.
 */
export async function sweepRefunds(deps: Deps) {
  const cutoff = new Date(deps.now().getTime() - 60_000)
  const rows = deps.db
    .select({ id: refunds.id, outRefundNo: refunds.outRefundNo, status: refunds.status })
    .from(refunds)
    // Offline refunds wait for the front desk, not for WeChat Pay.
    .innerJoin(orders, eq(orders.id, refunds.orderId))
    .where(
      and(
        inArray(refunds.status, ['pending', 'processing']),
        lt(refunds.updatedAt, cutoff),
        eq(orders.provider, 'wechat'),
      ),
    )
    .all()
  for (const row of rows) {
    try {
      const state = await lookUpRefund(deps, row.outRefundNo)
      if (state) settleRefund(deps, row.outRefundNo, state)
      else if (row.status === 'pending') await submitRefund(deps, row.id)
    } catch (e) {
      deps.log('refund sweep failed', { refundId: row.id, error: (e as Error).message })
    }
  }
}

/**
 * Puts a failed refund back in the queue and sends it. WeChat Pay is asked about the old refund
 * number first: a refund marked failed may have gone through after all, and sending a new number
 * then would refund twice. A new number is used only when WeChat Pay closed the old one (it
 * answers a repeated number with the old, closed refund); one it never received is sent again
 * as it is.
 */
export async function retryRefund(
  deps: Deps,
  refundId: number,
): Promise<'resent' | 'updated' | false> {
  const now = deps.now()
  const row = deps.db
    .select({ refund: refunds, provider: orders.provider })
    .from(refunds)
    .innerJoin(orders, eq(orders.id, refunds.orderId))
    .where(eq(refunds.id, refundId))
    .get()
  if (row?.refund.status !== 'failed') {
    // A repeated retry finds the refund already on its way, which is what it asked for.
    if (row && ['pending', 'processing', 'succeeded'].includes(row.refund.status)) return false
    throw new ApiError(409, 'refund_not_failed', '只能重试失败的退款')
  }
  const old = row.refund.outRefundNo
  let outRefundNo = old
  if (row.provider === 'wechat') {
    let state: RefundState | null
    try {
      state = await lookUpRefund(deps, old)
    } catch (e) {
      deps.log('refund query failed', { refundId, error: (e as Error).message })
      throw new ApiError(502, 'payment_unavailable', '微信支付暂时不可用，请稍后再试')
    }
    if (state && state.status !== 'failed') {
      // On its way or done under the old number: record that instead of refunding again.
      return applyRefundState(deps, old, state, ['failed']) ? 'updated' : false
    }
    if (state) outRefundNo = newOutRefundNo(now)
  }
  const changed = immediate(deps.db, (tx) => {
    // Other refunds of the order made since it failed may leave too little to refund it again.
    const total = tx
      .select({ amount: orders.amount })
      .from(orders)
      .where(eq(orders.id, row.refund.orderId))
      .get()?.amount
    if (total === undefined || refundedSoFar(tx, row.refund.orderId) + row.refund.amount > total) {
      throw new ApiError(409, 'refund_too_large', '退款金额超过可退金额')
    }
    return tx
      .update(refunds)
      .set({ status: 'pending', failure: null, outRefundNo, updatedAt: now })
      .where(
        and(eq(refunds.id, refundId), eq(refunds.status, 'failed'), eq(refunds.outRefundNo, old)),
      )
      .run()
  })
  // Another retry got there first.
  if (changed.changes === 0) return false
  await submitRefund(deps, refundId)
  return 'resent'
}

/** A refund staff may settle outside the system: failed, or stuck as 退款异常. */
const settleable = (r: { status: string; abnormal: boolean }) =>
  r.status === 'failed' || (r.status === 'processing' && r.abnormal)

/**
 * Staff settled a WeChat Pay refund outside the system, in cash or on the merchant platform: one
 * that failed, or one WeChat Pay reports as 退款异常. The venue no longer owes it, so it counts as
 * refunded from now, with their note. WeChat Pay is asked about it first, as for a retry: one
 * that went through after all is recorded as such instead, so the money is not handed back
 * twice. `repeat` is a settle already recorded with this note; `overtaken` means a retry, WeChat
 * Pay or another settle got there first, and the refund is as the caller then finds it.
 */
export async function settleFailedRefund(
  deps: Deps,
  refundId: number,
  how: RefundSettleWay,
  note: string,
): Promise<'settled' | 'updated' | 'repeat' | 'overtaken'> {
  const row = deps.db
    .select({ refund: refunds, provider: orders.provider })
    .from(refunds)
    .innerJoin(orders, eq(orders.id, refunds.orderId))
    .where(eq(refunds.id, refundId))
    .get()
  if (!row) throw notFound('退款')
  if (
    row.refund.status === 'succeeded' &&
    row.refund.settledNote === note &&
    row.refund.settledHow === how
  ) {
    return 'repeat'
  }
  // Another tab retried it, or WeChat Pay or another staff member settled it, meanwhile: the
  // caller says how it now stands instead of refusing.
  if (
    row.provider === 'wechat' &&
    !settleable(row.refund) &&
    ['pending', 'processing', 'succeeded'].includes(row.refund.status)
  ) {
    return 'overtaken'
  }
  if (!settleable(row.refund) || row.provider !== 'wechat') {
    throw new ApiError(409, 'refund_not_failed', '只能处理退款失败或退款异常的微信支付退款')
  }
  const old = row.refund.outRefundNo
  let state: RefundState | null
  try {
    state = await lookUpRefund(deps, old)
  } catch (e) {
    deps.log('refund query failed', { refundId, error: (e as Error).message })
    throw new ApiError(502, 'payment_unavailable', '微信支付暂时不可用，请稍后再试')
  }
  // Done, or on its way and not stuck: WeChat Pay's word stands.
  const stuck =
    !state ||
    state.status === 'failed' ||
    (state.status === 'processing' && state.abnormal === true)
  if (!stuck && state) {
    return applyRefundState(deps, old, state, ['failed', 'processing']) ? 'updated' : 'overtaken'
  }
  const now = deps.now()
  return immediate(deps.db, (tx) => {
    const current = tx.select().from(refunds).where(eq(refunds.id, refundId)).get()
    // A retry, or WeChat Pay, got there first.
    if (!current || current.outRefundNo !== old || !settleable(current)) return 'overtaken'
    const total = tx
      .select({ amount: orders.amount })
      .from(orders)
      .where(eq(orders.id, current.orderId))
      .get()?.amount
    // A refund stuck in processing is counted already; a failed one is not.
    const adding = current.status === 'failed' ? current.amount : 0
    if (total === undefined || refundedSoFar(tx, current.orderId) + adding > total) {
      throw new ApiError(409, 'refund_too_large', '退款金额超过可退金额')
    }
    tx.update(refunds)
      .set({
        status: 'succeeded',
        settledNote: note,
        settledHow: how,
        // Kept as what WeChat Pay last said, so a later report that differs can be told apart
        // from a repeat. Readers show it as history, not as something to handle.
        failure: state ? stateUpdate(state).failure : current.failure,
        abnormal: false,
        updatedAt: now,
      })
      .where(eq(refunds.id, refundId))
      .run()
    closeRefundedRequests(tx, current.orderId)
    return 'settled' as const
  })
}

/**
 * WeChat Pay reports a refund done that staff had settled outside the system. Its refund id is
 * recorded. Settled 商户平台处理, that is most likely the same refund put right there; paid back
 * 线下另付, the money may have gone back twice, so staff are warned. Neither moves the refund's
 * time, which places it in a report month.
 */
function recordPaidTwice(deps: Deps, outRefundNo: string, refundId: string) {
  const settled = and(
    eq(refunds.outRefundNo, outRefundNo),
    eq(refunds.status, 'succeeded'),
    isNotNull(refunds.settledNote),
  )
  const warned = deps.db
    .update(refunds)
    .set({ providerRefundId: refundId, failure: REFUND_PAID_TWICE })
    .where(
      and(
        settled,
        eq(refunds.settledHow, 'offline'),
        or(isNull(refunds.failure), ne(refunds.failure, REFUND_PAID_TWICE)),
      ),
    )
    .run()
  if (warned.changes > 0) deps.log('refund paid back by staff also made by wechat', { outRefundNo })
  deps.db
    .update(refunds)
    .set({ providerRefundId: refundId })
    .where(
      and(settled, or(isNull(refunds.providerRefundId), ne(refunds.providerRefundId, refundId))),
    )
    .run()
}

/**
 * WeChat Pay reports a refund closed or 退款异常 that staff had settled outside the system, when
 * it said otherwise when they settled it (a repeat of what it said then is no news). The refund
 * stays settled, but staff are warned to check the student got the money. A warning that it was
 * also refunded through WeChat Pay is kept, as is the refund's time.
 */
function recordUndoneAfterSettle(deps: Deps, outRefundNo: string, result: RefundState) {
  if (result.status === 'succeeded' || (result.status === 'processing' && !result.abnormal)) return
  const reported = stateUpdate(result).failure ?? null
  const row = deps.db
    .select({ id: refunds.id, failure: refunds.failure })
    .from(refunds)
    .where(
      and(
        eq(refunds.outRefundNo, outRefundNo),
        eq(refunds.status, 'succeeded'),
        isNotNull(refunds.settledNote),
      ),
    )
    .get()
  if (!row || row.failure === reported || settledRefundWarning(row.failure)) return
  const warned = deps.db
    .update(refunds)
    .set({ failure: REFUND_UNDONE_AFTER_SETTLE })
    .where(
      and(
        eq(refunds.id, row.id),
        row.failure === null ? isNull(refunds.failure) : eq(refunds.failure, row.failure),
      ),
    )
    .run()
  if (warned.changes > 0) {
    deps.log('refund settled by staff later reported not done by wechat', {
      refundId: row.id,
      outRefundNo,
      status: result.status === 'failed' ? result.reason : 'ABNORMAL',
    })
  }
}

/**
 * Staff handed an offline refund back at the front desk. Returns false for a repeat of a
 * hand-back already recorded.
 */
export function markOfflineRefundPaid(deps: Deps, refundId: number) {
  const now = deps.now()
  return immediate(deps.db, (tx) => {
    const row = tx
      .select({ status: refunds.status, provider: orders.provider, orderId: refunds.orderId })
      .from(refunds)
      .innerJoin(orders, eq(orders.id, refunds.orderId))
      .where(eq(refunds.id, refundId))
      .get()
    if (!row) throw notFound('退款')
    if (row.provider === 'offline' && row.status === 'succeeded') return false
    // Sent back through WeChat Pay, so not handed back at the desk.
    if (row.provider !== 'offline') {
      throw new ApiError(
        409,
        'refund_not_offline',
        row.status === 'failed'
          ? '这笔退款走微信支付，请重试或标为已另行退款'
          : '这笔退款走微信支付原路退回，无需线下退还',
      )
    }
    if (row.status !== 'pending') {
      throw new ApiError(409, 'refund_not_pending', '该退款已处理')
    }
    tx.update(refunds)
      .set({ status: 'succeeded', updatedAt: now })
      .where(eq(refunds.id, refundId))
      .run()
    closeRefundedRequests(tx, row.orderId)
    return true
  })
}
