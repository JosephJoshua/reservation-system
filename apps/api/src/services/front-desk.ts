import type { OfflineMethod } from '@rs/shared'
import { and, eq, gt, inArray, lt, sql } from 'drizzle-orm'
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
import { describeBooking, logAction, yuan } from './action-log'
import { LIVE, usablePackage } from './bookings'
import { priceFor, trialsUsed } from './catalog'
import { newOutTradeNo } from './ids'
import { getSettings } from './settings'

export interface FrontDeskBookingInput {
  studentId: number
  slotId: number
  lessonTypeId: number
  /** `offline`: paid at the front desk, recorded as a paid offline order. */
  payWith: 'package' | 'offline'
  amount?: number
  method?: OfflineMethod
  note?: string
}

/**
 * What the front desk checks before booking a lesson for a student. Unlike a student booking,
 * the advance window and notice period do not apply: the desk can book any slot that has not
 * started, and admin-only lesson types too.
 */
function check(
  tx: Q,
  now: Date,
  input: { studentId: number; slotId: number; lessonTypeId: number },
) {
  const student = tx.select().from(students).where(eq(students.id, input.studentId)).get()
  if (!student) throw notFound('学员')
  const slot = tx.select().from(slots).where(eq(slots.id, input.slotId)).get()
  if (!slot) throw notFound('时段')
  if (slot.startsAt <= now) throw new ApiError(409, 'started', '该时段已开始')
  if (!slot.open) throw new ApiError(409, 'slot_closed', '该时段已关闭，请先重新开放')
  const lessonType = tx
    .select()
    .from(lessonTypes)
    .where(eq(lessonTypes.id, input.lessonTypeId))
    .get()
  if (!lessonType?.active) throw notFound('课程')
  if ((slot.endsAt.getTime() - slot.startsAt.getTime()) / 60_000 !== lessonType.durationMinutes) {
    throw new ApiError(409, 'duration_mismatch', '课程时长与时段不符')
  }
  const price = priceFor(tx, slot.coachId, lessonType, now)
  if (!price) throw new ApiError(409, 'coach_not_teaching', '该教练不教这门课')
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
        eq(bookings.studentId, student.id),
        inArray(bookings.status, LIVE),
        lt(bookings.startsAt, slot.endsAt),
        gt(bookings.endsAt, slot.startsAt),
      ),
    )
    .get()
  if (clash) throw new ApiError(409, 'student_clash', '该学员在这个时间已有预约')
  const settings = getSettings(tx)
  if (lessonType.isTrial) {
    if (!settings.payment.trialEnabled) throw new ApiError(409, 'trial_off', '体验课已关闭')
    if (trialsUsed(tx, student.id) >= settings.payment.trialLimitPerStudent) {
      throw new ApiError(409, 'trial_used', '该学员体验课次数已用完')
    }
  }
  const pkg = lessonType.isTrial ? undefined : usablePackage(tx, student.id, lessonType.id, slot)
  return { student, slot, lessonType, price, pkg }
}

/** What the booking would cost, for the front desk's confirm step. */
export function frontDeskQuote(
  deps: Deps,
  input: { studentId: number; slotId: number; lessonTypeId: number },
) {
  const { price, pkg } = check(deps.db, deps.now(), input)
  return {
    price,
    package: pkg
      ? {
          id: pkg.id,
          name: pkg.name,
          lessonsRemaining: pkg.lessonsRemaining,
          expiresAt: pkg.expiresAt,
        }
      : null,
  }
}

/**
 * Books a lesson for a student at the front desk, in one IMMEDIATE transaction with its log
 * entry. The booking is confirmed at once: paid from the student's package, or by an offline
 * payment the desk has taken. The same unique index as student bookings stops a double booking.
 */
export function bookForStudent(deps: Deps, staffId: number, input: FrontDeskBookingInput) {
  const now = deps.now()
  return immediate(deps.db, (tx) => {
    const { slot, lessonType, price, pkg } = check(tx, now, input)
    const base = {
      slotId: slot.id,
      studentId: input.studentId,
      lessonTypeId: lessonType.id,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      status: 'confirmed' as const,
      bookedByStaffId: staffId,
    }
    try {
      if (input.payWith === 'package') {
        if (!pkg) throw new ApiError(409, 'no_package', '该学员没有可用于这节课的课时包')
        const used = tx
          .update(packages)
          .set({ lessonsRemaining: sql`${packages.lessonsRemaining} - 1` })
          .where(and(eq(packages.id, pkg.id), gt(packages.lessonsRemaining, 0)))
          .run()
        if (used.changes !== 1) throw new ApiError(409, 'no_package', '课时包余额不足')
        const booking = tx
          .insert(bookings)
          .values({ ...base, paidWith: 'package', price: 0, packageId: pkg.id })
          .returning({ id: bookings.id })
          .get()
        tx.insert(packageLedger)
          .values({
            packageId: pkg.id,
            delta: -1,
            kind: 'use',
            bookingId: booking.id,
            note: '前台代约',
            actor: 'admin',
          })
          .run()
        const { what } = describeBooking(tx, booking.id)
        logAction(tx, now, staffId, {
          action: 'booking.create',
          summary: `${what}，扣课时包「${pkg.name}」1 节`,
          studentId: input.studentId,
          target: { kind: 'booking', id: booking.id },
        })
        return { bookingId: booking.id }
      }

      const amount = input.amount ?? price.price
      if (amount > 0 && !input.method) throw new ApiError(400, 'invalid_body', '请选择收款方式')
      const booking = tx
        .insert(bookings)
        .values({ ...base, paidWith: 'order', price: amount })
        .returning({ id: bookings.id })
        .get()
      // A free lesson has no order, like a free student booking.
      if (amount > 0) {
        tx.insert(orders)
          .values({
            outTradeNo: newOutTradeNo(now),
            studentId: input.studentId,
            kind: lessonType.isTrial ? 'trial' : 'class',
            description: lessonType.name,
            amount,
            provider: 'offline',
            offlineMethod: input.method,
            status: 'paid',
            bookingId: booking.id,
            paidAt: now,
            note: input.note ?? '',
          })
          .run()
      }
      const { what } = describeBooking(tx, booking.id)
      logAction(tx, now, staffId, {
        action: 'booking.create',
        summary:
          amount > 0
            ? `${what}，线下收款 ${yuan(amount)}${amount !== price.price ? `（标价 ${yuan(price.price)}）` : ''}`
            : `${what}，免费`,
        amount: amount > 0 ? amount : null,
        studentId: input.studentId,
        target: { kind: 'booking', id: booking.id },
      })
      return { bookingId: booking.id }
    } catch (e) {
      if (isUniqueViolation(e)) throw new ApiError(409, 'slot_taken', '该时段已被预约')
      throw e
    }
  })
}
