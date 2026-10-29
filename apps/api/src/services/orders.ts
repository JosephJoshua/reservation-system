import { type CancelledBy, DISRUPTION_TEXT, validityEnd } from '@rs/shared'
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
import { seatFor } from './bookings'
import { priceFor, trialsUsed, visibleTo } from './catalog'
import { assertNotDisrupted, disruptionOf } from './disruption'
import { createRefund, submitRefund } from './refunds'
import { assertPrivateTime, exceptionsFor } from './schedule'
import { getSettings } from './settings'
import { hasFreeTable } from './tables'

// Local expiry waits this long past WeChat's time_expire, so a payment made in the last second
// has time to arrive before the slot is released.
const EXPIRY_GRACE_MS = 2 * 60_000

/** The order was paid already; the mini program shows it as paid rather than as an error. */
export const orderPaid = () => new ApiError(409, 'order_paid', '订单已支付')

/** Places a pending order with WeChat Pay and returns what wx.requestPayment needs. */
export async function startPayment(
  deps: Deps,
  orderId: number,
  openid: string,
): Promise<PaymentParams> {
  let order = deps.db.select().from(orders).where(eq(orders.id, orderId)).get()
  if (!order) throw notFound('订单')
  // Paid before the callback arrived, say just before the app was closed or on another phone:
  // WeChat would refuse to take the money twice, so the student is told it is done instead.
  if (order.status === 'pending' && order.prepayId) {
    try {
      await syncOrder(deps, orderId)
    } catch (e) {
      deps.log('order sync failed', { orderId, error: (e as Error).message })
    }
    order = deps.db.select().from(orders).where(eq(orders.id, orderId)).get() ?? order
  }
  if (order.status === 'paid') throw orderPaid()
  if (order.status === 'pending' && order.expiresAt && order.expiresAt <= deps.now()) {
    // Past its time but not yet closed by the sweeper: closed now, so its slot is free for the
    // booking made again.
    // WeChat Pay unreachable: whether it was paid is not known yet, so the student is not told
    // it is closed.
    const closed = await closeOrder(deps, orderId)
    if (closed === 'paid') throw orderPaid()
    throw orderNotPayable()
  }
  if (order.status !== 'pending' || !order.expiresAt) throw orderNotPayable()
  // A 闭馆 or 请假 added, or the coach stopped, while the student was paying.
  const held = order.bookingId
    ? deps.db.select().from(bookings).where(eq(bookings.id, order.bookingId)).get()
    : undefined
  if (held?.status === 'pending_payment') {
    // Its cancel could not close the order at WeChat Pay; the sweeper cancels the seat.
    if (calledOffSession(deps.db, held.slotId)) {
      throw new ApiError(409, 'lesson_unavailable', '该课已取消，请预约其他课程')
    }
    assertNotDisrupted(deps.db, held)
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
    // Closed meanwhile (cancelled, or the hold ran out) while WeChat Pay was placing it: a cancel
    // that saw no prepay id closed it here only, so close it at WeChat Pay too and give no cashier.
    const saved = deps.db
      .update(orders)
      .set({ prepayId })
      .where(and(eq(orders.id, orderId), eq(orders.status, 'pending')))
      .run()
    if (saved.changes === 0) {
      await closeAtWechat(deps, order.outTradeNo)
      if (closeStatus(deps, orderId) === 'paid') throw orderPaid()
      throw orderNotPayable()
    }
  }
  return deps.gateway.paymentParams(prepayId)
}

const orderNotPayable = () => new ApiError(409, 'order_not_payable', '订单已关闭，请重新下单')

const paymentUnavailable = () =>
  new ApiError(502, 'payment_unavailable', '微信支付暂时不可用，请稍后再试')

/**
 * Closes an order at WeChat Pay that is closed here already, so it can never be paid. If it was
 * paid meanwhile, the payment is applied: a late payment then revives or refunds the booking.
 */
async function closeAtWechat(deps: Deps, outTradeNo: string) {
  try {
    const state = await deps.gateway.closeOrder(outTradeNo)
    if (state.state === 'paid') applyPayment(deps, outTradeNo, state)
  } catch (e) {
    // WeChat Pay closes it at time_expire anyway, and a payment still arrives by callback.
    deps.log('close order at wechat failed', { outTradeNo, error: (e as Error).message })
  }
}

function closeStatus(deps: Deps, orderId: number): 'closed' | 'paid' {
  const row = deps.db
    .select({ status: orders.status })
    .from(orders)
    .where(eq(orders.id, orderId))
    .get()
  return row?.status === 'paid' ? 'paid' : 'closed'
}

/**
 * Starts payment for an order just created for the student. If that fails, the order is closed at
 * once so a booking's slot is not held for the whole timeout. A repeated request that reuses an
 * order passes `release: false`: the first request may still be paying it, or have paid it, in
 * which case there is nothing to pay and this returns null.
 */
export async function startPaymentOrRelease(
  deps: Deps,
  orderId: number,
  studentId: number,
  { release = true } = {},
): Promise<PaymentParams | null> {
  const student = deps.db
    .select({ openid: students.openid })
    .from(students)
    .where(eq(students.id, studentId))
    .get()
  try {
    return await startPayment(deps, orderId, student?.openid ?? '')
  } catch (e) {
    if (!release && e instanceof ApiError && e.code === 'order_paid') return null
    if (!release) throw e
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
    // Flagged for staff already: nothing more to apply.
    if (order.status === 'paid' || order.anomaly) return []
    // WeChat Pay charges the amount the order was created with, so a difference means something is
    // badly wrong; and an order refunded at WeChat Pay before it was paid here was settled outside
    // this system. Confirm nothing: release what the order held and flag it for staff.
    const anomaly = paid.refunded
      ? ('refunded' as const)
      : paid.amount !== order.amount
        ? ('amount_mismatch' as const)
        : null
    if (anomaly) {
      deps.log('payment not applied, flagged for staff', {
        outTradeNo,
        anomaly,
        paid: paid.amount,
        order: order.amount,
      })
      tx.update(orders)
        .set({
          status: 'closed',
          anomaly,
          anomalyAmount: paid.amount,
          transactionId: paid.transactionId || null,
        })
        .where(eq(orders.id, order.id))
        .run()
      if (order.bookingId) {
        tx.update(bookings)
          .set({ status: 'expired' })
          .where(and(eq(bookings.id, order.bookingId), eq(bookings.status, 'pending_payment')))
          .run()
      }
      return []
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
    let reason = '时段已被预约，自动退款'
    // The venue cannot give the lesson any more (the session was called off, 闭馆, 请假, the coach
    // stopped): a hold ends, one already over is not revived, and the payment goes back, saying
    // why. A called-off session's seat still held is one whose cancel could not close the order.
    const unpaid = booking.status === 'pending_payment' || booking.status === 'expired'
    const calledOff = unpaid && calledOffSession(tx, booking.slotId)
    const disruption = unpaid && !calledOff ? disruptionOf(tx, booking) : null
    if (calledOff || disruption) {
      if (booking.status === 'pending_payment') {
        tx.update(bookings).set({ status: 'expired' }).where(eq(bookings.id, booking.id)).run()
      }
      reason = disruption ? `${DISRUPTION_TEXT[disruption]}，自动退款` : '该课已取消，自动退款'
    } else if (
      booking.status === 'pending_payment' ||
      (booking.status === 'expired' && revivable(tx, booking, deps.now()))
    ) {
      // A held booking keeps its seat. One whose hold ran out takes any seat still free in the
      // slot, so a late payment for a group session is kept while the session has room.
      const seat =
        booking.status === 'pending_payment' ? booking.seat : revivedSeat(tx, booking.slotId)
      try {
        if (seat === null) throw new SeatGone()
        tx.update(bookings)
          .set({ status: 'confirmed', seat })
          .where(eq(bookings.id, booking.id))
          .run()
        return []
      } catch (e) {
        if (!(e instanceof SeatGone) && !isUniqueViolation(e)) throw e
        tx.update(bookings).set({ status: 'expired' }).where(eq(bookings.id, booking.id)).run()
      }
    }
    if (booking.status === 'confirmed') return []
    deps.log('payment for a released slot, refunding', { outTradeNo, bookingId: booking.id })
    return [
      createRefund(tx, deps.now(), {
        orderId: order.id,
        amount: order.amount,
        reason,
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

class SeatGone extends Error {}

/** Whether the slot is a session the venue called off. */
function calledOffSession(tx: Q, slotId: number) {
  const slot = tx
    .select({ cancelledAt: slots.cancelledAt })
    .from(slots)
    .where(eq(slots.id, slotId))
    .get()
  return !!slot?.cancelledAt
}

/** A free seat for a booking revived by a late payment, or null when the slot is full. */
function revivedSeat(tx: Q, slotId: number) {
  const slot = tx
    .select({ id: slots.id, capacity: slots.capacity })
    .from(slots)
    .where(eq(slots.id, slotId))
    .get()
  return slot ? seatFor(tx, slot) : null
}

/**
 * Whether a booking whose hold ran out can still be confirmed by a late payment: the lesson is
 * ahead, and it passes what a new booking would. The lesson type is still offered to the student,
 * the coach still teaches it, the slot still takes bookings (for a private lesson, a time 排班
 * still offers, buffer included, with the coach free and not on leave), a trial is still within
 * the student's limit, the student has not booked that time since, and a table is still free.
 * Whether a seat is left is checked when it is revived, and the unique index backs that up. The
 * booking window is not checked again: the student booked within it.
 */
function revivable(tx: Q, booking: typeof bookings.$inferSelect, now: Date) {
  if (booking.startsAt <= now) return false
  const slot = tx.select().from(slots).where(eq(slots.id, booking.slotId)).get()
  if (!slot || slot.cancelledAt || !hasFreeTable(tx, slot)) return false
  if (slot.lessonTypeId !== null && !slot.open) return false
  const lessonType = tx
    .select()
    .from(lessonTypes)
    .where(eq(lessonTypes.id, booking.lessonTypeId))
    .get()
  const student = tx
    .select({ tester: students.tester, deletedAt: students.deletedAt })
    .from(students)
    .where(eq(students.id, booking.studentId))
    .get()
  if (!lessonType || !student || student.deletedAt || !visibleTo(lessonType, student)) return false
  // Turned off by the venue, or no longer teaching this lesson type.
  if (!priceFor(tx, slot.coachId, lessonType, now)) return false
  const span = { startsAt: booking.startsAt, endsAt: booking.endsAt }
  const off = exceptionsFor(tx, [slot.coachId], span).get(slot.coachId) ?? []
  if (off.some((e) => e.kind === 'off')) return false
  if (slot.lessonTypeId === null) {
    // The coach may have taken another lesson next to it, or changed 排班, since.
    try {
      assertPrivateTime(tx, { coachId: slot.coachId, span, rule: 'schedule', except: booking.id })
    } catch (e) {
      if (e instanceof ApiError) return false
      throw e
    }
  }
  if (lessonType.isTrial) {
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
  // What the student bought, not the product as it is now. Orders from before terms were kept
  // fall back to the product, which could not change while they were being paid.
  const terms =
    order.packageTerms ??
    tx.select().from(packageProducts).where(eq(packageProducts.id, order.productId)).get()
  if (!terms) throw new Error(`product ${order.productId} missing`)
  const pkg = tx
    .insert(packages)
    .values({
      studentId: order.studentId,
      productId: order.productId,
      name: terms.name,
      lessonTypeId: terms.lessonTypeId,
      coachIds: terms.coachIds,
      lessonsPurchased: terms.lessonCount,
      lessonsRemaining: terms.lessonCount,
      pricePaid: order.amount,
      expiresAt: validityEnd(paidAt, terms.validityDays),
      status: 'active',
      orderId: order.id,
    })
    .returning({ id: packages.id })
    .get()
  tx.insert(packageLedger)
    .values({ packageId: pkg.id, delta: terms.lessonCount, kind: 'purchase', actor })
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

// When each order was last asked about by syncPendingOrders, per database, so a page shown again
// and again does not ask WeChat Pay every time.
const lastSyncedBy = new WeakMap<Deps['db'], Map<number, number>>()
const RESYNC_MS = 10_000
// A page waits this long for WeChat Pay at most; a slower answer still lands in the background.
const VIEW_SYNC_WAIT_MS = 3_000

/**
 * Asks WeChat Pay about the student's orders still waiting for payment, so a payment whose
 * callback is late or lost shows up when the student next looks rather than at expiry. Only a
 * booking's own order with `bookingId`, only package orders with 'package'. Failures are logged;
 * the callback and the sweeper still settle the order.
 */
export async function syncPendingOrders(
  deps: Deps,
  studentId: number,
  which: 'package' | 'booking' | { bookingId: number },
) {
  const now = deps.now().getTime()
  let lastSynced = lastSyncedBy.get(deps.db)
  if (!lastSynced) {
    lastSynced = new Map()
    lastSyncedBy.set(deps.db, lastSynced)
  }
  for (const [id, at] of lastSynced) if (Math.abs(now - at) >= RESYNC_MS) lastSynced.delete(id)
  const due = deps.db
    .select({ id: orders.id, kind: orders.kind, bookingId: orders.bookingId })
    .from(orders)
    .where(
      and(
        eq(orders.studentId, studentId),
        eq(orders.status, 'pending'),
        eq(orders.provider, 'wechat'),
        isNotNull(orders.prepayId),
      ),
    )
    .all()
    .filter((o) =>
      which === 'package'
        ? o.kind === 'package'
        : which === 'booking'
          ? o.kind !== 'package'
          : o.bookingId === which.bookingId,
    )
    .filter((o) => !lastSynced.has(o.id))
  if (!due.length) return
  for (const { id } of due) lastSynced.set(id, now)
  const synced = Promise.all(
    due.map(({ id }) =>
      syncOrder(deps, id).catch((e) =>
        deps.log('order sync failed', { orderId: id, error: (e as Error).message }),
      ),
    ),
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    synced,
    new Promise((resolve) => {
      timer = setTimeout(resolve, VIEW_SYNC_WAIT_MS)
    }),
  ])
  clearTimeout(timer)
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
    let state: Awaited<ReturnType<typeof deps.gateway.closeOrder>>
    try {
      state = await deps.gateway.closeOrder(order.outTradeNo)
    } catch (e) {
      // Not closed here either: a payment may still land, so the slot stays held until WeChat
      // Pay answers.
      deps.log('close order failed', { orderId, error: (e as Error).message })
      throw paymentUnavailable()
    }
    if (state.state === 'paid') {
      applyPayment(deps, order.outTradeNo, state)
      // A payment flagged for staff instead (see applyPayment) left the order closed and its
      // booking released: report it closed, not paid.
      if (closeStatus(deps, orderId) === 'paid') return 'paid'
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
  if (!closed) return 'paid'
  // A payment being started placed the order at WeChat Pay after it was read above: close it
  // there too, so the cashier it handed out cannot take money.
  if (order.status === 'pending' && !order.prepayId) {
    const placed = deps.db
      .select({ prepayId: orders.prepayId })
      .from(orders)
      .where(eq(orders.id, orderId))
      .get()
    if (placed?.prepayId) await closeAtWechat(deps, order.outTradeNo)
  }
  return closeStatus(deps, orderId)
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
