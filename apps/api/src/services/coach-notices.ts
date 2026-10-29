import { and, asc, eq, gt, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm'
import { bookings, coaches, lessonTypes, slots, students } from '../db/schema'
import type { Deps } from '../deps'
import { lessonTime, type NoticeKind, type NoticeValues } from '../wx-notify'

const BATCH = 50
/** Failed sends before a message is given up on, as if WeChat had refused it. */
export const MAX_NOTICE_FAILURES = 8
const RETRY_BASE_MS = 60_000
const RETRY_MAX_MS = 3_600_000

/** When to try again after this many failed sends: 1, 2, 4 ... minutes, at most an hour. */
export function noticeRetryAt(now: Date, failures: number) {
  return new Date(now.getTime() + Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS))
}

/** Which message a row's failed sends were for, so they never count against another one. */
type MessageKey = 'booked' | 'cancelled' | 'moved' | 'session_booked' | 'session_cancelled'
/** A new lesson or session whose message was given up on: the coach never heard of it. */
const GIVEN_UP = 'given_up'

/**
 * A row whose message failed waits for its retry time. Another message about it, say a
 * cancellation after a failed move message, is due at once.
 */
function due(table: typeof bookings | typeof slots, key: MessageKey, now: Date) {
  return or(
    isNull(table.coachNoticeRetryAt),
    lte(table.coachNoticeRetryAt, now),
    isNull(table.coachNoticeKind),
    ne(table.coachNoticeKind, key),
  )
}

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
    // They know it now, even if the message about it was given up on.
    coachNoticeKind: null,
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
 * looked at once: it is marked whether the message went out, was refused, or was not needed. A
 * failed send is tried again later, until the lesson starts or it has failed MAX_NOTICE_FAILURES
 * times.
 */
export async function notifyCoaches(deps: Deps) {
  // Moves first: a lesson moved to another coach is then announced to them as new.
  await notifyMoves(deps)
  for (const kind of ['booked', 'cancelled'] as const) await notify(deps, kind)
  await notifySessions(deps)
}

/**
 * Tells a coach once that a group session of theirs has students, and once that a session they
 * heard about was called off. Seats coming and going in between are not news to them.
 */
async function notifySessions(deps: Deps) {
  const { db } = deps
  const now = deps.now()
  const session = {
    id: slots.id,
    startsAt: slots.startsAt,
    endsAt: slots.endsAt,
    reason: slots.cancelReason,
    lesson: lessonTypes.name,
    openid: coaches.openid,
    coach: coaches.name,
    failures: slots.coachNoticeFailures,
    noticeKind: slots.coachNoticeKind,
  }
  const base = () =>
    db
      .select(session)
      .from(slots)
      .innerJoin(lessonTypes, eq(lessonTypes.id, slots.lessonTypeId))
      .innerJoin(coaches, eq(coaches.id, slots.coachId))
  const booked = base()
    .where(
      and(
        isNull(slots.coachToldBookedAt),
        isNull(slots.cancelledAt),
        gt(slots.startsAt, now),
        sql`exists (select 1 from ${bookings} where ${bookings.slotId} = ${slots.id} and ${bookings.status} = 'confirmed')`,
        due(slots, 'session_booked', now),
      ),
    )
    .orderBy(asc(slots.id))
    .limit(BATCH)
    .all()
  for (const s of booked) {
    const count = db
      .select({ id: bookings.id })
      .from(bookings)
      .where(and(eq(bookings.slotId, s.id), eq(bookings.status, 'confirmed')))
      .all().length
    const sent = await send(
      deps,
      'coach_booked',
      { openid: s.openid, startsAt: s.startsAt },
      `coach/session/index?id=${s.id}`,
      {
        student: `已有 ${count} 人报名`,
        lesson: s.lesson,
        time: lessonTime(s.startsAt, s.endsAt),
        coach: s.coach,
        reason: '',
      },
      { ...s, table: 'slots', key: 'session_booked' },
    )
    if (sent === 'retry') continue
    db.update(slots).set({ coachToldBookedAt: now }).where(eq(slots.id, s.id)).run()
  }
  const cancelled = base()
    .where(
      and(
        isNotNull(slots.cancelledAt),
        isNotNull(slots.coachToldBookedAt),
        isNull(slots.coachToldCancelledAt),
        due(slots, 'session_cancelled', now),
      ),
    )
    .orderBy(asc(slots.id))
    .limit(BATCH)
    .all()
  for (const s of cancelled) {
    // A coach who never heard of the session needs no word that it is off.
    const sent =
      s.noticeKind === GIVEN_UP
        ? 'skipped'
        : await send(
            deps,
            'coach_cancelled',
            { openid: s.openid, startsAt: s.startsAt },
            `coach/session/index?id=${s.id}`,
            {
              student: '小班课',
              lesson: s.lesson,
              time: lessonTime(s.startsAt, s.endsAt),
              coach: s.coach,
              reason: s.reason ?? '',
            },
            { ...s, table: 'slots', key: 'session_cancelled' },
          )
    if (sent === 'retry') continue
    db.update(slots).set({ coachToldCancelledAt: now }).where(eq(slots.id, s.id)).run()
  }
}

/**
 * The booking or group session a message is about, which message it is, and the failed sends
 * recorded on the row and which message they were for.
 */
interface Target {
  table: 'bookings' | 'slots'
  id: number
  key: MessageKey
  failures: number
  noticeKind: string | null
}

/** Records the failed sends of the row's message, and when to try again. */
function setFailures(
  deps: Deps,
  target: Target,
  failures: number,
  retryAt: Date | null,
  kind: string | null,
) {
  const set = { coachNoticeFailures: failures, coachNoticeRetryAt: retryAt, coachNoticeKind: kind }
  if (target.table === 'slots') {
    deps.db.update(slots).set(set).where(eq(slots.id, target.id)).run()
  } else {
    deps.db.update(bookings).set(set).where(eq(bookings.id, target.id)).run()
  }
}

/**
 * Sends one message: 'retry' when it failed and is tried again later, with the wait doubling each
 * time. One that keeps failing is given up on, so it neither blocks other messages nor uses up
 * WeChat's quota; a given up message about a new lesson is remembered, so the coach is not later
 * told about changes to a lesson they never heard of.
 */
async function send(
  deps: Deps,
  kind: NoticeKind,
  to: { openid: string | null; startsAt: Date },
  page: string,
  values: NoticeValues,
  target: Target,
) {
  const template = deps.notifier?.template(kind)
  const ref = { [target.table === 'slots' ? 'slotId' : 'bookingId']: target.id, kind }
  // Failures recorded for another message do not count against this one.
  const before = target.noticeKind === target.key ? target.failures : 0
  if (deps.notifier && template && to.openid && to.startsAt > deps.now()) {
    try {
      const result = await deps.notifier.send(to.openid, template, page, values)
      if (result === 'refused') deps.log('coach notice refused', ref)
    } catch (e) {
      const failures = before + 1
      const error = (e as Error).message
      if (failures < MAX_NOTICE_FAILURES) {
        deps.log('coach notice failed', { ...ref, failures, error })
        setFailures(deps, target, failures, noticeRetryAt(deps.now(), failures), target.key)
        return 'retry'
      }
      deps.log('coach notice given up', { ...ref, failures, error })
      const isNew = target.key === 'booked' || target.key === 'session_booked'
      setFailures(deps, target, 0, null, isNew ? GIVEN_UP : null)
      return 'given_up'
    }
  }
  // The next message about the row starts afresh.
  if (target.failures > 0 || (target.noticeKind !== null && target.noticeKind !== GIVEN_UP)) {
    setFailures(deps, target, 0, null, target.noticeKind === GIVEN_UP ? GIVEN_UP : null)
  }
  return 'settled'
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
  failures: bookings.coachNoticeFailures,
  noticeKind: bookings.coachNoticeKind,
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
      and(
        kind === 'booked'
          ? and(
              eq(bookings.status, 'confirmed'),
              isNull(bookings.coachToldBookedAt),
              // Coaches hear about a group session as a whole (notifySessions).
              isNull(slots.lessonTypeId),
            )
          : and(
              eq(bookings.status, 'cancelled'),
              // Only lessons the coach heard about; a hold that never got paid is not news.
              isNotNull(bookings.coachToldBookedAt),
              isNull(bookings.coachToldCancelledAt),
            ),
        due(bookings, kind, deps.now()),
      ),
    )
    .orderBy(asc(bookings.id))
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
    // A coach who never heard of the lesson needs no word that it is off.
    const sent =
      kind === 'cancelled' && b.noticeKind === GIVEN_UP
        ? 'skipped'
        : await send(
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
            { ...b, table: 'bookings', key: kind },
          )
    if (sent === 'retry') continue
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
        due(bookings, 'moved', deps.now()),
      ),
    )
    .orderBy(asc(bookings.id))
    .limit(BATCH)
    .all()

  for (const b of moved) {
    // Never null here, since the query compares them; this tells TypeScript.
    if (!b.toldCoachId || !b.toldStartsAt || !b.toldEndsAt) continue
    const told = { coachId: b.toldCoachId, startsAt: b.toldStartsAt, endsAt: b.toldEndsAt }
    const target = { ...b, table: 'bookings', key: 'moved' } as const
    // The coach never heard of the lesson: nothing to tell them about its move. A coach it moved
    // to from them hears of it as new.
    if (b.noticeKind === GIVEN_UP) {
      db.update(bookings)
        .set(
          b.toldCoachId === b.coachId
            ? { coachToldStartsAt: b.startsAt, coachToldEndsAt: b.endsAt }
            : {
                coachToldBookedAt: null,
                coachToldCoachId: null,
                coachToldStartsAt: null,
                coachToldEndsAt: null,
                coachNoticeKind: null,
              },
        )
        .where(stillTold(b.id, told))
        .run()
      continue
    }
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
        target,
      )
      if (sent === 'retry') continue
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
      target,
    )
    if (sent === 'retry') continue
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
