import {
  type BookingQuoteDto,
  type BookingTerms,
  bookingTerms,
  bookingWindowError,
  type CancelledBy,
  cancellationOutcome,
  freeCancelDeadline,
  freeSeat,
  isGroup,
  sameTerms,
} from '@rs/shared'
import { and, asc, eq, gt, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm'
import { immediate, type Q } from '../db/client'
import {
  bookings,
  coaches,
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
import { disruptionOf } from './disruption'
import { newOutTradeNo } from './ids'
import { moveSummaries } from './move-history'
import { closeOrder, startPaymentOrRelease } from './orders'
import { createRefund, submitRefund, VENUE_CANCEL_REFUND } from './refunds'
import { type SlotTarget, targetSlot } from './schedule'
import { getSettings, ruleBook } from './settings'
import { assertTableFree } from './tables'

export const LIVE = ['pending_payment', 'confirmed'] as const

export const slotTaken = () => new ApiError(409, 'slot_taken', '该时段已被预约')
/** Taken for a private slot, full for a group session. */
export const seatTaken = (slot: Pick<SlotRow, 'lessonTypeId'>) =>
  slot.lessonTypeId === null ? slotTaken() : new ApiError(409, 'slot_taken', '该课已满员')

type SlotRow = typeof slots.$inferSelect

/** The seats live bookings hold in a slot. */
export function takenSeats(tx: Q, slotId: number) {
  return tx
    .select({ seat: bookings.seat })
    .from(bookings)
    .where(and(eq(bookings.slotId, slotId), inArray(bookings.status, LIVE)))
    .all()
    .map((r) => r.seat)
}

/** A free seat in the slot, or null when it is full. */
export function seatFor(tx: Q, slot: Pick<SlotRow, 'id' | 'capacity'>) {
  return freeSeat(takenSeats(tx, slot.id), slot.capacity)
}

/**
 * The seat a new booking in this slot takes; refuses a slot that is full. The unique index on
 * live seats backs this up on insert, so concurrent requests never share a seat.
 */
export function takeSeat(tx: Q, slot: SlotRow) {
  const seat = seatFor(tx, slot)
  if (seat === null) throw seatTaken(slot)
  return seat
}

/**
 * Refuses a lesson type the slot does not teach: a group session teaches its own lesson type
 * only, and a private slot takes private lessons only.
 */
export function assertTeaches(
  slot: Pick<SlotRow, 'lessonTypeId'>,
  lessonType: { id: number; capacity: number },
) {
  const fits =
    slot.lessonTypeId === null ? !isGroup(lessonType) : slot.lessonTypeId === lessonType.id
  if (!fits) throw new ApiError(409, 'lesson_type_mismatch', '该时段不能预约这门课')
}

/** Refuses a time the student already has another lesson at; `except` is the one being moved. */
export function assertNoClash(
  tx: Q,
  studentId: number,
  slot: { startsAt: Date; endsAt: Date },
  message: string,
  except?: number,
) {
  const clash = tx
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      and(
        eq(bookings.studentId, studentId),
        except === undefined ? undefined : ne(bookings.id, except),
        inArray(bookings.status, LIVE),
        lt(bookings.startsAt, slot.endsAt),
        gt(bookings.endsAt, slot.startsAt),
      ),
    )
    .get()
  if (clash) throw new ApiError(409, 'student_clash', message)
}

// Each unpaid booking holds its slot until the order expires, so one student cannot hold many.
const MAX_UNPAID_HOLDS = 3

export const windowMessages = {
  started: '该时段已开始',
  too_soon: '离上课时间太近，无法预约',
  too_far: '该时段暂未开放预约',
} as const

export interface CreateBookingInput {
  target: SlotTarget
  lessonTypeId: number
  payWith?: 'package' | 'wechat'
  /** The price the student was shown, in fen; a different price now refuses the booking. */
  expectedPrice?: number
  /** The package the student was shown; another one now refuses the booking. */
  expectedPackageId?: number
  /** The cancel and move rules the student was shown; others now refuse the booking. */
  expectedTerms?: BookingTerms
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
  /** The student already held this slot: this is that booking, not a new one. */
  existing: boolean
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

/** Why a coach has no price for a lesson: they stopped teaching it, or the venue turned them off. */
function noPrice(tx: Q, coachId: number): ApiError {
  const coach = tx
    .select({ active: coaches.active })
    .from(coaches)
    .where(eq(coaches.id, coachId))
    .get()
  return new ApiError(
    409,
    'coach_not_teaching',
    coach?.active ? '该教练不教这门课' : '该教练暂不可预约',
  )
}

/** The coach and start of a target, without checking whether it can be booked. */
export function targetTime(tx: Q, target: SlotTarget) {
  if (!('slotId' in target))
    return { coachId: target.coachId, startsAt: target.startsAt, slot: null }
  const slot = tx.select().from(slots).where(eq(slots.id, target.slotId)).get()
  if (!slot) throw new ApiError(404, 'not_found', '该时段已取消')
  return { coachId: slot.coachId, startsAt: slot.startsAt, slot }
}

/** What booking a lesson would cost the student, for the confirm page. */
export function quoteBooking(
  deps: Deps,
  studentId: number,
  target: SlotTarget,
  lessonTypeId: number,
) {
  const { db } = deps
  const student = db.select().from(students).where(eq(students.id, studentId)).get()
  const lessonType = db.select().from(lessonTypes).where(eq(lessonTypes.id, lessonTypeId)).get()
  if (!student || !lessonType || !visibleTo(lessonType, student)) throw notFound('时段')
  const at = targetTime(db, target)
  assertTeaches(at.slot ?? { lessonTypeId: null }, lessonType)
  const price = priceFor(db, at.coachId, lessonType, deps.now())
  if (!price) throw noPrice(db, at.coachId)
  const pkg = lessonType.isTrial ? undefined : usablePackage(db, studentId, lessonType.id, at)
  return {
    price,
    package: pkg ? { id: pkg.id, name: pkg.name, lessonsRemaining: pkg.lessonsRemaining } : null,
    perClassEnabled: lessonType.isTrial || getSettings(db).payment.perClassEnabled,
  } satisfies BookingQuoteDto
}

/**
 * The student's live booking at a target, if they already hold it: in the session, or with that
 * coach at that start for a private lesson.
 */
export function heldAt(tx: Q, studentId: number, target: SlotTarget) {
  const at = targetTime(tx, target)
  return tx
    .select({
      id: bookings.id,
      status: bookings.status,
      lessonTypeId: bookings.lessonTypeId,
      paidWith: bookings.paidWith,
      price: bookings.price,
      packageId: bookings.packageId,
      terms: bookings.terms,
    })
    .from(bookings)
    .innerJoin(slots, eq(slots.id, bookings.slotId))
    .where(
      and(
        eq(bookings.studentId, studentId),
        inArray(bookings.status, LIVE),
        at.slot && at.slot.lessonTypeId !== null
          ? eq(bookings.slotId, at.slot.id)
          : and(
              isNull(slots.lessonTypeId),
              eq(slots.coachId, at.coachId),
              eq(bookings.startsAt, at.startsAt),
            ),
      ),
    )
    .get()
}

/**
 * How a request that does not say how to pay would pay if booked afresh: with a usable package
 * when there is one (not for a trial), else by WeChat Pay. A booking paid with a package counts
 * its own package as usable, since giving it up would hand that lesson back.
 */
function impliedPayWith(
  tx: Q,
  studentId: number,
  own: { paidWith: 'order' | 'package' },
  input: CreateBookingInput,
): 'package' | 'wechat' {
  if (own.paidWith === 'package') return 'package'
  const lessonType = tx
    .select({ id: lessonTypes.id, isTrial: lessonTypes.isTrial })
    .from(lessonTypes)
    .where(eq(lessonTypes.id, input.lessonTypeId))
    .get()
  if (!lessonType || lessonType.isTrial) return 'wechat'
  return usablePackage(tx, studentId, lessonType.id, targetTime(tx, input.target))
    ? 'package'
    : 'wechat'
}

/**
 * Whether a request for a time the student already holds asks for the booking they have, under
 * the cancel and move rules it was booked with (`terms`).
 */
function asksForHeld(
  own: { paidWith: 'order' | 'package'; price: number; packageId: number | null },
  terms: BookingTerms,
  input: CreateBookingInput,
): boolean {
  if (input.payWith === 'package' && own.paidWith !== 'package') return false
  if (input.payWith === 'wechat' && own.paidWith === 'package') return false
  // As for a new booking, the package shown only counts when one is used: one asked for with no
  // package to use books by WeChat Pay, and asking again the same gets that booking back.
  if (
    input.expectedPackageId !== undefined &&
    (own.paidWith === 'package' || input.payWith === 'package') &&
    own.packageId !== input.expectedPackageId
  ) {
    return false
  }
  if (input.expectedTerms && !sameTerms(input.expectedTerms, terms)) return false
  // As for a new booking, the price shown only counts when not paying with a package.
  return (
    input.expectedPrice === undefined ||
    own.paidWith === 'package' ||
    own.price === input.expectedPrice
  )
}

/**
 * The checks a booking passes whoever makes it: the lesson fits the slot, the coach teaches it,
 * the slot has a free seat, the student has nothing else then, and a trial is still allowed.
 * Returns the price and the seat. `who` names the student in messages: the student themself, or
 * the front desk's student.
 */
export function checkBookable(
  tx: Q,
  now: Date,
  b: {
    studentId: number
    slot: typeof slots.$inferSelect
    lessonType: typeof lessonTypes.$inferSelect
  },
  who: '你' | '该学员',
) {
  const { studentId, slot, lessonType } = b
  if (slot.cancelledAt) throw new ApiError(409, 'slot_closed', '该课已取消')
  assertTeaches(slot, lessonType)
  const minutes = (slot.endsAt.getTime() - slot.startsAt.getTime()) / 60_000
  if (minutes !== lessonType.durationMinutes) {
    throw new ApiError(409, 'duration_mismatch', '课程时长与时段不符')
  }
  const price = priceFor(tx, slot.coachId, lessonType, now)
  if (!price) throw noPrice(tx, slot.coachId)
  const seat = takeSeat(tx, slot)
  assertNoClash(tx, studentId, slot, `${who}在这个时间已有预约`)
  assertTableFree(tx, slot)
  if (lessonType.isTrial) {
    const settings = getSettings(tx)
    if (!settings.payment.trialEnabled) throw new ApiError(409, 'trial_off', '暂不提供体验课')
    if (trialsUsed(tx, studentId) >= settings.payment.trialLimitPerStudent) {
      throw new ApiError(409, 'trial_used', `${who === '你' ? '' : who}体验课次数已用完`)
    }
  }
  return { price, seat }
}

/**
 * Books a seat in a slot. Everything that decides whether the booking is allowed runs in one
 * IMMEDIATE transaction, and a partial unique index allows one live booking per seat, so
 * concurrent requests for the last seat get exactly one winner. Paid bookings hold the slot as
 * pending_payment until the payment arrives or the order expires.
 */
export async function createBooking(
  deps: Deps,
  studentId: number,
  input: CreateBookingInput,
): Promise<CreateBookingResult> {
  // The student's own hold of this time whose payment time is up, which the sweeper closes only
  // a couple of minutes later, would come back below as the booking already made, with an order
  // that can no longer be paid. It is closed first, so this books afresh. A payment that landed
  // meanwhile confirms it instead, and it comes back as made.
  await closeLapsedHolds(deps, studentId, input.target, input.lessonTypeId)
  const now = deps.now()
  const created = immediate(deps.db, (tx) => {
    const settings = getSettings(tx)
    const student = tx.select().from(students).where(eq(students.id, studentId)).get()
    // Deleted while this request was on its way.
    if (!student || student.deletedAt) throw new ApiError(401, 'unauthorized', '请重新登录')
    // A repeated tap or a retry after a lost response gets the booking it already made, rather
    // than being told the time is taken (by the student themself).
    const own = heldAt(tx, studentId, input.target)
    if (own && own.lessonTypeId === input.lessonTypeId) {
      // Asked on other terms (a package now, another price or other rules): not a repeat. Handing back the
      // hold would send the student to pay its old order, so they are pointed to it instead.
      const asked = {
        ...input,
        payWith: input.payWith ?? impliedPayWith(tx, studentId, own, input),
      }
      if (!asksForHeld(own, ruleBook(tx, settings).termsOf(own), asked)) {
        throw new ApiError(
          409,
          'already_booked',
          own.status === 'pending_payment' ? '你已预约这节课，待支付' : '你已预约这节课',
          own.id,
        )
      }
      const order = tx
        .select({ id: orders.id })
        .from(orders)
        .where(and(eq(orders.bookingId, own.id), eq(orders.status, 'pending')))
        .get()
      return {
        bookingId: own.id,
        status:
          own.status === 'pending_payment' ? ('pending_payment' as const) : ('confirmed' as const),
        orderId: own.status === 'pending_payment' ? (order?.id ?? null) : null,
        repeat: true,
      }
    }
    const lessonType = tx
      .select()
      .from(lessonTypes)
      .where(eq(lessonTypes.id, input.lessonTypeId))
      .get()
    if (!lessonType || !visibleTo(lessonType, student)) {
      throw new ApiError(404, 'not_found', '该课程暂不可预约')
    }
    const slot = targetSlot(tx, input.target, {
      minutes: lessonType.durationMinutes,
      lessonType,
      rule: 'schedule',
    })
    // A cancelled class is closed too; say it was cancelled.
    if (slot.cancelledAt) throw new ApiError(409, 'slot_closed', '该课已取消')
    if (slot.lessonTypeId !== null && !slot.open) {
      throw new ApiError(409, 'slot_closed', '该时段不可预约')
    }
    const rules = ruleBook(tx, settings).of(lessonType.id)
    const windowError = bookingWindowError(slot.startsAt, now, rules)
    if (windowError) throw new ApiError(409, windowError, windowMessages[windowError])
    const { price, seat } = checkBookable(tx, now, { studentId, slot, lessonType }, '你')

    const pkg =
      lessonType.isTrial || input.payWith === 'wechat'
        ? undefined
        : usablePackage(tx, studentId, lessonType.id, slot)
    if (input.payWith === 'package' && !pkg) {
      throw new ApiError(409, 'no_package', '没有可用于该课程的课时包')
    }
    // The shown one was used up or expired, and the next one would be used without asking.
    if (pkg && input.expectedPackageId !== undefined && pkg.id !== input.expectedPackageId) {
      throw new ApiError(409, 'package_changed', '课时包已变动')
    }
    // Changed by the venue, or a sale ended, since the student saw the price.
    if (!pkg && input.expectedPrice !== undefined && input.expectedPrice !== price.price) {
      throw new ApiError(409, 'price_changed', '价格已变动')
    }
    // Changed by the venue since the page loaded: the student agrees to the terms they will keep.
    if (input.expectedTerms && !sameTerms(input.expectedTerms, rules)) {
      throw new ApiError(409, 'terms_changed', '预约规则已变动')
    }

    const base = {
      slotId: slot.id,
      studentId,
      lessonTypeId: lessonType.id,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      seat,
      terms: bookingTerms(rules),
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
        // A hold whose payment time is up no longer counts: the sweeper closes it shortly.
        const holds = tx
          .select({ n: sql<number>`count(distinct ${bookings.id})` })
          .from(bookings)
          .leftJoin(orders, and(eq(orders.bookingId, bookings.id), eq(orders.status, 'pending')))
          .where(
            and(
              eq(bookings.studentId, studentId),
              eq(bookings.status, 'pending_payment'),
              or(isNull(orders.expiresAt), gt(orders.expiresAt, now)),
            ),
          )
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
      // Another process won the seat between our check and insert.
      if (isUniqueViolation(e)) throw seatTaken(slot)
      throw e
    }
  })

  const { repeat, ...result } = { repeat: false, ...created }
  if (result.orderId === null) return { ...result, payment: null, existing: repeat }
  const payment = await startPaymentOrRelease(deps, result.orderId, studentId, { release: !repeat })
  return { ...result, payment, existing: repeat }
}

/** The pending order of the student's unpaid hold at a target, once its payment time is up. */
function lapsedHoldOrder(deps: Deps, studentId: number, target: SlotTarget) {
  let own: ReturnType<typeof heldAt>
  try {
    own = heldAt(deps.db, studentId, target)
  } catch {
    // A slot that is gone: the booking itself says so.
    return null
  }
  if (own?.status !== 'pending_payment') return null
  const order = deps.db
    .select({ id: orders.id, expiresAt: orders.expiresAt })
    .from(orders)
    .where(and(eq(orders.bookingId, own.id), eq(orders.status, 'pending')))
    .get()
  return order?.expiresAt && order.expiresAt <= deps.now() ? order.id : null
}

/**
 * Before booking for a student, in the app or at the desk: closes their unpaid holds whose
 * payment time is up and which would stand in the way until the sweeper closes them a couple of
 * minutes later. Their own hold of this time, which would otherwise come back as the booking
 * already made (or as taken, at the desk); and, for a trial, their lapsed trial holds.
 */
export async function closeLapsedHolds(
  deps: Deps,
  studentId: number,
  target: SlotTarget,
  lessonTypeId: number,
) {
  const lapsed = lapsedHoldOrder(deps, studentId, target)
  if (lapsed !== null) await closeOrder(deps, lapsed)
  await closeLapsedTrialHolds(deps, studentId, lessonTypeId)
}

/**
 * Before booking a trial: closes the student's unpaid trial holds whose payment time is up, which
 * still count against the trial allowance until the sweeper closes them. Only when, counted, they
 * use up the allowance and closing them makes room: otherwise a late payment of one still fits, and WeChat Pay being down
 * need not hold the booking up. Closed at WeChat Pay first, so no late payment can confirm one
 * beside the new trial; one that was paid meanwhile is confirmed instead and counts. The
 * booking's own transaction still counts every live trial.
 */
async function closeLapsedTrialHolds(deps: Deps, studentId: number, lessonTypeId: number) {
  const orderIds = lapsedTrialOrders(deps, studentId, lessonTypeId)
  if (!orderIds.length) return
  const { trialEnabled, trialLimitPerStudent } = getSettings(deps.db).payment
  const used = trialsUsed(deps.db, studentId)
  // Room already, or none even without them: closing them would change nothing but the error.
  if (!trialEnabled || used < trialLimitPerStudent) return
  if (used - orderIds.length >= trialLimitPerStudent) return
  for (const orderId of orderIds) await closeOrder(deps, orderId)
}

/** The pending orders of the student's unpaid trial holds whose payment time is up, for a trial. */
function lapsedTrialOrders(deps: Deps, studentId: number, lessonTypeId: number): number[] {
  const type = deps.db
    .select({ isTrial: lessonTypes.isTrial })
    .from(lessonTypes)
    .where(eq(lessonTypes.id, lessonTypeId))
    .get()
  if (!type?.isTrial) return []
  return deps.db
    .select({ id: orders.id })
    .from(orders)
    .innerJoin(bookings, eq(bookings.id, orders.bookingId))
    .innerJoin(lessonTypes, eq(lessonTypes.id, bookings.lessonTypeId))
    .where(
      and(
        eq(bookings.studentId, studentId),
        eq(bookings.status, 'pending_payment'),
        eq(lessonTypes.isTrial, true),
        eq(orders.status, 'pending'),
        lte(orders.expiresAt, deps.now()),
      ),
    )
    .all()
    .map((r) => r.id)
}

/** Whether a booking was already cancelled by this same request: same side, same reason. */
function repeatedCancel(
  booking: { status: string; cancelledBy: CancelledBy | null; cancelReason: string | null },
  by: CancelledBy,
  options: CancelOptions,
) {
  return (
    booking.status === 'cancelled' &&
    booking.cancelledBy === by &&
    booking.cancelReason === (options.reason ?? null)
  )
}

/**
 * Cancels a booking. An unpaid booking is closed with its order. A confirmed one follows the
 * venue's cancellation rules: money goes back to WeChat Pay, lessons back to the package.
 * Returns false when this call cancelled nothing, as with a repeat of a cancel that went through.
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
  // A repeat of a cancel that already went through is a no-op. A cancel by someone else still
  // fails, since the venue and the student cancel with different refunds.
  if (repeatedCancel(existing, by, options)) return false
  // Set when the student cancelled what they saw as unpaid but the payment landed meanwhile.
  // They were told cancelling costs nothing, so the late-cancel rule does not apply.
  let paidWhileCancelling = false
  if (existing.status === 'pending_payment') {
    const order = deps.db.select().from(orders).where(eq(orders.bookingId, bookingId)).get()
    const cancel = { by, reason: options.reason ?? null }
    if (order && (await closeOrder(deps, order.id, cancel)) === 'closed') return true
    paidWhileCancelling = true
  }

  const now = deps.now()
  const refundIds = immediate(deps.db, (tx) => {
    const booking = tx.select().from(bookings).where(eq(bookings.id, bookingId)).get()
    if (!booking) throw notFound('预约')
    // The payment that landed could not confirm the booking (the slot was gone), so it is
    // already being refunded in full and there is nothing left to cancel.
    if (paidWhileCancelling && booking.status === 'expired') return null
    // The payment landed on a seat in a session the venue called off, which applyPayment
    // cancelled for the venue and refunded: this cancel's work is done.
    if (paidWhileCancelling && booking.status === 'cancelled' && booking.cancelledBy === 'venue') {
      return []
    }
    // Two cancels by the same side racing: the first one did the work.
    if (repeatedCancel(booking, by, options)) return null
    if (booking.status !== 'confirmed') throw new ApiError(409, 'not_cancellable', '该预约已取消')
    const order =
      booking.paidWith === 'order'
        ? tx.select().from(orders).where(eq(orders.bookingId, booking.id)).get()
        : undefined
    const amountPaid = order?.status === 'paid' ? order.amount : 0
    const terms = booking.terms ?? ruleBook(tx).termsOf(booking)
    const rules = cancellationOutcome({
      startsAt: booking.startsAt,
      endsAt: booking.endsAt,
      now,
      cancelledBy: by,
      paidWith: booking.paidWith,
      amountPaid,
      rules: terms,
      deadline: freeCancelDeadline(
        booking.startsAt,
        terms,
        moveSummaries(tx, [booking.id]).get(booking.id)?.lastMove,
        disruptionOf(tx, booking),
      ),
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
        // A venue cancel mid-lesson drops a mark the coach already made.
        attendance: null,
        attendanceAt: null,
        attendanceBy: null,
        attendanceStaffId: null,
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
          reason: by === 'venue' ? VENUE_CANCEL_REFUND : '取消预约',
          bookingId: booking.id,
        }),
      ]
    }
    return []
  })
  if (refundIds === null) return false
  for (const id of refundIds) await submitRefund(deps, id)
  return true
}
