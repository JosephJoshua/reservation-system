// Moving a lesson to another slot (改约). The booking keeps its payment or package lesson.
import {
  bookingWindowError,
  freeCancelDeadline,
  type MoveOptionsDto,
  type PriceTag,
  studentMoveError,
  type VenueSettings,
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
import { assertNoClash, assertSlotFree, slotTaken, windowMessages } from './bookings'
import { priceFor } from './catalog'
import { coachNowKnows } from './coach-notices'
import { moveSummaries } from './move-history'
import { getSettings } from './settings'
import { queueStudentNotice } from './student-notices'

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
    : new ApiError(409, 'price_differs', '该教练价格不同，请取消后重新预约')
}

/** The booking with its slot's coach and lesson type. */
function bookingRow(tx: Q, bookingId: number) {
  return tx
    .select({ booking: bookings, coachId: slots.coachId, lessonType: lessonTypes })
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
  rules: VenueSettings['booking'],
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
 * Moves a confirmed lesson to another free slot of the same length. The old slot is freed and the
 * new one taken in one IMMEDIATE transaction, and the unique index on live bookings refuses a slot
 * someone else took meanwhile. The payment or package lesson stays with the booking. Moving to
 * the slot it is already in is a no-op, so a repeated request does nothing more.
 */
export function moveBooking(deps: Deps, bookingId: number, slotId: number, by: Mover): boolean {
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
    if (booking.slotId === slotId && booking.status === 'confirmed') return false
    if (booking.status !== 'confirmed') {
      throw new ApiError(409, 'not_movable', '只有预约成功的课程可以改约')
    }
    if (booking.startsAt <= now) throw new ApiError(409, 'started', '课程已开始，无法改约')

    const slot = tx.select().from(slots).where(eq(slots.id, slotId)).get()
    // Its own code, so a page can offer other times instead of treating the lesson as gone.
    if (!slot || (coach !== null && slot.coachId !== coach)) {
      throw new ApiError(404, 'slot_not_found', '时段不存在')
    }
    if (!slot.open) throw new ApiError(409, 'slot_closed', '该时段不可预约')
    // Its own code: 'started' means the lesson itself can no longer move.
    if (slot.startsAt <= now) throw new ApiError(409, 'slot_started', '该时段已开始')
    const length = booking.endsAt.getTime() - booking.startsAt.getTime()
    if (slot.endsAt.getTime() - slot.startsAt.getTime() !== length) {
      throw new ApiError(409, 'duration_mismatch', '课程时长与时段不符')
    }
    const pkg = bookingPackage(tx, booking)
    if (student !== null) checkStudentMove(tx, row, slot, pkg, getSettings(tx).booking, now)
    else if (!priceFor(tx, slot.coachId, lessonType, now)) {
      throw new ApiError(409, 'coach_not_teaching', '该教练不教这门课')
    }
    // A package lesson is taught while the package is valid. Only the venue may decide otherwise,
    // say when it moved a lesson it could not give in time.
    if (pkg && by !== 'venue' && pkg.expiresAt <= slot.startsAt) {
      throw new ApiError(409, 'package_expires', '课时包在该时段前到期')
    }

    assertSlotFree(tx, slot.id)
    assertNoClash(
      tx,
      booking.studentId,
      slot,
      student !== null ? '你在这个时间已有预约' : '学员在这个时间已有预约',
      booking.id,
    )

    // A coach moving their own lesson knows about it; anyone else's move is announced to the
    // coach by the sweeper, which compares the booking with what the coach was last told.
    const coachKnows = coach !== null ? coachNowKnows(booking, coach, slot, now) : {}
    try {
      const moved = tx
        .update(bookings)
        .set({ slotId: slot.id, startsAt: slot.startsAt, endsAt: slot.endsAt, ...coachKnows })
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
      if (isUniqueViolation(e)) throw slotTaken()
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
