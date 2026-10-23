import { lessonPrice, type PriceTag } from '@rs/shared'
import { and, eq } from 'drizzle-orm'
import type { Q } from '../db/client'
import { coaches, coachLessonTypes, type lessonTypes } from '../db/schema'

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
  return lessonPrice(
    {
      price: lessonType.price,
      salePercent: lessonType.salePercent,
      startsAt: lessonType.saleStartsAt,
      endsAt: lessonType.saleEndsAt,
    },
    link.price,
    now,
  )
}

/** Whether a student may see and book a lesson type. */
export function visibleTo(lessonType: LessonType, student: { tester: boolean }) {
  return lessonType.active && (!lessonType.adminOnly || student.tester)
}
