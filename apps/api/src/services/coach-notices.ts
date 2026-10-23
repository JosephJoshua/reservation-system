import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import { bookings, coaches, lessonTypes, slots, students } from '../db/schema'
import type { Deps } from '../deps'
import { lessonTime } from '../wx-notify'

const BATCH = 50

/**
 * Tells coaches about new and cancelled lessons by subscription message. Each booking is looked
 * at once per kind: it is marked whether the message went out, was refused, or was not needed.
 * Only an unreachable WeChat leaves it for the next run, until the lesson starts.
 */
export async function notifyCoaches(deps: Deps) {
  for (const kind of ['booked', 'cancelled'] as const) await notify(deps, kind)
}

async function notify(deps: Deps, kind: 'booked' | 'cancelled') {
  const { db } = deps
  const column = kind === 'booked' ? 'coachToldBookedAt' : 'coachToldCancelledAt'
  const pending = db
    .select({
      id: bookings.id,
      startsAt: bookings.startsAt,
      endsAt: bookings.endsAt,
      reason: bookings.cancelReason,
      openid: coaches.openid,
      coach: coaches.name,
      student: students.name,
      lesson: lessonTypes.name,
    })
    .from(bookings)
    .innerJoin(slots, eq(slots.id, bookings.slotId))
    .innerJoin(coaches, eq(coaches.id, slots.coachId))
    .innerJoin(students, eq(students.id, bookings.studentId))
    .innerJoin(lessonTypes, eq(lessonTypes.id, bookings.lessonTypeId))
    .where(
      kind === 'booked'
        ? and(eq(bookings.status, 'confirmed'), isNull(bookings.coachToldBookedAt))
        : and(
            eq(bookings.status, 'cancelled'),
            // Only lessons the coach heard about; a hold that never got paid is not news.
            isNotNull(bookings.coachToldBookedAt),
            isNull(bookings.coachToldCancelledAt),
          ),
    )
    .limit(BATCH)
    .all()

  const template = deps.notifier?.template(`coach_${kind}`)
  for (const b of pending) {
    const now = deps.now()
    if (deps.notifier && template && b.openid && b.startsAt > now) {
      try {
        const result = await deps.notifier.send(
          b.openid,
          template,
          `coach/lesson/index?id=${b.id}`,
          {
            student: b.student || '学员',
            lesson: b.lesson,
            time: lessonTime(b.startsAt, b.endsAt),
            coach: b.coach,
            reason: b.reason ?? '',
          },
        )
        if (result === 'refused') deps.log('coach notice refused', { bookingId: b.id, kind })
      } catch (e) {
        deps.log('coach notice failed', { bookingId: b.id, kind, error: (e as Error).message })
        continue
      }
    }
    db.update(bookings)
      .set({ [column]: now })
      .where(eq(bookings.id, b.id))
      .run()
  }
}
