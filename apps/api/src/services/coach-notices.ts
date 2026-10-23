import { venueParts } from '@rs/shared'
import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import { bookings, coaches, lessonTypes, slots, students } from '../db/schema'
import type { Deps } from '../deps'

const BATCH = 50

/** 2026年10月25日 14:00~15:00, the time format subscription messages accept. */
export function lessonTime(startsAt: Date, endsAt: Date) {
  const s = venueParts(startsAt)
  const e = venueParts(endsAt)
  const hm = (p: { hours: number; minutes: number }) =>
    `${String(p.hours).padStart(2, '0')}:${String(p.minutes).padStart(2, '0')}`
  return `${s.year}年${s.month}月${s.day}日 ${hm(s)}~${hm(e)}`
}

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
