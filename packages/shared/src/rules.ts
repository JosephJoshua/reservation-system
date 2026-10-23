import type { Fen } from './pricing'
import type { VenueSettings } from './settings'
import { venueDateKey, venueInstant } from './time'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

export type BookingWindowError = 'started' | 'too_soon' | 'too_far'

/** Whether a lesson starting at `startsAt` can be booked now under the venue's rules. */
export function bookingWindowError(
  startsAt: Date,
  now: Date,
  rules: VenueSettings['booking'],
): BookingWindowError | null {
  if (startsAt <= now) return 'started'
  if (startsAt.getTime() - now.getTime() < rules.minNoticeMinutes * 60_000) return 'too_soon'
  // Bookable through the end of the venue day `advanceDays` from today.
  const lastDay = venueDateKey(new Date(now.getTime() + rules.advanceDays * DAY))
  if (startsAt >= venueInstant(lastDay, 24 * 60)) return 'too_far'
  return null
}

export type CancelledBy = 'student' | 'venue'

export interface CancellationOutcome {
  /** True when the student cancels after the deadline. */
  late: boolean
  /** Fen to refund on the booking's order (0 for package bookings). */
  refund: Fen
  /** Whether a package lesson goes back to the package. */
  returnLesson: boolean
}

export type CancellationError = 'started' | 'already_closed'

/**
 * What a cancellation does. Students can cancel until the lesson starts; before the deadline they
 * get everything back, after it the late-cancel rule applies. The venue always gives everything back.
 */
export function cancellationOutcome(input: {
  startsAt: Date
  now: Date
  cancelledBy: CancelledBy
  paidWith: 'order' | 'package'
  amountPaid: Fen
  rules: VenueSettings['booking']
}): CancellationOutcome | CancellationError {
  const { startsAt, now, cancelledBy, paidWith, amountPaid, rules } = input
  const full: CancellationOutcome = {
    late: false,
    refund: paidWith === 'order' ? amountPaid : 0,
    returnLesson: paidWith === 'package',
  }
  if (cancelledBy === 'venue') return full
  if (now >= startsAt) return 'started'
  const late = startsAt.getTime() - now.getTime() < rules.cancelDeadlineHours * HOUR
  if (!late) return full
  const rule = rules.lateCancel
  if (rule.kind === 'forfeit') return { late, refund: 0, returnLesson: false }
  return {
    late,
    refund: paidWith === 'order' ? Math.floor((amountPaid * rule.percent) / 100) : 0,
    returnLesson: paidWith === 'package' && rule.percent === 100,
  }
}

/** Last instant a student can cancel and still get everything back. */
export function cancelDeadline(startsAt: Date, rules: VenueSettings['booking']): Date {
  return new Date(startsAt.getTime() - rules.cancelDeadlineHours * HOUR)
}

/** End of the venue day `days` after `from`, used for package validity. */
export function validityEnd(from: Date, days: number): Date {
  return venueInstant(venueDateKey(new Date(from.getTime() + days * DAY)), 24 * 60)
}
