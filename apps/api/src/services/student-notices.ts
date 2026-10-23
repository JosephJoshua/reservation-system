import { formatYuan } from '@rs/shared'
import { and, eq, gt, inArray, isNull, lte, notExists, or, sql } from 'drizzle-orm'
import { immediate, type Q } from '../db/client'
import {
  bookings,
  coaches,
  lessonTypes,
  packageLedger,
  refunds,
  slots,
  studentNotices,
  students,
} from '../db/schema'
import type { Deps } from '../deps'
import { lessonTime, type NoticeValues } from '../wx-notify'
import { getSettings } from './settings'

const BATCH = 50
export const REMINDER_MS = 2 * 3_600_000
// A message that could not reach WeChat for this long is no longer news.
const STALE_MS = 24 * 3_600_000
const RETRY_MS = 5 * 60_000

/**
 * Queues a message caused by something other than booking state, inside the caller's transaction.
 * A moved lesson is reminded about again at its new time, and is never announced as a new booking.
 */
export function queueStudentNotice(
  tx: Q,
  now: Date,
  notice: {
    bookingId: number
    kind: 'moved' | 'feedback'
    data?: Pick<NoticeValues, 'oldTime' | 'note'>
  },
) {
  const { bookingId, kind, data = {} } = notice
  if (kind === 'moved') {
    tx.delete(studentNotices)
      .where(and(eq(studentNotices.bookingId, bookingId), eq(studentNotices.kind, 'reminder')))
      .run()
    tx.insert(studentNotices)
      .values({ bookingId, kind: 'booked', createdAt: now, doneAt: now, result: 'skipped' })
      .onConflictDoNothing()
      .run()
  }
  tx.insert(studentNotices).values({ bookingId, kind, data, createdAt: now }).run()
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
    .select({ amount: refunds.amount, status: refunds.status })
    .from(refunds)
    .where(eq(refunds.bookingId, b.bookingId))
    .all()
  if (rows.length === 0) return '未扣费'
  // Failed refunds wait for the admin to try again.
  const refunded = rows
    .filter((r) => !['failed', 'rejected', 'requested'].includes(r.status))
    .reduce((total, r) => total + r.amount, 0)
  return refunded ? `¥${formatYuan(refunded)} 原路退回` : '退款处理中'
}

async function sendPending(deps: Deps) {
  const { db } = deps
  const pending = db
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

  for (const n of pending) {
    const now = deps.now()
    const template = deps.notifier?.template(`student_${n.kind}`)
    // Messages about a lesson that is no longer on, or has started, would mislead.
    const outdated =
      n.kind === 'booked' || n.kind === 'reminder' || n.kind === 'moved'
        ? n.status !== 'confirmed' || n.startsAt <= now
        : now.getTime() - n.createdAt.getTime() > STALE_MS
    // Deleted accounts keep their bookings under a placeholder openid.
    const reachable = n.openid && !n.openid.startsWith('deleted:')
    let result: 'sent' | 'refused' | 'skipped' = 'skipped'
    if (deps.notifier && template && reachable && !outdated) {
      try {
        result = await deps.notifier.send(
          n.openid,
          template,
          `pages/booking-detail/index?id=${n.bookingId}`,
          {
            ...n.data,
            student: n.student || '学员',
            lesson: n.lesson,
            time: lessonTime(n.startsAt, n.endsAt),
            coach: n.coach,
            place,
            reason: n.kind === 'cancelled' ? n.reason || '场馆取消' : '',
            refund: n.kind === 'cancelled' ? refundText(db, n) : '',
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
        db.update(studentNotices)
          .set({ retryAt: new Date(now.getTime() + RETRY_MS) })
          .where(eq(studentNotices.id, n.id))
          .run()
        continue
      }
    }
    db.update(studentNotices).set({ doneAt: now, result }).where(eq(studentNotices.id, n.id)).run()
  }
}
