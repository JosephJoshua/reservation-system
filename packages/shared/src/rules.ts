import type { Fen } from './pricing'
import type { BookingRules, RuleName, RuleOverrides } from './settings'
import { venueDateKey, venueInstant } from './time'

/** Every booking rule. Listed here rather than read off the zod schema so the mini program bundle stays free of zod. */
export const RULE_NAMES = [
  'advanceDays',
  'minNoticeMinutes',
  'cancelDeadlineHours',
  'lateCancel',
  'studentMoves',
] as const satisfies readonly RuleName[]

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/** A lesson type's rules: its own where it sets one, the venue's otherwise. */
export function rulesFor(venue: BookingRules, own: RuleOverrides | null | undefined): BookingRules {
  return Object.fromEntries(RULE_NAMES.map((k) => [k, own?.[k] ?? venue[k]])) as BookingRules
}

/** The rules a booking keeps from when it was made, so later edits leave it alone. */
export type BookingTerms = Pick<BookingRules, 'cancelDeadlineHours' | 'lateCancel' | 'studentMoves'>

export function bookingTerms(rules: BookingTerms): BookingTerms {
  return {
    cancelDeadlineHours: rules.cancelDeadlineHours,
    lateCancel: rules.lateCancel,
    studentMoves: rules.studentMoves,
  }
}

/** Whether two sets of terms say the same, as a student shown one would be booked under the other. */
export function sameTerms(a: BookingTerms, b: BookingTerms): boolean {
  const late = (r: BookingTerms) =>
    r.lateCancel.kind === 'partial' ? r.lateCancel.percent : r.lateCancel.kind
  return (
    a.cancelDeadlineHours === b.cancelDeadlineHours &&
    a.studentMoves === b.studentMoves &&
    late(a) === late(b)
  )
}

export type BookingWindowError = 'started' | 'too_soon' | 'too_far'

/** Whether a lesson starting at `startsAt` can be booked now under its lesson type's rules. */
export function bookingWindowError(
  startsAt: Date,
  now: Date,
  rules: Pick<BookingRules, 'advanceDays' | 'minNoticeMinutes'>,
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

export type CancellationError = 'started' | 'ended'

/**
 * What a cancellation does. Students can cancel until the lesson starts; before the deadline they
 * get everything back, after it the late-cancel rule applies. The venue always gives everything
 * back, and can cancel until the lesson ends (a coach who did not show up), not after. `deadline`
 * replaces the usual one, for a lesson the venue moved (see freeCancelDeadline).
 */
export function cancellationOutcome(input: {
  startsAt: Date
  endsAt: Date
  now: Date
  cancelledBy: CancelledBy
  paidWith: 'order' | 'package'
  amountPaid: Fen
  rules: Pick<BookingRules, 'cancelDeadlineHours' | 'lateCancel'>
  deadline?: Date
}): CancellationOutcome | CancellationError {
  const { startsAt, endsAt, now, cancelledBy, paidWith, amountPaid, rules } = input
  const full: CancellationOutcome = {
    late: false,
    refund: paidWith === 'order' ? amountPaid : 0,
    returnLesson: paidWith === 'package',
  }
  if (cancelledBy === 'venue') return now >= endsAt ? 'ended' : full
  if (now >= startsAt) return 'started'
  const late = now > (input.deadline ?? cancelDeadline(startsAt, rules))
  if (!late) return full
  const rule = rules.lateCancel
  if (rule.kind === 'forfeit') return { late, refund: 0, returnLesson: false }
  return {
    late,
    refund: paidWith === 'order' ? Math.floor((amountPaid * rule.percent) / 100) : 0,
    returnLesson: paidWith === 'package' && rule.percent === 100,
  }
}

export type StudentMoveError = 'not_confirmed' | 'deadline' | 'no_moves_left'

/**
 * Whether a student can move a booking to another time themselves: a paid or free confirmed
 * lesson, until its free-cancel deadline, while the venue's move allowance lasts. The venue and
 * the coach can move a lesson until it starts.
 */
export function studentMoveError(input: {
  status: 'pending_payment' | 'confirmed' | 'cancelled' | 'expired'
  /** The lesson's free-cancel deadline (see freeCancelDeadline). */
  deadline: Date
  now: Date
  movesUsed: number
  rules: Pick<BookingRules, 'studentMoves'>
}): StudentMoveError | null {
  const { status, deadline, now, movesUsed, rules } = input
  if (status !== 'confirmed') return 'not_confirmed'
  if (now > deadline) return 'deadline'
  if (movesUsed >= rules.studentMoves) return 'no_moves_left'
  return null
}

/**
 * Last instant a student can cancel a lesson for free, or move it. When the venue or the coach
 * last moved it, and only after the usual deadline for its new time, the student never chose
 * that time, so they can cancel or move it for free until it starts.
 */
export function freeCancelDeadline(
  startsAt: Date,
  rules: Pick<BookingRules, 'cancelDeadlineHours'>,
  lastMove?: { by: 'student' | 'coach' | 'venue'; at: Date },
): Date {
  const usual = cancelDeadline(startsAt, rules)
  return lastMove && lastMove.by !== 'student' && lastMove.at > usual ? startsAt : usual
}

/** Last instant a student can cancel and still get everything back. */
export function cancelDeadline(
  startsAt: Date,
  rules: Pick<BookingRules, 'cancelDeadlineHours'>,
): Date {
  return new Date(startsAt.getTime() - rules.cancelDeadlineHours * HOUR)
}

/** Whether a lesson ends on the venue day it starts. Ending at 24:00 counts. */
export function endsSameVenueDay(startsAt: Date, endsAt: Date): boolean {
  return venueDateKey(new Date(endsAt.getTime() - 1)) === venueDateKey(startsAt)
}

/** End of the venue day `days` after `from`, used for package validity. */
export function validityEnd(from: Date, days: number): Date {
  return venueInstant(venueDateKey(new Date(from.getTime() + days * DAY)), 24 * 60)
}

/** What a package grants, as the student was shown it and as the package is made. */
export interface PackageTerms {
  lessonTypeId: number
  /** Empty means every coach who teaches the lesson type. */
  coachIds: number[]
  lessonCount: number
  validityDays: number
}

/** Whether two sets of package terms grant the same thing; coach order does not matter. */
export function samePackageTerms(a: PackageTerms, b: PackageTerms): boolean {
  const coaches = (ids: number[]) => [...new Set(ids)].sort((x, y) => x - y).join(',')
  return (
    a.lessonTypeId === b.lessonTypeId &&
    a.lessonCount === b.lessonCount &&
    a.validityDays === b.validityDays &&
    coaches(a.coachIds) === coaches(b.coachIds)
  )
}

interface Span {
  startsAt: Date
  endsAt: Date
  /** Tables it uses, 1 when left out. */
  tables?: number
}

/**
 * The most tables lessons from `others` use at one moment during `lesson`. Lessons that only
 * touch at an end do not overlap.
 */
export function peakOverlap(lesson: Span, others: readonly Span[]): number {
  const edges: [number, number][] = []
  for (const o of others) {
    const start = Math.max(o.startsAt.getTime(), lesson.startsAt.getTime())
    const end = Math.min(o.endsAt.getTime(), lesson.endsAt.getTime())
    const n = o.tables ?? 1
    if (start < end && n > 0) edges.push([start, n], [end, -n])
  }
  // Ends sort before starts at the same moment, so back-to-back lessons share a table.
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let on = 0
  let peak = 0
  for (const [, d] of edges) {
    on += d
    peak = Math.max(peak, on)
  }
  return peak
}

/**
 * Whether a lesson needing `need` tables at `lesson` fits the venue's tables alongside `others`;
 * null tables means no limit.
 */
export function tablesFree(
  lesson: Span,
  others: readonly Span[],
  tables: number | null,
  need = 1,
): boolean {
  return tables === null || peakOverlap(lesson, others) + need <= tables
}

/**
 * Tables a lesson with this many students uses: a private lesson or a group class with no
 * students-per-table set takes one, otherwise one per `perTable` students. None while empty.
 */
export function tablesFor(students: number, perTable: number | null): number {
  if (students <= 0) return 0
  return perTable === null ? 1 : Math.ceil(students / perTable)
}
