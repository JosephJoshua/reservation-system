import { type CoachDto, lessonPrice, type PriceTag } from '@rs/shared'
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm'
import type { Q } from '../db/client'
import {
  bookings,
  categoryPrices,
  coachCategories,
  coaches,
  coachLessonTypes,
  lessonTypes,
  orders,
} from '../db/schema'

export type LessonType = typeof lessonTypes.$inferSelect
type Coach = typeof coaches.$inferSelect

/** The price a student pays for a lesson type with a coach, or null if the coach does not teach it. */
export function priceFor(
  tx: Q,
  coachId: number,
  lessonType: LessonType,
  now: Date,
): PriceTag | null {
  const link = tx
    .select({ price: categoryPrices.price, active: coaches.active })
    .from(coachLessonTypes)
    .innerJoin(coaches, eq(coaches.id, coachLessonTypes.coachId))
    .leftJoin(
      categoryPrices,
      and(
        eq(categoryPrices.categoryId, coaches.categoryId),
        eq(categoryPrices.lessonTypeId, coachLessonTypes.lessonTypeId),
      ),
    )
    .where(
      and(eq(coachLessonTypes.coachId, coachId), eq(coachLessonTypes.lessonTypeId, lessonType.id)),
    )
    .get()
  if (!link?.active) return null
  return linkPrice(lessonType, link.price, now)
}

/** The price for a lesson type given the coach's category price for it, if any. */
export function linkPrice(
  lessonType: LessonType,
  categoryPrice: number | null,
  now: Date,
): PriceTag {
  return lessonPrice(
    {
      price: lessonType.price,
      salePercent: lessonType.salePercent,
      startsAt: lessonType.saleStartsAt,
      endsAt: lessonType.saleEndsAt,
    },
    categoryPrice,
    now,
  )
}

/** Students' view of coaches, with the price of each of the given lesson types they teach. */
export function coachViews(tx: Q, rows: Coach[], types: LessonType[], now: Date): CoachDto[] {
  const categories = new Map(
    tx
      .select()
      .from(coachCategories)
      .all()
      .map((c) => [c.id, c.name]),
  )
  const prices = tx.select().from(categoryPrices).all()
  const links = tx.select().from(coachLessonTypes).all()
  return rows.map((coach) => ({
    id: coach.id,
    name: coach.name,
    category: (coach.categoryId && categories.get(coach.categoryId)) || '',
    title: coach.title,
    tags: coach.tags,
    avatarUrl: coach.avatarUrl,
    lessons: types.flatMap((t) => {
      if (!links.some((l) => l.coachId === coach.id && l.lessonTypeId === t.id)) return []
      const own = prices.find((p) => p.categoryId === coach.categoryId && p.lessonTypeId === t.id)
      return [{ lessonTypeId: t.id, price: linkPrice(t, own?.price ?? null, now) }]
    }),
  }))
}

/** Whether a student may see and book a lesson type. */
export function visibleTo(lessonType: LessonType, student: { tester: boolean }) {
  return lessonType.active && (!lessonType.adminOnly || student.tester)
}

/**
 * Trial lessons that count against a student's limit: live ones and late-cancelled ones. With
 * `lapsedAt`, an unpaid hold whose payment time is up by then does not count: booking a trial
 * closes such holds first (see createBooking), so only the catalog passes it.
 */
export function trialsUsed(tx: Q, studentId: number, lapsedAt?: Date): number {
  const row = tx
    .select({ n: sql<number>`count(distinct ${bookings.id})` })
    .from(bookings)
    .innerJoin(lessonTypes, eq(lessonTypes.id, bookings.lessonTypeId))
    .leftJoin(orders, and(eq(orders.bookingId, bookings.id), eq(orders.status, 'pending')))
    .where(
      and(
        eq(bookings.studentId, studentId),
        eq(lessonTypes.isTrial, true),
        or(
          eq(bookings.status, 'confirmed'),
          and(
            eq(bookings.status, 'pending_payment'),
            lapsedAt ? or(isNull(orders.expiresAt), gt(orders.expiresAt, lapsedAt)) : undefined,
          ),
          and(eq(bookings.status, 'cancelled'), eq(bookings.late, true)),
        ),
      ),
    )
    .get()
  return row?.n ?? 0
}

/** The student's unpaid trial holds that can still be paid at `now`. */
export function payableTrialHolds(tx: Q, studentId: number, now: Date): number {
  const row = tx
    .select({ n: sql<number>`count(distinct ${bookings.id})` })
    .from(bookings)
    .innerJoin(lessonTypes, eq(lessonTypes.id, bookings.lessonTypeId))
    .leftJoin(orders, and(eq(orders.bookingId, bookings.id), eq(orders.status, 'pending')))
    .where(
      and(
        eq(bookings.studentId, studentId),
        eq(lessonTypes.isTrial, true),
        eq(bookings.status, 'pending_payment'),
        or(isNull(orders.expiresAt), gt(orders.expiresAt, now)),
      ),
    )
    .get()
  return row?.n ?? 0
}
