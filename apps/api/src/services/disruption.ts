// Lessons the venue cannot give as booked (闭馆, 请假, an inactive coach), which a student can
// then cancel for free until they start, and which a payment no longer confirms.
import { DISRUPTION_TEXT, type Disruption, lessonDisruption } from '@rs/shared'
import { and, eq, gt, inArray, lt } from 'drizzle-orm'
import type { Q } from '../db/client'
import { coaches, scheduleExceptions, slots } from '../db/schema'
import { ApiError } from '../errors'

interface Lesson {
  id: number
  slotId: number
  startsAt: Date
  endsAt: Date
}

/** What stands in the way of each booking's lesson; bookings with nothing in the way are left out. */
export function disruptions(tx: Q, lessons: readonly Lesson[]): Map<number, Disruption> {
  const map = new Map<number, Disruption>()
  if (lessons.length === 0) return map
  const coachOf = new Map(
    tx
      .select({ slotId: slots.id, coachId: slots.coachId, active: coaches.active })
      .from(slots)
      .innerJoin(coaches, eq(coaches.id, slots.coachId))
      .where(inArray(slots.id, [...new Set(lessons.map((l) => l.slotId))]))
      .all()
      .map((r) => [r.slotId, r]),
  )
  const first = Math.min(...lessons.map((l) => l.startsAt.getTime()))
  const last = Math.max(...lessons.map((l) => l.endsAt.getTime()))
  const offs = tx
    .select()
    .from(scheduleExceptions)
    .where(
      and(
        eq(scheduleExceptions.kind, 'off'),
        lt(scheduleExceptions.startsAt, new Date(last)),
        gt(scheduleExceptions.endsAt, new Date(first)),
      ),
    )
    .all()
  for (const l of lessons) {
    const coach = coachOf.get(l.slotId)
    if (!coach) continue
    const d = lessonDisruption({ ...l, coachId: coach.coachId }, coach.active, offs)
    if (d) map.set(l.id, d)
  }
  return map
}

export function disruptionOf(tx: Q, lesson: Lesson): Disruption | null {
  return disruptions(tx, [lesson]).get(lesson.id) ?? null
}

/** Refuses to take payment for a lesson the venue cannot give as booked. */
export function assertNotDisrupted(tx: Q, lesson: Lesson) {
  const d = disruptionOf(tx, lesson)
  if (d) {
    throw new ApiError(409, 'lesson_unavailable', `${DISRUPTION_TEXT[d]}，请取消后重新预约`)
  }
}
