import type { VenueSettings } from '@rs/shared'
import type { Q } from '../db/client'
import { categoryPayRates, coaches } from '../db/schema'

type PayRules = VenueSettings['pay']

/** The parts of a booking that decide whether its coach is paid for it. */
export interface PayableLesson {
  status: string
  endsAt: Date
  attendance: 'attended' | 'no_show' | null
  cancelledBy: 'student' | 'venue' | null
  late: boolean
}

/**
 * Whether the coach is paid for a lesson. A lesson that ended is paid, unless the student did
 * not come and no-shows don't count; unmarked lessons are paid as taught. A student's late cancel
 * is paid only when the venue counts them, once the lesson time has passed. Venue cancels and other cancels are never paid.
 */
export function countsForPay(l: PayableLesson, rules: PayRules, now: Date) {
  // Like taught lessons, a late cancel counts once its time has passed.
  if (l.endsAt > now) return false
  if (l.status === 'confirmed') return l.attendance !== 'no_show' || rules.noShows
  if (l.status === 'cancelled') return l.cancelledBy === 'student' && l.late && rules.lateCancels
  return false
}

/** Looks up a coach's pay rate for a lesson type, in fen, from the coach's current category. */
export function payRateLookup(tx: Q) {
  const categoryOf = new Map(
    tx
      .select({ id: coaches.id, categoryId: coaches.categoryId })
      .from(coaches)
      .all()
      .map((c) => [c.id, c.categoryId]),
  )
  const rates = new Map(
    tx
      .select()
      .from(categoryPayRates)
      .all()
      .map((r) => [`${r.categoryId}:${r.lessonTypeId}`, r.rate]),
  )
  return (coachId: number, lessonTypeId: number): number | null => {
    const categoryId = categoryOf.get(coachId)
    if (categoryId == null) return null
    return rates.get(`${categoryId}:${lessonTypeId}`) ?? null
  }
}
