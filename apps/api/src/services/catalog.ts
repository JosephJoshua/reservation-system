import { lessonPrice, type PriceTag } from '@rs/shared'
import { and, eq, inArray, or, sql } from 'drizzle-orm'
import type { Q } from '../db/client'
import { bookings, coaches, coachLessonTypes, lessonTypes } from '../db/schema'

export type LessonType = typeof lessonTypes.$inferSelect

/** The price a student pays for a lesson type with a coach, or null if the coach does not teach it. */
export function priceFor(
  tx: Q,
  coachId: number,
  lessonType: LessonType,
  now: Date,
): PriceTag | null {
  const link = tx
    .select({ price: coachLessonTypes.price, active: coaches.active })
    .from(coachLessonTypes)
    .innerJoin(coaches, eq(coaches.id, coachLessonTypes.coachId))
    .where(
      and(eq(coachLessonTypes.coachId, coachId), eq(coachLessonTypes.lessonTypeId, lessonType.id)),
    )
    .get()
  if (!link?.active) return null
  return linkPrice(lessonType, link.price, now)
}

/** The price for a lesson type given the coach's own price for it, if any. */
export function linkPrice(lessonType: LessonType, coachPrice: number | null, now: Date): PriceTag {
  return lessonPrice(
    {
      price: lessonType.price,
      salePercent: lessonType.salePercent,
      startsAt: lessonType.saleStartsAt,
      endsAt: lessonType.saleEndsAt,
    },
    coachPrice,
    now,
  )
}

/** Whether a student may see and book a lesson type. */
export function visibleTo(lessonType: LessonType, student: { tester: boolean }) {
  return lessonType.active && (!lessonType.adminOnly || student.tester)
}

/** Trial lessons that count against a student's limit: live ones and late-cancelled ones. */
export function trialsUsed(tx: Q, studentId: number): number {
  const row = tx
    .select({ n: sql<number>`count(*)` })
    .from(bookings)
    .innerJoin(lessonTypes, eq(lessonTypes.id, bookings.lessonTypeId))
    .where(
      and(
        eq(bookings.studentId, studentId),
        eq(lessonTypes.isTrial, true),
        or(
          inArray(bookings.status, ['pending_payment', 'confirmed']),
          and(eq(bookings.status, 'cancelled'), eq(bookings.late, true)),
        ),
      ),
    )
    .get()
  return row?.n ?? 0
}
