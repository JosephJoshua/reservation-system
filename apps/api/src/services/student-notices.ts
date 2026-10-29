import { formatYuan } from '@rs/shared'
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, notExists, or, sql } from 'drizzle-orm'
import { immediate, type Q } from '../db/client'
import {
  bookings,
  coaches,
  lessonFeedback,
  lessonTypes,
  orders,
  packageLedger,
  refunds,
  slots,
  studentNotices,
  students,
} from '../db/schema'
import type { Deps } from '../deps'
import { lessonTime } from '../wx-notify'
import { visible } from './feedback-visibility'
import { getSettings } from './settings'
import { wechatOpenid } from './student-link'

const BATCH = 50
export const REMINDER_MS = 2 * 3_600_000
// A message that could not reach WeChat for this long is no longer news.
const STALE_MS = 24 * 3_600_000
const RETRY_MS = 5 * 60_000

const RETRY_MAX_MS = 3_600_000

/**
 * When to try a failed send again: after RETRY_MS, then after as long as the message has waited,
 * up to an hour, so one WeChat keeps failing is not tried every few minutes all day. Student and
 * package messages both use it.
 */
export function retryAfterFailure(now: Date, createdAt: Date) {
  const waited = now.getTime() - createdAt.getTime()
  return new Date(now.getTime() + Math.min(Math.max(RETRY_MS, waited), RETRY_MAX_MS))
}

/** A lesson's coach and time, as the student knows it. */
export interface KnownLesson {
  coachId: number
  startsAt: Date
  endsAt: Date
}

const lessonKey = (l: KnownLesson) =>
  `${l.coachId}@${l.startsAt.toISOString()}/${l.endsAt.toISOString()}`

/**
 * Queues a message caused by something other than booking state, inside the caller's transaction.
 * A moved lesson is reminded about again at its new time. A booking confirmation not sent yet
 * stays: it tells the new time to a student who may only have subscribed to it. `was` is the
 * lesson before the move.
 */
export function queueStudentNotice(
  tx: Q,
  now: Date,
  notice:
    | { bookingId: number; kind: 'moved'; was: KnownLesson }
    | { bookingId: number; kind: 'feedback' },
) {
  const { bookingId, kind } = notice
  // The feedback itself is read when the message goes out, so it says what the coach wrote last.
  if (notice.kind === 'feedback') {
    tx.insert(studentNotices).values({ bookingId, kind, createdAt: now }).run()
    return
  }
  // A reminder not sent yet was for the old time; the sweeper queues one for the new time, unless
  // the move message just told it. One already sent stays, marked with the time it reminded of,
  // so a lesson moved away and back is not reminded twice (queueFromBookings).
  tx.delete(studentNotices)
    .where(
      and(
        eq(studentNotices.bookingId, bookingId),
        eq(studentNotices.kind, 'reminder'),
        isNull(studentNotices.doneAt),
      ),
    )
    .run()
  tx.insert(studentNotices)
    .values({
      bookingId,
      kind,
      data: {
        oldTime: lessonTime(notice.was.startsAt, notice.was.endsAt),
        was: lessonKey(notice.was),
      },
      createdAt: now,
    })
    .run()
  foldMoved(tx, bookingId, now)
}

/**
 * Moved again before the student heard of the last move: one message, from the lesson they know
 * to the one it is now, and none once it is back to what they know. A message being sent right
 * now is claimed and left alone; the next one then starts from the lesson it tells them.
 */
function foldMoved(tx: Q, bookingId: number, now: Date) {
  const unsent = tx
    .select({ id: studentNotices.id, data: studentNotices.data })
    .from(studentNotices)
    .where(
      and(
        eq(studentNotices.bookingId, bookingId),
        eq(studentNotices.kind, 'moved'),
        isNull(studentNotices.doneAt),
      ),
    )
    .orderBy(asc(studentNotices.id))
    .all()
  const [first, ...later] = unsent
  if (!first) return
  const lesson = tx
    .select({ coachId: slots.coachId, startsAt: bookings.startsAt, endsAt: bookings.endsAt })
    .from(bookings)
    .innerJoin(slots, eq(slots.id, bookings.slotId))
    .where(eq(bookings.id, bookingId))
    .get()
  const back = lesson !== undefined && first.data.was === lessonKey(lesson)
  const drop = (back ? unsent : later).map((n) => n.id)
  if (drop.length) tx.delete(studentNotices).where(inArray(studentNotices.id, drop)).run()
  // Dated by the last move, which the reminder rule reads.
  if (!back && later.length) {
    tx.update(studentNotices).set({ createdAt: now }).where(eq(studentNotices.id, first.id)).run()
  }
}

/** Queues and sends students' subscription messages. Run by the sweeper. */
export async function notifyStudents(deps: Deps) {
  immediate(deps.db, (tx) => queueFromBookings(tx, deps.now()))
  await sendPending(deps)
}

function hasNotice(db: Q, kind: 'booked' | 'cancelled' | 'reminder') {
  return db
    .select({ one: sql`1` })
    .from(studentNotices)
    .where(and(eq(studentNotices.bookingId, bookings.id), eq(studentNotices.kind, kind)))
}

function queue(db: Q, now: Date, kind: 'booked' | 'cancelled' | 'reminder', ids: { id: number }[]) {
  for (const { id } of ids) {
    db.insert(studentNotices)
      .values({ bookingId: id, kind, createdAt: now })
      .onConflictDoNothing()
      .run()
  }
}

const remindedFor = (n: { startsAt: Date }) => String(n.startsAt.getTime())

/**
 * The time the student last heard for a lesson moved since, or null when they know where it is:
 * the old time of the first move message after the last one that reached them.
 */
function knownTime(db: Q, bookingId: number): string | null {
  const moved = db
    .select({ data: studentNotices.data, result: studentNotices.result })
    .from(studentNotices)
    .where(and(eq(studentNotices.bookingId, bookingId), eq(studentNotices.kind, 'moved')))
    .orderBy(asc(studentNotices.id))
    .all()
  const unheard = moved.slice(moved.findLastIndex((m) => m.result === 'sent') + 1)
  return unheard[0]?.data.oldTime ?? null
}

/** Finds bookings whose state calls for a message: new, cancelled by the venue, or close. */
function queueFromBookings(db: Q, at: Date) {
  queue(
    db,
    at,
    'booked',
    db
      .select({ id: bookings.id })
      .from(bookings)
      .where(
        and(
          eq(bookings.status, 'confirmed'),
          gt(bookings.startsAt, at),
          notExists(hasNotice(db, 'booked')),
        ),
      )
      .limit(BATCH)
      .all(),
  )
  // The student's own cancellations need no message.
  queue(
    db,
    at,
    'cancelled',
    db
      .select({ id: bookings.id })
      .from(bookings)
      .where(
        and(
          eq(bookings.status, 'cancelled'),
          eq(bookings.cancelledBy, 'venue'),
          notExists(hasNotice(db, 'cancelled')),
        ),
      )
      .limit(BATCH)
      .all(),
  )
  // A reminder of a time the lesson has moved from, for a lesson now close: one for its new time
  // is queued below.
  db.delete(studentNotices)
    .where(
      and(
        eq(studentNotices.kind, 'reminder'),
        isNotNull(studentNotices.doneAt),
        inArray(
          studentNotices.bookingId,
          db
            .select({ id: bookings.id })
            .from(bookings)
            .where(
              and(
                eq(bookings.status, 'confirmed'),
                gt(bookings.startsAt, at),
                lte(bookings.startsAt, new Date(at.getTime() + REMINDER_MS)),
              ),
            ),
        ),
        sql`json_extract(${studentNotices.data}, '$.remindedFor') != (select cast(${bookings.startsAt} as text) from ${bookings} where ${bookings.id} = ${studentNotices.bookingId})`,
      ),
    )
    .run()
  queue(
    db,
    at,
    'reminder',
    db
      .select({ id: bookings.id })
      .from(bookings)
      .where(
        and(
          eq(bookings.status, 'confirmed'),
          gt(bookings.startsAt, at),
          lte(bookings.startsAt, new Date(at.getTime() + REMINDER_MS)),
          notExists(hasNotice(db, 'reminder')),
          // A lesson booked or moved inside the reminder window was just announced with its time.
          notExists(
            db
              .select({ one: sql`1` })
              .from(studentNotices)
              .where(
                and(
                  eq(studentNotices.bookingId, bookings.id),
                  inArray(studentNotices.kind, ['booked', 'moved']),
                  gt(studentNotices.createdAt, sql`${bookings.startsAt} - ${REMINDER_MS}`),
                  // Sent, or still to send; one WeChat refused told the student nothing.
                  or(isNull(studentNotices.result), eq(studentNotices.result, 'sent')),
                ),
              ),
          ),
        ),
      )
      .limit(BATCH)
      .all(),
  )
}

/** What happened to the money or package lesson of a booking the venue cancelled. */
function refundText(db: Q, b: { bookingId: number; paidWith: 'order' | 'package' }) {
  if (b.paidWith === 'package') {
    const returned = db
      .select({ id: packageLedger.id })
      .from(packageLedger)
      .where(and(eq(packageLedger.bookingId, b.bookingId), eq(packageLedger.kind, 'return')))
      .get()
    return returned ? '课时已退回课时包' : '未退回课时'
  }
  const rows = db
    .select({
      amount: refunds.amount,
      status: refunds.status,
      provider: orders.provider,
      settledNote: refunds.settledNote,
    })
    .from(refunds)
    .innerJoin(orders, eq(orders.id, refunds.orderId))
    .where(eq(refunds.bookingId, b.bookingId))
    .all()
  if (rows.length === 0) return '未扣费'
  // Failed refunds wait for the admin to try again.
  const refunded = rows
    .filter((r) => !['failed', 'rejected', 'requested'].includes(r.status))
    .reduce((total, r) => total + r.amount, 0)
  if (!refunded) return '退款处理中'
  // Paid at the front desk, so the money is handed back there.
  if (rows[0]?.provider === 'offline') return `¥${formatYuan(refunded)} 到店退还`
  // Handed back by staff outside WeChat Pay (in cash, say), not to where it came from.
  if (rows.some((r) => r.settledNote !== null)) return `¥${formatYuan(refunded)} 已另行退还`
  return `¥${formatYuan(refunded)} 原路退回`
}

/** A notice with what its message says, read as it is now. */
function noticeRows(db: Q) {
  return db
    .select({
      id: studentNotices.id,
      kind: studentNotices.kind,
      data: studentNotices.data,
      createdAt: studentNotices.createdAt,
      bookingId: bookings.id,
      status: bookings.status,
      paidWith: bookings.paidWith,
      startsAt: bookings.startsAt,
      endsAt: bookings.endsAt,
      reason: bookings.cancelReason,
      openid: students.openid,
      student: students.name,
      coach: coaches.name,
      lesson: lessonTypes.name,
    })
    .from(studentNotices)
    .innerJoin(bookings, eq(bookings.id, studentNotices.bookingId))
    .innerJoin(students, eq(students.id, bookings.studentId))
    .innerJoin(slots, eq(slots.id, bookings.slotId))
    .innerJoin(coaches, eq(coaches.id, slots.coachId))
    .innerJoin(lessonTypes, eq(lessonTypes.id, bookings.lessonTypeId))
}

/**
 * A lesson's feedback for its message, unless the coach deleted it: what it says, and whether the
 * student sees it now.
 */
function noticeFeedback(tx: Q, bookingId: number) {
  return tx
    .select({ text: lessonFeedback.text, visible: sql<number>`${visible}` })
    .from(lessonFeedback)
    .innerJoin(bookings, eq(bookings.id, lessonFeedback.bookingId))
    .where(and(eq(lessonFeedback.bookingId, bookingId), isNull(lessonFeedback.deletedAt)))
    .get()
}

async function sendPending(deps: Deps) {
  const { db } = deps
  const pending = db
    .select({ id: studentNotices.id })
    .from(studentNotices)
    .where(
      and(
        isNull(studentNotices.doneAt),
        or(isNull(studentNotices.retryAt), lte(studentNotices.retryAt, deps.now())),
      ),
    )
    .orderBy(studentNotices.id)
    .limit(BATCH)
    .all()
  if (pending.length === 0) return
  const place = getSettings(db).venue.name

  for (const { id } of pending) {
    const now = deps.now()
    // Claimed for the send, so a move meanwhile does not fold it into a new message, and
    // skipped if a move already did. A send cut off by a restart is not tried again.
    const claimed = db
      .update(studentNotices)
      .set({ doneAt: now })
      .where(and(eq(studentNotices.id, id), isNull(studentNotices.doneAt)))
      .run()
    if (claimed.changes !== 1) continue
    // Read once claimed, so it says what is true now and not when the batch was read.
    const n = noticeRows(db).where(eq(studentNotices.id, id)).get()
    if (!n) continue
    // A reminder for a lesson moved out of the window since it was queued waits to be queued again.
    if (n.kind === 'reminder' && n.startsAt.getTime() > now.getTime() + REMINDER_MS) {
      db.delete(studentNotices).where(eq(studentNotices.id, n.id)).run()
      continue
    }
    const template = deps.notifier?.template(`student_${n.kind}`)
    // Deleted and front-desk accounts hold a placeholder openid.
    const reachable = wechatOpenid(n.openid)
    const sendable = Boolean(deps.notifier && template && reachable)
    const feedback = n.kind === 'feedback' ? noticeFeedback(db, n.bookingId) : undefined
    const stale = now.getTime() - n.createdAt.getTime() > STALE_MS
    // Feedback hidden for now, or on a lesson whose attendance is being corrected, may show
    // again: its message waits rather than being dropped, when it could be sent at all. On a
    // cancelled lesson it never shows again.
    if (sendable && feedback && !feedback.visible && n.status === 'confirmed' && !stale) {
      db.update(studentNotices)
        .set({ doneAt: null, retryAt: new Date(now.getTime() + RETRY_MS) })
        .where(eq(studentNotices.id, n.id))
        .run()
      continue
    }
    // Messages about a lesson that is no longer on, or has started, would mislead, and so would
    // one about feedback the coach deleted or the venue took down.
    const outdated =
      n.kind === 'booked' || n.kind === 'reminder' || n.kind === 'moved'
        ? n.status !== 'confirmed' || n.startsAt <= now
        : stale || (n.kind === 'feedback' && !feedback?.visible)
    let result: 'sent' | 'refused' | 'skipped' = 'skipped'
    if (deps.notifier && template && reachable && !outdated) {
      try {
        result = await deps.notifier.send(
          reachable,
          template,
          `pages/booking-detail/index?id=${n.bookingId}`,
          {
            ...n.data,
            student: n.student || '学员',
            lesson: n.lesson,
            // A cancelled lesson is named by the time the student knows, as it may have moved.
            time:
              (n.kind === 'cancelled' && knownTime(db, n.bookingId)) ||
              lessonTime(n.startsAt, n.endsAt),
            coach: n.coach,
            place,
            // Lets one 课程变动 template carry both cancellations and moves.
            status: n.kind === 'cancelled' ? '已取消' : n.kind === 'moved' ? '已改约' : '',
            reason: n.kind === 'cancelled' ? n.reason || '场馆取消' : '',
            refund: n.kind === 'cancelled' ? refundText(db, n) : '',
            note: feedback?.text ?? '',
          },
        )
        if (result === 'refused') {
          deps.log('student notice refused', { bookingId: n.bookingId, kind: n.kind })
        }
      } catch (e) {
        deps.log('student notice failed', {
          bookingId: n.bookingId,
          kind: n.kind,
          error: (e as Error).message,
        })
        immediate(db, (tx) => {
          // A move while this was sending queued its own message: a move message is folded into
          // it, and a reminder of the old time is dropped.
          const current = tx
            .select({ startsAt: bookings.startsAt })
            .from(bookings)
            .where(eq(bookings.id, n.bookingId))
            .get()
          if (n.kind === 'reminder' && current?.startsAt.getTime() !== n.startsAt.getTime()) {
            tx.delete(studentNotices).where(eq(studentNotices.id, n.id)).run()
            return
          }
          tx.update(studentNotices)
            .set({ doneAt: null, retryAt: retryAfterFailure(now, n.createdAt) })
            .where(eq(studentNotices.id, n.id))
            .run()
          if (n.kind === 'moved') foldMoved(tx, n.bookingId, deps.now())
        })
        continue
      }
    }
    db.update(studentNotices)
      .set({
        doneAt: now,
        result,
        // The time it reminded of; a lesson moved since is reminded of again (queueFromBookings).
        ...(n.kind === 'reminder' ? { data: { ...n.data, remindedFor: remindedFor(n) } } : {}),
      })
      .where(eq(studentNotices.id, n.id))
      .run()
  }
}
