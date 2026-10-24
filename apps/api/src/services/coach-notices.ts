import { and, eq, gt, isNotNull, isNull, ne, or, sql } from 'drizzle-orm'
import { bookings, coaches, lessonTypes, slots, students } from '../db/schema'
import type { Deps } from '../deps'
import { lessonTime, type NoticeKind, type NoticeValues } from '../wx-notify'

const BATCH = 50

type Told = Pick<typeof bookings.$inferSelect, 'coachToldBookedAt' | 'coachToldCoachId'>

/**
 * A coach's own change to a lesson needs no message to them. But when the venue moved the lesson
 * to them from a coach who was told about it, that coach still has to hear it is off, so what
 * they were told is kept. These two keep that rule for the coach's own moves and cancels.
 */
export function coachNowKnows(
  b: Told,
  coachId: number,
  slot: { startsAt: Date; endsAt: Date },
  now: Date,
) {
  if (b.coachToldBookedAt !== null && b.coachToldCoachId !== coachId) return {}
  return {
    coachToldBookedAt: b.coachToldBookedAt ?? now,
    coachToldCoachId: coachId,
    coachToldStartsAt: slot.startsAt,
    coachToldEndsAt: slot.endsAt,
  }
}

/** SQL for the same rule: no other coach was told about the lesson. */
export function noOtherCoachTold(coachId: number) {
  return or(isNull(bookings.coachToldCoachId), eq(bookings.coachToldCoachId, coachId))
}

/**
 * Tells coaches about new, moved and cancelled lessons by subscription message. Each change is
 * looked at once: it is marked whether the message went out, was refused, or was not needed. Only
 * an unreachable WeChat leaves it for the next run, until the lesson starts.
 */
export async function notifyCoaches(deps: Deps) {
  // Moves first: a lesson moved to another coach is then announced to them as new.
  await notifyMoves(deps)
  for (const kind of ['booked', 'cancelled'] as const) await notify(deps, kind)
}

/** Sends one message; false when WeChat could not be reached and it should be tried again. */
async function send(
  deps: Deps,
  kind: NoticeKind,
  to: { openid: string | null; startsAt: Date },
  page: string,
  values: NoticeValues,
  bookingId: number,
) {
  const template = deps.notifier?.template(kind)
  if (!deps.notifier || !template || !to.openid || to.startsAt <= deps.now()) return true
  try {
    const result = await deps.notifier.send(to.openid, template, page, values)
    if (result === 'refused') deps.log('coach notice refused', { bookingId, kind })
    return true
  } catch (e) {
    deps.log('coach notice failed', { bookingId, kind, error: (e as Error).message })
    return false
  }
}

const lesson = {
  id: bookings.id,
  startsAt: bookings.startsAt,
  endsAt: bookings.endsAt,
  coachId: slots.coachId,
  toldCoachId: bookings.coachToldCoachId,
  toldStartsAt: bookings.coachToldStartsAt,
  toldEndsAt: bookings.coachToldEndsAt,
  reason: bookings.cancelReason,
  student: students.name,
  lesson: lessonTypes.name,
  openid: coaches.openid,
  coach: coaches.name,
}

/**
 * Bookings with the coach the message goes to: the slot's coach for a new lesson, and the coach
 * who was told about it for a cancelled or moved one, since it may have moved to someone else.
 */
function lessons(deps: Deps, to: 'slot' | 'told') {
  return deps.db
    .select(lesson)
    .from(bookings)
    .innerJoin(slots, eq(slots.id, bookings.slotId))
    .innerJoin(students, eq(students.id, bookings.studentId))
    .innerJoin(lessonTypes, eq(lessonTypes.id, bookings.lessonTypeId))
    .leftJoin(
      coaches,
      eq(
        coaches.id,
        to === 'slot'
          ? slots.coachId
          : sql`coalesce(${bookings.coachToldCoachId}, ${slots.coachId})`,
      ),
    )
}

async function notify(deps: Deps, kind: 'booked' | 'cancelled') {
  const { db } = deps
  const pending = lessons(deps, kind === 'booked' ? 'slot' : 'told')
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

  for (const b of pending) {
    // A cancelled lesson goes out with the time the coach was told, even if it moved since.
    const told =
      kind === 'cancelled' && b.toldStartsAt && b.toldEndsAt
        ? { startsAt: b.toldStartsAt, endsAt: b.toldEndsAt }
        : { startsAt: b.startsAt, endsAt: b.endsAt }
    // A coach the lesson moved away from can no longer open it.
    const own = kind === 'booked' || !b.toldCoachId || b.toldCoachId === b.coachId
    const sent = await send(
      deps,
      `coach_${kind}`,
      { openid: b.openid, startsAt: told.startsAt },
      own ? `coach/lesson/index?id=${b.id}` : 'coach/index/index',
      {
        student: b.student || '学员',
        lesson: b.lesson,
        time: lessonTime(told.startsAt, told.endsAt),
        coach: b.coach ?? '',
        // To them it went away by the move, whatever happened to it afterwards.
        reason: own ? (b.reason ?? '') : '课程已改约',
      },
      b.id,
    )
    if (!sent) continue
    db.update(bookings)
      .set(
        kind === 'booked'
          ? {
              coachToldBookedAt: deps.now(),
              coachToldCoachId: b.coachId,
              coachToldStartsAt: b.startsAt,
              coachToldEndsAt: b.endsAt,
            }
          : { coachToldCancelledAt: deps.now() },
      )
      // The coach may have moved it themselves while this was sending; keep what that recorded.
      .where(
        and(
          eq(bookings.id, b.id),
          kind === 'booked' ? isNull(bookings.coachToldBookedAt) : undefined,
        ),
      )
      .run()
  }
}

/**
 * Lessons that moved since the coach was told about them. The same coach hears the new time; a
 * coach who lost the lesson hears it is off, and the new coach then hears about it as new.
 * Without a moved template, the same coach also hears it as off and then as new.
 */
async function notifyMoves(deps: Deps) {
  const { db } = deps
  const moved = lessons(deps, 'told')
    .where(
      and(
        eq(bookings.status, 'confirmed'),
        isNotNull(bookings.coachToldBookedAt),
        // Past lessons are no longer news to anyone.
        or(gt(bookings.startsAt, deps.now()), gt(bookings.coachToldStartsAt, deps.now())),
        or(
          ne(bookings.coachToldCoachId, slots.coachId),
          ne(bookings.coachToldStartsAt, bookings.startsAt),
          ne(bookings.coachToldEndsAt, bookings.endsAt),
        ),
      ),
    )
    .limit(BATCH)
    .all()

  for (const b of moved) {
    // Never null here, since the query compares them; this tells TypeScript.
    if (!b.toldCoachId || !b.toldStartsAt || !b.toldEndsAt) continue
    const told = { coachId: b.toldCoachId, startsAt: b.toldStartsAt, endsAt: b.toldEndsAt }
    const values = {
      student: b.student || '学员',
      lesson: b.lesson,
      coach: b.coach ?? '',
    }
    if (b.toldCoachId === b.coachId && deps.notifier?.template('coach_moved')) {
      const sent = await send(
        deps,
        'coach_moved',
        { openid: b.openid, startsAt: b.startsAt },
        `coach/lesson/index?id=${b.id}`,
        {
          ...values,
          time: lessonTime(b.startsAt, b.endsAt),
          oldTime: lessonTime(b.toldStartsAt, b.toldEndsAt),
        },
        b.id,
      )
      if (!sent) continue
      // What was sent, not what is there now: a move meanwhile is picked up next run.
      db.update(bookings)
        .set({ coachToldStartsAt: b.startsAt, coachToldEndsAt: b.endsAt })
        .where(stillTold(b.id, told))
        .run()
      continue
    }
    const sent = await send(
      deps,
      'coach_cancelled',
      { openid: b.openid, startsAt: b.toldStartsAt },
      b.toldCoachId === b.coachId ? `coach/lesson/index?id=${b.id}` : 'coach/index/index',
      { ...values, time: lessonTime(b.toldStartsAt, b.toldEndsAt), reason: '课程已改约' },
      b.id,
    )
    if (!sent) continue
    db.update(bookings)
      .set({
        coachToldBookedAt: null,
        coachToldCoachId: null,
        coachToldStartsAt: null,
        coachToldEndsAt: null,
      })
      .where(stillTold(b.id, told))
      .run()
  }
}

/**
 * The booking still records what the coach was told when the message went out. A coach moving
 * the lesson themselves meanwhile records the new time, which the message must not overwrite.
 */
function stillTold(id: number, told: { coachId: number; startsAt: Date; endsAt: Date }) {
  return and(
    eq(bookings.id, id),
    eq(bookings.coachToldCoachId, told.coachId),
    eq(bookings.coachToldStartsAt, told.startsAt),
    eq(bookings.coachToldEndsAt, told.endsAt),
  )
}
