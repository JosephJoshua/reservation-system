// Moving a lesson to another slot (改约). The booking keeps its payment or package lesson.
import {
  type BookingRules,
  bookingWindowError,
  freeCancelDeadline,
  type MoveOptionsDto,
  type OpenTimeDto,
  type PriceTag,
  studentMoveError,
} from '@rs/shared'
import { and, asc, desc, eq } from 'drizzle-orm'
import { immediate, type Q } from '../db/client'
import {
  bookingMoves,
  bookings,
  coaches,
  coachLessonTypes,
  lessonTypes,
  packages,
  slots,
} from '../db/schema'
import type { Deps } from '../deps'
import { ApiError, isUniqueViolation, notFound } from '../errors'
import {
  assertNoClash,
  assertTeaches,
  seatTaken,
  takeSeat,
  targetTime,
  windowMessages,
} from './bookings'
import { priceFor } from './catalog'
import { coachNowKnows } from './coach-notices'
import { moveSummaries } from './move-history'
import { assertNotOff, openTimes, outsideHours, type SlotTarget, targetSlot } from './schedule'
import { ruleBook } from './settings'
import { queueStudentNotice } from './student-notices'
import { assertTableFree } from './tables'

/** Who moves a lesson: the student, the coach (to their own slots only), or the venue. */
export type Mover = { studentId: number } | { coachId: number } | 'venue'

const moveWindowMessages = { ...windowMessages, too_soon: '离上课时间太近，无法改约' } as const

type BookingRow = typeof bookings.$inferSelect
type PackageRow = typeof packages.$inferSelect

/**
 * Why a student cannot move this booking to a lesson with `coachId`, or null. Another coach is
 * fine when no money changes hands: a package that covers them, or their price now is what the
 * student paid. The venue and the coach decide this themselves.
 */
function coachError(
  booking: BookingRow,
  pkg: PackageRow | undefined,
  fromCoachId: number,
  coachId: number,
  price: PriceTag | null,
): ApiError | null {
  if (!price) return new ApiError(409, 'coach_not_teaching', '该教练不教这门课')
  if (coachId === fromCoachId) return null
  if (pkg) {
    return pkg.coachIds.length > 0 && !pkg.coachIds.includes(coachId)
      ? new ApiError(409, 'coach_not_covered', '课时包不能用于该教练')
      : null
  }
  return price.price === booking.price
    ? null
    : new ApiError(409, 'price_differs', '这位教练的价格不同，请取消后重新预约')
}

/** The booking with its slot's coach and lesson type. */
function bookingRow(tx: Q, bookingId: number) {
  return tx
    .select({
      booking: bookings,
      coachId: slots.coachId,
      inSession: slots.lessonTypeId,
      lessonType: lessonTypes,
    })
    .from(bookings)
    .innerJoin(slots, eq(slots.id, bookings.slotId))
    .innerJoin(lessonTypes, eq(lessonTypes.id, bookings.lessonTypeId))
    .where(eq(bookings.id, bookingId))
    .get()
}

function bookingPackage(tx: Q, booking: BookingRow) {
  return booking.packageId === null
    ? undefined
    : tx.select().from(packages).where(eq(packages.id, booking.packageId)).get()
}

/** The coaches a student may move this booking to, for the move page. */
export function moveOptions(deps: Deps, bookingId: number, studentId: number): MoveOptionsDto {
  const { db } = deps
  const row = bookingRow(db, bookingId)
  if (!row || row.booking.studentId !== studentId) throw notFound('预约')
  const now = deps.now()
  const pkg = bookingPackage(db, row.booking)
  // Priced one by one with the rule the move itself checks; a venue has a handful of coaches.
  // The lesson's own coach first, so the page opens on them.
  const coachIds = db
    .select({ id: coaches.id })
    .from(coachLessonTypes)
    .innerJoin(coaches, eq(coaches.id, coachLessonTypes.coachId))
    .where(eq(coachLessonTypes.lessonTypeId, row.lessonType.id))
    .orderBy(desc(eq(coaches.id, row.coachId)), asc(coaches.sort), asc(coaches.id))
    .all()
    .map((c) => c.id)
    .filter((id) => {
      const price = priceFor(db, id, row.lessonType, now)
      return !coachError(row.booking, pkg, row.coachId, id, price)
    })
  return { coachIds }
}

/** The rules only a student's own move follows: the allowance, the window, the price. */
function checkStudentMove(
  tx: Q,
  row: NonNullable<ReturnType<typeof bookingRow>>,
  slot: typeof slots.$inferSelect,
  pkg: PackageRow | undefined,
  rules: BookingRules,
  now: Date,
) {
  const { booking, lessonType } = row
  const summary = moveSummaries(tx, [booking.id]).get(booking.id)
  const error = studentMoveError({
    status: booking.status,
    deadline: freeCancelDeadline(booking.startsAt, rules, summary?.lastMove),
    now,
    movesUsed: summary?.studentMoves ?? 0,
    rules,
  })
  if (error === 'deadline') throw new ApiError(409, 'move_deadline', '已过免费取消时间，无法改约')
  if (error === 'no_moves_left') {
    throw new ApiError(
      409,
      'no_moves_left',
      rules.studentMoves ? '改约次数已用完' : '暂不支持自助改约，请联系场馆',
    )
  }
  const windowError = bookingWindowError(slot.startsAt, now, rules)
  if (windowError === 'too_soon' || windowError === 'too_far') {
    throw new ApiError(409, windowError, moveWindowMessages[windowError])
  }
  const price = priceFor(tx, slot.coachId, lessonType, now)
  const coach = coachError(booking, pkg, row.coachId, slot.coachId, price)
  if (coach) throw coach
}

/**
 * Moves a confirmed lesson to another time of the same length and kind: a private lesson to a time
 * the coach's 排班 offers (or any free time, for the venue with `anyTime`), a group class seat to
 * another session of the same class. The old seat is freed and the new one taken
 * in one IMMEDIATE transaction, and the unique index on live seats refuses a seat someone else
 * took meanwhile. The payment or package lesson stays with the booking. Moving to
 * the time it already has is a no-op, so a repeated request does nothing more, except that the
 * venue with `anyTime` keeps a lesson now outside 排班 where it is, as agreed ('agreed').
 */
export function moveBooking(
  deps: Deps,
  bookingId: number,
  target: SlotTarget,
  by: Mover,
  options: { anyTime?: boolean } = {},
): boolean | 'agreed' {
  const now = deps.now()
  const student = typeof by === 'object' && 'studentId' in by ? by.studentId : null
  const coach = typeof by === 'object' && 'coachId' in by ? by.coachId : null
  return immediate(deps.db, (tx) => {
    const row = bookingRow(tx, bookingId)
    if (
      !row ||
      (student !== null && row.booking.studentId !== student) ||
      (coach !== null && row.coachId !== coach)
    ) {
      throw notFound('预约')
    }
    const { booking, lessonType } = row
    // Its own code, so a page can offer other times instead of treating the lesson as gone.
    const at = (() => {
      try {
        return targetTime(tx, target)
      } catch {
        throw new ApiError(404, 'slot_not_found', '时段不存在')
      }
    })()
    const here =
      'slotId' in target && at.slot?.lessonTypeId !== null
        ? booking.slotId === at.slot?.id
        : row.inSession === null &&
          at.coachId === row.coachId &&
          at.startsAt.getTime() === booking.startsAt.getTime()
    if (here && booking.status === 'confirmed') {
      // The venue keeping a lesson where it is although 排班 no longer covers it: agreed with the
      // coach, so it leaves the lessons to sort out.
      if (
        by === 'venue' &&
        options.anyTime &&
        row.inSession === null &&
        booking.startsAt > now &&
        !booking.outsideAgreed &&
        outsideHours(tx, row.coachId, booking)
      ) {
        assertNotOff(tx, row.coachId, booking)
        tx.update(bookings).set({ outsideAgreed: true }).where(eq(bookings.id, booking.id)).run()
        return 'agreed'
      }
      return false
    }
    if (booking.status !== 'confirmed') {
      throw new ApiError(409, 'not_movable', '只有预约成功的课程可以改约')
    }
    if (booking.startsAt <= now) throw new ApiError(409, 'started', '课程已开始，无法改约')
    // The venue runs its group sessions; a coach cannot move a student out of one.
    if (coach !== null && row.inSession !== null) {
      throw new ApiError(409, 'group_lesson', '小班课请联系场馆调整')
    }
    if (coach !== null && at.coachId !== coach) {
      throw new ApiError(404, 'slot_not_found', '时段不存在')
    }
    // Its own code: 'started' means the lesson itself can no longer move.
    if (at.startsAt <= now) throw new ApiError(409, 'slot_started', '该时段已开始')
    const length = booking.endsAt.getTime() - booking.startsAt.getTime()
    const slot = targetSlot(tx, target, {
      minutes: length / 60_000,
      lessonType: row.inSession === null ? { capacity: 1 } : lessonType,
      rule: by === 'venue' && options.anyTime ? 'anytime' : 'schedule',
      except: booking.id,
    })
    if (slot.cancelledAt || (slot.lessonTypeId !== null && !slot.open)) {
      throw new ApiError(409, 'slot_closed', '该时段不可预约')
    }
    // A group class moves to another session of the same class, a private lesson to a private time.
    assertTeaches(slot, lessonType)
    if (slot.endsAt.getTime() - slot.startsAt.getTime() !== length) {
      throw new ApiError(409, 'duration_mismatch', '课程时长与时段不符')
    }
    const pkg = bookingPackage(tx, booking)
    if (student !== null) {
      // The window is the lesson type's now; the deadline and allowance are what it was booked under.
      const book = ruleBook(tx)
      const rules = { ...book.of(lessonType.id), ...book.termsOf(booking) }
      checkStudentMove(tx, row, slot, pkg, rules, now)
    } else if (!priceFor(tx, slot.coachId, lessonType, now)) {
      throw new ApiError(409, 'coach_not_teaching', '该教练不教这门课')
    } else if (
      coach !== null &&
      bookingWindowError(slot.startsAt, now, ruleBook(tx).of(lessonType.id)) === 'too_far'
    ) {
      // A coach moves within the days students can book the lesson; only the venue goes further.
      throw new ApiError(409, 'too_far', moveWindowMessages.too_far)
    }
    // A package lesson is taught while the package is valid. Only the venue may decide otherwise,
    // say when it moved a lesson it could not give in time.
    if (pkg && by !== 'venue' && pkg.expiresAt <= slot.startsAt) {
      throw new ApiError(409, 'package_expires', '课时包在该时段前到期')
    }

    const seat = takeSeat(tx, slot)
    assertNoClash(
      tx,
      booking.studentId,
      slot,
      student !== null ? '你在这个时间已有预约' : '学员在这个时间已有预约',
      booking.id,
    )
    assertTableFree(tx, slot, booking.id)

    // A coach moving their own lesson knows about it; anyone else's move is announced to the
    // coach by the sweeper, which compares the booking with what the coach was last told.
    const coachKnows = coach !== null ? coachNowKnows(booking, coach, slot, now) : {}
    try {
      const moved = tx
        .update(bookings)
        .set({
          slotId: slot.id,
          seat,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          // Only a venue move outside 排班 is agreed with the coach; any other move is inside it.
          outsideAgreed:
            by === 'venue' &&
            !!options.anyTime &&
            slot.lessonTypeId === null &&
            outsideHours(tx, slot.coachId, slot),
          ...coachKnows,
        })
        .where(
          and(
            eq(bookings.id, booking.id),
            eq(bookings.status, 'confirmed'),
            eq(bookings.slotId, booking.slotId),
          ),
        )
        .run()
      if (moved.changes !== 1) throw new ApiError(409, 'not_movable', '预约已变化，请刷新')
    } catch (e) {
      if (isUniqueViolation(e)) throw seatTaken(slot)
      throw e
    }
    tx.insert(bookingMoves)
      .values({
        bookingId: booking.id,
        by: student !== null ? 'student' : coach !== null ? 'coach' : 'venue',
        fromCoachId: row.coachId,
        fromStartsAt: booking.startsAt,
        fromEndsAt: booking.endsAt,
        toCoachId: slot.coachId,
        toStartsAt: slot.startsAt,
        toEndsAt: slot.endsAt,
        createdAt: now,
      })
      .run()
    queueStudentNotice(tx, now, {
      bookingId: booking.id,
      kind: 'moved',
      was: { coachId: row.coachId, startsAt: booking.startsAt, endsAt: booking.endsAt },
    })
    return true
  })
}

/**
 * Times on some venue dates a coach can move one of their private lessons to: their own 排班's
 * open start times for the lesson's length within the days it can be booked ahead, other than the
 * time it has now.
 */
export function coachMoveTimes(
  deps: Deps,
  bookingId: number,
  coachId: number,
  dates: string[],
): OpenTimeDto[] {
  const { db } = deps
  const row = bookingRow(db, bookingId)
  if (!row || row.coachId !== coachId || row.inSession !== null) throw notFound('预约')
  const { booking } = row
  const now = deps.now()
  const rules = ruleBook(db).of(booking.lessonTypeId)
  return openTimes(db, {
    coachIds: [coachId],
    dates,
    minutes: (booking.endsAt.getTime() - booking.startsAt.getTime()) / 60_000,
    notBefore: now,
    except: booking.id,
  })
    .filter(
      (t) =>
        t.startsAt.getTime() !== booking.startsAt.getTime() &&
        bookingWindowError(t.startsAt, now, rules) !== 'too_far',
    )
    .map((t) => ({
      coachId: t.coachId,
      startsAt: t.startsAt.toISOString(),
      endsAt: t.endsAt.toISOString(),
      tableFull: t.tableFull,
    }))
}
