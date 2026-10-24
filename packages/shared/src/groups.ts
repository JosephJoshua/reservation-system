// Group classes (小班课): sessions the venue schedules, where each student books one seat.
import type { VenueSettings } from './settings'

/** Most students one group session can take. */
export const MAX_CAPACITY = 30

/** Whether a lesson type is a group class: it takes more than one student. */
export function isGroup(lessonType: { capacity: number }): boolean {
  return lessonType.capacity > 1
}

/** Why these group settings on a lesson type cannot be saved, or null. */
export function groupSettingsError(t: {
  capacity: number
  minStudents: number | null
  isTrial: boolean
}): string | null {
  if (t.capacity < 1 || t.capacity > MAX_CAPACITY) return `人数上限需在 1 到 ${MAX_CAPACITY} 之间`
  if (t.isTrial && t.capacity > 1) return '体验课不能设为小班课'
  if (t.minStudents === null) return null
  if (t.capacity === 1) return '一对一课程不设开班人数'
  if (t.minStudents < 2 || t.minStudents > t.capacity) return '最低开班人数需在 2 到人数上限之间'
  return null
}

/** The lowest seat from 1 to `capacity` that no live booking holds, or null when it is full. */
export function freeSeat(taken: readonly number[], capacity: number): number | null {
  const used = new Set(taken)
  for (let seat = 1; seat <= capacity; seat++) if (!used.has(seat)) return seat
  return null
}

/**
 * Hours before a session its minimum headcount is checked: the free-cancel deadline, so students
 * who booked could still cancel for free until then, and at least one hour, so a class is never
 * called off as it starts.
 */
export function minCheckHours(
  rules: Pick<VenueSettings['booking'], 'cancelDeadlineHours'>,
): number {
  return Math.max(rules.cancelDeadlineHours, 1)
}

/**
 * Whether a session's minimum headcount is due to be checked now: from `minCheckHours` before it
 * until it starts. A session scheduled after that point is never checked: the venue chose to run it.
 */
export function minCheckDue(
  session: { startsAt: Date; createdAt: Date },
  now: Date,
  rules: Pick<VenueSettings['booking'], 'cancelDeadlineHours'>,
): boolean {
  const checkAt = new Date(session.startsAt.getTime() - minCheckHours(rules) * 3_600_000)
  return session.createdAt < checkAt && now >= checkAt && now < session.startsAt
}
