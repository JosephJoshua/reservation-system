import { type CancelledBy, validityEnd } from '@rs/shared'
import { and, eq, gt, inArray, isNotNull, lt } from 'drizzle-orm'
import { immediate, type Q } from '../db/client'
import {
  bookings,
  lessonTypes,
  orders,
  packageLedger,
  packageProducts,
  packages,
  slots,
  students,
} from '../db/schema'
import type { Deps } from '../deps'
import { ApiError, isUniqueViolation, notFound } from '../errors'
import type { OrderState, PaymentParams } from '../pay/gateway'
import { trialsUsed } from './catalog'
import { createRefund, submitRefund } from './refunds'
import { getSettings } from './settings'

// Local expiry waits this long past WeChat's time_expire, so a payment made in the last second
// has time to arrive before the slot is released.
const EXPIRY_GRACE_MS = 2 * 60_000

/** Places a pending order with WeChat Pay and returns what wx.requestPayment needs. */
export async function startPayment(
  deps: Deps,
  orderId: number,
  openid: string,
): Promise<PaymentParams> {
  const order = deps.db.select().from(orders).where(eq(orders.id, orderId)).get()
  if (!order) throw notFound('订单')
  if (order.status !== 'pending' || !order.expiresAt || order.expiresAt <= deps.now()) {
    throw new ApiError(409, 'order_not_payable', '订单已关闭，请重新下单')
  }
  let prepayId = order.prepayId
  if (!prepayId) {
    try {
      prepayId = await deps.gateway.createOrder({
        outTradeNo: order.outTradeNo,
        description: order.description,
        amount: order.amount,
        openid,
        expiresAt: order.expiresAt,
      })
    } catch (e) {
      deps.log('create order failed', { orderId, error: (e as Error).message })
      throw new ApiError(502, 'payment_unavailable', '支付暂时不可用，请稍后再试')
    }
    deps.db.update(orders).set({ prepayId }).where(eq(orders.id, orderId)).run()
  }
  return deps.gateway.paymentParams(prepayId)
}

/**
 * Starts payment for an order just created for the student. If that fails, the order is closed at
 * once so a booking's slot is not held for the whole timeout.
 */
export async function startPaymentOrRelease(
  deps: Deps,
  orderId: number,
  studentId: number,
): Promise<PaymentParams> {
  const student = deps.db
    .select({ openid: students.openid })
    .from(students)
    .where(eq(students.id, studentId))
    .get()
  try {
    return await startPayment(deps, orderId, student?.openid ?? '')
  } catch (e) {
    await closeOrder(deps, orderId).catch((closeError) =>
      deps.log('release order failed', { orderId, error: (closeError as Error).message }),
    )
    throw e
  }
}

/**
 * Records a successful payment. Idempotent: callbacks, queries and the sweeper may all report the
 * same payment. If the booking's slot was released meanwhile and someone else took it, the
 * payment is refunded in full.
 */
export function applyPayment(
  deps: Deps,
  outTradeNo: string,
  paid: Extract<OrderState, { state: 'paid' }>,
): void {
  const refundIds = immediate(deps.db, (tx) => {
    const order = tx.select().from(orders).where(eq(orders.outTradeNo, outTradeNo)).get()
    if (!order) throw notFound('订单')
    if (order.status === 'paid') return []
    // WeChat Pay charges the amount the order was created with, so a difference means something is
    // badly wrong. Refuse to confirm anything; the callback fails and the order needs a person.
    if (paid.amount !== order.amount) {
      deps.log('paid amount differs from order', {
        outTradeNo,
        paid: paid.amount,
        order: order.amount,
      })
      throw new Error(`paid amount ${paid.amount} differs from order amount ${order.amount}`)
    }
    tx.update(orders)
      .set({ status: 'paid', paidAt: paid.paidAt, transactionId: paid.transactionId })
      .where(eq(orders.id, order.id))
      .run()

    if (order.kind === 'package') {
      createPackageFromOrder(tx, order.id, paid.paidAt, 'system')
      return []
    }
    if (!order.bookingId) return []
    const booking = tx.select().from(bookings).where(eq(bookings.id, order.bookingId)).get()
    if (!booking) return []
    if (
      booking.status === 'pending_payment' ||
      (booking.status === 'expired' && revivable(tx, booking, deps.now()))
    ) {
      try {
        tx.update(bookings).set({ status: 'confirmed' }).where(eq(bookings.id, booking.id)).run()
        return []
      } catch (e) {
        if (!isUniqueViolation(e)) throw e
        tx.update(bookings).set({ status: 'expired' }).where(eq(bookings.id, booking.id)).run()
      }
    }
    if (booking.status === 'confirmed') return []
    deps.log('payment for a released slot, refunding', { outTradeNo, bookingId: booking.id })
    return [
      createRefund(tx, deps.now(), {
        orderId: order.id,
        amount: order.amount,
        reason: '时段已被预约，自动退款',
        bookingId: booking.id,
      }),
    ]
  })
  // Runs after the transaction; a failure leaves the refund pending for the sweeper to retry.
  for (const id of refundIds) {
    submitRefund(deps, id).catch((e) =>
      deps.log('refund submit failed', { refundId: id, error: (e as Error).message }),
    )
  }
}

/**
 * Whether a booking whose hold ran out can still be confirmed by a late payment: the lesson is
 * ahead, the slot still takes bookings, a trial is still within the student's limit and the
 * student has not booked that time since. Whether someone else took the slot is left to the
 * unique index.
 */
function revivable(tx: Q, booking: typeof bookings.$inferSelect, now: Date) {
  if (booking.startsAt <= now) return false
  const slot = tx.select({ open: slots.open }).from(slots).where(eq(slots.id, booking.slotId)).get()
  if (!slot?.open) return false
  const lessonType = tx
    .select({ isTrial: lessonTypes.isTrial })
    .from(lessonTypes)
    .where(eq(lessonTypes.id, booking.lessonTypeId))
    .get()
  if (lessonType?.isTrial) {
    const { trialEnabled, trialLimitPerStudent } = getSettings(tx).payment
    if (!trialEnabled || trialsUsed(tx, booking.studentId) >= trialLimitPerStudent) return false
  }
  const clash = tx
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      and(
        eq(bookings.studentId, booking.studentId),
        inArray(bookings.status, ['pending_payment', 'confirmed']),
        lt(bookings.startsAt, booking.endsAt),
        gt(bookings.endsAt, booking.startsAt),
      ),
    )
    .get()
  return !clash
}

/** Creates the student's package for a paid package order. */
export function createPackageFromOrder(
  tx: Q,
  orderId: number,
  paidAt: Date,
  actor: 'system' | 'admin',
): number {
  const order = tx.select().from(orders).where(eq(orders.id, orderId)).get()
  if (!order?.productId) throw new Error(`order ${orderId} has no product`)
  const product = tx
    .select()
    .from(packageProducts)
    .where(eq(packageProducts.id, order.productId))
    .get()
  if (!product) throw new Error(`product ${order.productId} missing`)
  const pkg = tx
    .insert(packages)
    .values({
      studentId: order.studentId,
      productId: product.id,
      name: product.name,
      lessonTypeId: product.lessonTypeId,
      coachIds: product.coachIds,
      lessonsPurchased: product.lessonCount,
      lessonsRemaining: product.lessonCount,
      pricePaid: order.amount,
      expiresAt: validityEnd(paidAt, product.validityDays),
      status: 'active',
      orderId: order.id,
    })
    .returning({ id: packages.id })
    .get()
  tx.insert(packageLedger)
    .values({ packageId: pkg.id, delta: product.lessonCount, kind: 'purchase', actor })
    .run()
  return pkg.id
}

/** Asks WeChat Pay about a pending order and applies the answer. Returns the order's status. */
export async function syncOrder(deps: Deps, orderId: number) {
  const order = deps.db.select().from(orders).where(eq(orders.id, orderId)).get()
  if (!order) throw notFound('订单')
  if (order.status !== 'pending' || order.provider !== 'wechat' || !order.prepayId)
    return order.status
  const state = await deps.gateway.queryOrder(order.outTradeNo)
  if (state.state === 'paid') applyPayment(deps, order.outTradeNo, state)
  return deps.db.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId)).get()
    ?.status
}

/**
 * Closes an unpaid order at WeChat Pay and locally, releasing its slot. If it turns out to be paid,
 * applies the payment instead and returns 'paid'.
 */
export async function closeOrder(
  deps: Deps,
  orderId: number,
  /** Omitted when the hold simply ran out; given when someone cancels the booking. */
  cancel?: { by: CancelledBy; reason: string | null },
): Promise<'closed' | 'paid'> {
  const order = deps.db.select().from(orders).where(eq(orders.id, orderId)).get()
  if (!order) throw notFound('订单')
  if (order.status === 'paid') return 'paid'
  if (order.status === 'pending' && order.prepayId) {
    const state = await deps.gateway.closeOrder(order.outTradeNo)
    if (state.state === 'paid') {
      applyPayment(deps, order.outTradeNo, state)
      return 'paid'
    }
  }
  const now = deps.now()
  const closed = immediate(deps.db, (tx) => {
    const current = tx
      .select({ status: orders.status })
      .from(orders)
      .where(eq(orders.id, orderId))
      .get()
    if (current?.status === 'paid') return false
    tx.update(orders).set({ status: 'closed' }).where(eq(orders.id, orderId)).run()
    if (order.bookingId) {
      tx.update(bookings)
        .set(
          cancel
            ? {
                status: 'cancelled',
                cancelledAt: now,
                cancelledBy: cancel.by,
                cancelReason: cancel.reason,
              }
            : { status: 'expired' },
        )
        .where(and(eq(bookings.id, order.bookingId), eq(bookings.status, 'pending_payment')))
        .run()
    }
    return true
  })
  return closed ? 'closed' : 'paid'
}

/** Closes orders past their payment time. Run by the sweeper. */
export async function expireOrders(deps: Deps) {
  const cutoff = new Date(deps.now().getTime() - EXPIRY_GRACE_MS)
  const due = deps.db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.status, 'pending'),
        eq(orders.provider, 'wechat'),
        isNotNull(orders.expiresAt),
        lt(orders.expiresAt, cutoff),
      ),
    )
    .all()
  for (const { id } of due) {
    try {
      await closeOrder(deps, id)
    } catch (e) {
      deps.log('expire order failed', { orderId: id, error: (e as Error).message })
    }
  }
}
