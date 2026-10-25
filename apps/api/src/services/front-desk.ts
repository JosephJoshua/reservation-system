import { bookingTerms, type OfflineMethod } from '@rs/shared'
import { and, eq, gt, inArray, sql } from 'drizzle-orm'
import { dryRun, immediate, type Q } from '../db/client'
import {
  bookings,
  coaches,
  lessonTypes,
  orders,
  packageLedger,
  packages,
  students,
} from '../db/schema'
import type { Deps } from '../deps'
import { ApiError, isUniqueViolation, notFound } from '../errors'
import { accountDeleted } from './account'
import { describeBooking, logAction, yuan } from './action-log'
import { checkBookable, seatTaken, usablePackage } from './bookings'
import { newOutTradeNo } from './ids'
import { listedPriceOnly } from './packages'
import { type SlotTarget, targetSlot } from './schedule'
import { ruleBook } from './settings'

export interface FrontDeskBookingInput {
  studentId: number
  target: SlotTarget
  lessonTypeId: number
  /** Book a private lesson outside the coach's 排班; the desk confirmed it with the coach. */
  anyTime?: boolean
  /** `offline`: paid at the front desk, recorded as a paid offline order. */
  payWith: 'package' | 'offline'
  amount?: number
  method?: OfflineMethod
  note?: string
  /** Set for staff who may not change prices: an offline payment must be the listed price. */
  listedPriceOnly?: boolean
}

/**
 * What the front desk checks before booking a lesson for a student. Unlike a student booking,
 * the advance window and notice period do not apply: the desk can book any slot that has not
 * started, and admin-only lesson types too.
 */
function check(
  tx: Q,
  now: Date,
  input: { studentId: number; target: SlotTarget; lessonTypeId: number; anyTime?: boolean },
) {
  const student = tx.select().from(students).where(eq(students.id, input.studentId)).get()
  if (!student) throw notFound('学员')
  if (student.deletedAt) throw accountDeleted()
  const lessonType = tx
    .select()
    .from(lessonTypes)
    .where(eq(lessonTypes.id, input.lessonTypeId))
    .get()
  if (!lessonType?.active) throw notFound('课程')
  const slot = targetSlot(tx, input.target, {
    minutes: lessonType.durationMinutes,
    lessonType,
    rule: input.anyTime ? 'anytime' : 'schedule',
  })
  if (slot.startsAt <= now) throw new ApiError(409, 'started', '该时段已开始')
  if (slot.cancelledAt) throw new ApiError(409, 'slot_closed', '该课已取消')
  if (slot.lessonTypeId !== null && !slot.open) {
    throw new ApiError(409, 'slot_closed', '该小班课已停止报名，请先重新开放')
  }
  const { price, seat } = checkBookable(
    tx,
    now,
    { studentId: student.id, slot, lessonType },
    '该学员',
  )
  const pkg = lessonType.isTrial ? undefined : usablePackage(tx, student.id, lessonType.id, slot)
  return { student, slot, lessonType, price, seat, pkg }
}

/**
 * Why the student's package for this lesson can't pay for the slot, when they have one: it is
 * kept to other coaches or runs out before the lesson. Null when there is no such package.
 */
function packageMismatch(
  tx: Q,
  studentId: number,
  lessonTypeId: number,
  slot: { coachId: number; startsAt: Date },
) {
  const held = tx
    .select()
    .from(packages)
    .where(
      and(
        eq(packages.studentId, studentId),
        eq(packages.lessonTypeId, lessonTypeId),
        eq(packages.status, 'active'),
        gt(packages.lessonsRemaining, 0),
      ),
    )
    .all()
  const forCoach = held.find((p) => p.coachIds.length > 0 && !p.coachIds.includes(slot.coachId))
  if (forCoach) {
    const names = tx
      .select({ name: coaches.name })
      .from(coaches)
      .where(inArray(coaches.id, forCoach.coachIds))
      .all()
      .map((c) => c.name)
    return `课时包「${forCoach.name}」只能约${names.join('、')}的课`
  }
  const expiring = held.find((p) => p.expiresAt <= slot.startsAt)
  if (expiring) return `课时包「${expiring.name}」在这节课前到期`
  return null
}

/** What the booking would cost, for the front desk's confirm step. */
export function frontDeskQuote(
  deps: Deps,
  input: { studentId: number; target: SlotTarget; lessonTypeId: number; anyTime?: boolean },
) {
  // Checked in a transaction that is rolled back, since a private time gets its row on the way.
  const { price, pkg, slot, lessonType } = dryRun(deps.db, (tx) => check(tx, deps.now(), input))
  return {
    price,
    packageNote:
      pkg || lessonType.isTrial
        ? null
        : packageMismatch(deps.db, input.studentId, lessonType.id, slot),
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
    const { slot, lessonType, price, seat, pkg } = check(tx, now, input)
    const base = {
      slotId: slot.id,
      seat,
      studentId: input.studentId,
      lessonTypeId: lessonType.id,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      status: 'confirmed' as const,
      bookedByStaffId: staffId,
      terms: bookingTerms(ruleBook(tx).of(lessonType.id)),
    }
    try {
      if (input.payWith === 'package') {
        if (!pkg) {
          throw new ApiError(
            409,
            'no_package',
            (!lessonType.isTrial && packageMismatch(tx, input.studentId, lessonType.id, slot)) ||
              '该学员没有可用于这节课的课时包',
          )
        }
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
      if (input.listedPriceOnly && amount !== price.price) throw listedPriceOnly(price.price)
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
      if (isUniqueViolation(e)) throw seatTaken(slot)
      throw e
    }
  })
}
