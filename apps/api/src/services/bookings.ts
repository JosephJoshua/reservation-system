import {
  type BookingQuoteDto,
  bookingWindowError,
  type CancelledBy,
  cancellationOutcome,
} from '@rs/shared'
import { and, asc, eq, gt, inArray, lt, sql } from 'drizzle-orm'
import { immediate, type Q } from '../db/client'
import {
  bookings,
  lessonTypes,
  orders,
  packageLedger,
  packages,
  slots,
  students,
} from '../db/schema'
import type { Deps } from '../deps'
import { ApiError, isUniqueViolation, notFound } from '../errors'
import type { PaymentParams } from '../pay/gateway'
import { priceFor, trialsUsed, visibleTo } from './catalog'
import { newOutTradeNo } from './ids'
import { closeOrder, startPaymentOrRelease } from './orders'
import { createRefund, submitRefund } from './refunds'
import { getSettings } from './settings'

export const LIVE = ['pending_payment', 'confirmed'] as const

// Each unpaid booking holds its slot until the order expires, so one student cannot hold many.
const MAX_UNPAID_HOLDS = 3

const windowMessages = {
  started: '该时段已开始',
  too_soon: '离上课时间太近，无法预约',
  too_far: '该时段暂未开放预约',
} as const

export interface CreateBookingInput {
  slotId: number
  lessonTypeId: number
  payWith?: 'package' | 'wechat'
}

export interface CancelOptions {
  studentId?: number
  reason?: string
  /** The student saw that cancelling now is late. Without it a late cancel is refused. */
  acceptLate?: boolean
}

export interface CreateBookingResult {
  bookingId: number
  status: 'pending_payment' | 'confirmed'
  orderId: number | null
  payment: PaymentParams | null
}

/** The student's package that would pay for a lesson in this slot: the one expiring first. */
export function usablePackage(
  tx: Q,
  studentId: number,
  lessonTypeId: number,
  slot: { coachId: number; startsAt: Date },
) {
  return tx
    .select()
    .from(packages)
    .where(
      and(
        eq(packages.studentId, studentId),
        eq(packages.lessonTypeId, lessonTypeId),
        eq(packages.status, 'active'),
        gt(packages.lessonsRemaining, 0),
        gt(packages.expiresAt, slot.startsAt),
      ),
    )
    .orderBy(asc(packages.expiresAt), asc(packages.id))
    .all()
    .find((p) => p.coachIds.length === 0 || p.coachIds.includes(slot.coachId))
}

/** What booking a slot would cost the student, for the confirm page. */
export function quoteBooking(deps: Deps, studentId: number, slotId: number, lessonTypeId: number) {
  const { db } = deps
  const student = db.select().from(students).where(eq(students.id, studentId)).get()
  const slot = db.select().from(slots).where(eq(slots.id, slotId)).get()
  const lessonType = db.select().from(lessonTypes).where(eq(lessonTypes.id, lessonTypeId)).get()
  if (!student || !slot || !lessonType || !visibleTo(lessonType, student)) throw notFound('时段')
  const price = priceFor(db, slot.coachId, lessonType, deps.now())
  if (!price) throw new ApiError(409, 'coach_not_teaching', '该教练不教这门课')
  const pkg = lessonType.isTrial ? undefined : usablePackage(db, studentId, lessonType.id, slot)
  return {
    price,
    package: pkg ? { id: pkg.id, name: pkg.name, lessonsRemaining: pkg.lessonsRemaining } : null,
    perClassEnabled: lessonType.isTrial || getSettings(db).payment.perClassEnabled,
  } satisfies BookingQuoteDto
}

/**
 * Books a slot. Everything that decides whether the booking is allowed runs in one IMMEDIATE
 * transaction, and a partial unique index allows one live booking per slot, so concurrent
 * requests for the same slot get exactly one winner. Paid bookings hold the slot as
 * pending_payment until the payment arrives or the order expires.
 */
export async function createBooking(
  deps: Deps,
  studentId: number,
  input: CreateBookingInput,
): Promise<CreateBookingResult> {
  const now = deps.now()
  const created = immediate(deps.db, (tx) => {
    const settings = getSettings(tx)
    const student = tx.select().from(students).where(eq(students.id, studentId)).get()
    if (!student) throw notFound('用户')
    const slot = tx.select().from(slots).where(eq(slots.id, input.slotId)).get()
    if (!slot) throw notFound('时段')
    if (!slot.open) throw new ApiError(409, 'slot_closed', '该时段不可预约')
    const lessonType = tx
      .select()
      .from(lessonTypes)
      .where(eq(lessonTypes.id, input.lessonTypeId))
      .get()
    if (!lessonType || !visibleTo(lessonType, student)) throw notFound('课程')
    const minutes = (slot.endsAt.getTime() - slot.startsAt.getTime()) / 60_000
    if (minutes !== lessonType.durationMinutes) {
      throw new ApiError(409, 'duration_mismatch', '课程时长与时段不符')
    }
    const price = priceFor(tx, slot.coachId, lessonType, now)
    if (!price) throw new ApiError(409, 'coach_not_teaching', '该教练不教这门课')
    const windowError = bookingWindowError(slot.startsAt, now, settings.booking)
    if (windowError) throw new ApiError(409, windowError, windowMessages[windowError])

    const taken = tx
      .select({ id: bookings.id })
      .from(bookings)
      .where(and(eq(bookings.slotId, slot.id), inArray(bookings.status, LIVE)))
      .get()
    if (taken) throw new ApiError(409, 'slot_taken', '该时段已被预约')

    const clash = tx
      .select({ id: bookings.id })
      .from(bookings)
      .where(
        and(
          eq(bookings.studentId, studentId),
          inArray(bookings.status, LIVE),
          lt(bookings.startsAt, slot.endsAt),
          gt(bookings.endsAt, slot.startsAt),
        ),
      )
      .get()
    if (clash) throw new ApiError(409, 'student_clash', '你在这个时间已有预约')

    if (lessonType.isTrial) {
      if (!settings.payment.trialEnabled) throw new ApiError(409, 'trial_off', '暂不提供体验课')
      if (trialsUsed(tx, studentId) >= settings.payment.trialLimitPerStudent) {
        throw new ApiError(409, 'trial_used', '体验课次数已用完')
      }
    }

    const pkg =
      lessonType.isTrial || input.payWith === 'wechat'
        ? undefined
        : usablePackage(tx, studentId, lessonType.id, slot)
    if (input.payWith === 'package' && !pkg) {
      throw new ApiError(409, 'no_package', '没有可用于该课程的课时包')
    }

    const base = {
      slotId: slot.id,
      studentId,
      lessonTypeId: lessonType.id,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
    }
    try {
      if (pkg) {
        const used = tx
          .update(packages)
          .set({ lessonsRemaining: sql`${packages.lessonsRemaining} - 1` })
          .where(and(eq(packages.id, pkg.id), gt(packages.lessonsRemaining, 0)))
          .run()
        if (used.changes !== 1) throw new ApiError(409, 'no_package', '课时包余额不足')
        const booking = tx
          .insert(bookings)
          .values({
            ...base,
            status: 'confirmed',
            paidWith: 'package',
            price: 0,
            packageId: pkg.id,
          })
          .returning({ id: bookings.id })
          .get()
        tx.insert(packageLedger)
          .values({
            packageId: pkg.id,
            delta: -1,
            kind: 'use',
            bookingId: booking.id,
            actor: 'student',
          })
          .run()
        return { bookingId: booking.id, status: 'confirmed' as const, orderId: null }
      }

      if (!lessonType.isTrial && !settings.payment.perClassEnabled) {
        throw new ApiError(409, 'package_required', '请先购买课时包')
      }
      if (price.price > 0) {
        const holds = tx
          .select({ n: sql<number>`count(*)` })
          .from(bookings)
          .where(and(eq(bookings.studentId, studentId), eq(bookings.status, 'pending_payment')))
          .get()
        if ((holds?.n ?? 0) >= MAX_UNPAID_HOLDS) {
          throw new ApiError(409, 'too_many_unpaid', '你有未支付的预约，请先支付或取消')
        }
      }
      if (price.price === 0) {
        const booking = tx
          .insert(bookings)
          .values({ ...base, status: 'confirmed', paidWith: 'order', price: 0 })
          .returning({ id: bookings.id })
          .get()
        return { bookingId: booking.id, status: 'confirmed' as const, orderId: null }
      }
      const booking = tx
        .insert(bookings)
        .values({ ...base, status: 'pending_payment', paidWith: 'order', price: price.price })
        .returning({ id: bookings.id })
        .get()
      const order = tx
        .insert(orders)
        .values({
          outTradeNo: newOutTradeNo(now),
          studentId,
          kind: lessonType.isTrial ? 'trial' : 'class',
          description: lessonType.name,
          amount: price.price,
          provider: 'wechat',
          status: 'pending',
          bookingId: booking.id,
          // Never payable after the lesson starts.
          expiresAt: new Date(
            Math.min(
              now.getTime() + settings.payment.timeoutMinutes * 60_000,
              slot.startsAt.getTime(),
            ),
          ),
        })
        .returning({ id: orders.id })
        .get()
      return { bookingId: booking.id, status: 'pending_payment' as const, orderId: order.id }
    } catch (e) {
      // Another process won the slot between our check and insert.
      if (isUniqueViolation(e)) throw new ApiError(409, 'slot_taken', '该时段已被预约')
      throw e
    }
  })

  if (created.orderId === null) return { ...created, payment: null }
  return { ...created, payment: await startPaymentOrRelease(deps, created.orderId, studentId) }
}

/**
 * Cancels a booking. An unpaid booking is closed with its order. A confirmed one follows the
 * venue's cancellation rules: money goes back to WeChat Pay, lessons back to the package.
 */
export async function cancelBooking(
  deps: Deps,
  bookingId: number,
  by: CancelledBy,
  options: CancelOptions = {},
) {
  const existing = deps.db.select().from(bookings).where(eq(bookings.id, bookingId)).get()
  if (!existing || (options.studentId !== undefined && existing.studentId !== options.studentId)) {
    throw notFound('预约')
  }
  // Set when the student cancelled what they saw as unpaid but the payment landed meanwhile.
  // They were told cancelling costs nothing, so the late-cancel rule does not apply.
  let paidWhileCancelling = false
  if (existing.status === 'pending_payment') {
    const order = deps.db.select().from(orders).where(eq(orders.bookingId, bookingId)).get()
    const cancel = { by, reason: options.reason ?? null }
    if (order && (await closeOrder(deps, order.id, cancel)) === 'closed') return
    paidWhileCancelling = true
  }

  const now = deps.now()
  const refundIds = immediate(deps.db, (tx) => {
    const booking = tx.select().from(bookings).where(eq(bookings.id, bookingId)).get()
    if (!booking) throw notFound('预约')
    // The payment that landed could not confirm the booking (the slot was gone), so it is
    // already being refunded in full and there is nothing left to cancel.
    if (paidWhileCancelling && booking.status === 'expired') return []
    if (booking.status !== 'confirmed') throw new ApiError(409, 'not_cancellable', '该预约已取消')
    const order =
      booking.paidWith === 'order'
        ? tx.select().from(orders).where(eq(orders.bookingId, booking.id)).get()
        : undefined
    const amountPaid = order?.status === 'paid' ? order.amount : 0
    const rules = cancellationOutcome({
      startsAt: booking.startsAt,
      endsAt: booking.endsAt,
      now,
      cancelledBy: by,
      paidWith: booking.paidWith,
      amountPaid,
      rules: getSettings(tx).booking,
    })
    // A payment that landed during the cancel is refunded in full, since the student was told
    // cancelling costs nothing, but only while the lesson can still be cancelled at all.
    const outcome =
      paidWhileCancelling && typeof rules !== 'string'
        ? { late: false, refund: amountPaid, returnLesson: false }
        : rules
    if (outcome === 'started') throw new ApiError(409, 'started', '课程已开始，无法取消')
    if (outcome === 'ended') throw new ApiError(409, 'ended', '课程已结束，无法取消')
    // The student agreed to a free cancel, but the deadline passed (or their clock is off).
    if (outcome.late && !options.acceptLate) {
      throw new ApiError(409, 'late_now', '已过免费取消时间，请重新确认')
    }

    tx.update(bookings)
      .set({
        status: 'cancelled',
        cancelledAt: now,
        cancelledBy: by,
        cancelReason: options.reason ?? null,
        late: outcome.late,
      })
      .where(and(eq(bookings.id, booking.id), eq(bookings.status, 'confirmed')))
      .run()

    const returned =
      outcome.returnLesson &&
      booking.packageId !== null &&
      tx
        .update(packages)
        .set({ lessonsRemaining: sql`${packages.lessonsRemaining} + 1` })
        .where(
          and(
            eq(packages.id, booking.packageId),
            inArray(packages.status, ['active', 'refund_requested']),
          ),
        )
        .run().changes === 1
    if (returned && booking.packageId) {
      tx.insert(packageLedger)
        .values({
          packageId: booking.packageId,
          delta: 1,
          kind: 'return',
          bookingId: booking.id,
          actor: by === 'venue' ? 'admin' : 'student',
        })
        .run()
    }
    if (order && outcome.refund > 0) {
      return [
        createRefund(tx, now, {
          orderId: order.id,
          amount: outcome.refund,
          reason: by === 'venue' ? '场馆取消课程' : '取消预约',
          bookingId: booking.id,
        }),
      ]
    }
    return []
  })
  for (const id of refundIds) await submitRefund(deps, id)
}
