import {
  type ActionLogEntryDto,
  formatMoney,
  type StaffAction,
  venueDateKey,
  venueParts,
} from '@rs/shared'
import { and, desc, eq, gte, inArray, lt, or } from 'drizzle-orm'
import type { Q } from '../db/client'
import {
  actionLog,
  bookingMoves,
  bookings,
  coaches,
  lessonTypes,
  orders,
  packageLedger,
  refunds,
  slots,
  staff,
  students,
} from '../db/schema'
import { DELETED_NAME } from './account'
import { contains, countAll, ofStudents } from './lists'

export interface ActionEntry {
  action: StaffAction
  summary: string
  amount?: number | null
  studentId?: number | null
  target?: { kind: string; id: number }
}

/** Who did it: a staff member by id, or a coach in the mini program's coach mode. */
export type Actor = number | { coachId: number }

/**
 * Records what a staff member or a coach did. Routes call it right after the change commits, so a
 * refused change leaves no entry; changes made in one transaction here pass their own `tx`.
 */
export function logAction(tx: Q, now: Date, actor: Actor, entry: ActionEntry) {
  tx.insert(actionLog)
    .values({
      staffId: typeof actor === 'number' ? actor : null,
      coachId: typeof actor === 'number' ? null : actor.coachId,
      action: entry.action,
      summary: entry.summary,
      amount: entry.amount ?? null,
      studentId: entry.studentId ?? null,
      targetKind: entry.target?.kind ?? null,
      targetId: entry.target?.id ?? null,
      createdAt: now,
    })
    .run()
}

export const ACTION_LOG_PAGE = 50

export interface ActionFilters {
  staffId?: number
  /** A coach's own actions, from the mini program. */
  coachId?: number
  actions?: StaffAction[]
  studentId?: number
  /** What was done to one lesson: to the session itself and to each of its seats. */
  slotId?: number
  from?: Date
  to?: Date
  /** Text in the summary, or the student it was done for. */
  q?: string
}

function actionWhere(tx: Q, q: ActionFilters) {
  const slot = q.slotId ? tx.select().from(slots).where(eq(slots.id, q.slotId)).get() : undefined
  // Bookings in the lesson now, and those moved out of it, which keep their history.
  const movedOut = slot
    ? tx
        .select({ id: bookingMoves.bookingId })
        .from(bookingMoves)
        .where(
          and(
            eq(bookingMoves.fromCoachId, slot.coachId),
            eq(bookingMoves.fromStartsAt, slot.startsAt),
            eq(bookingMoves.fromEndsAt, slot.endsAt),
          ),
        )
        .all()
        .map((m) => m.id)
    : []
  const lesson = q.slotId
    ? or(
        and(eq(actionLog.targetKind, 'slot'), eq(actionLog.targetId, q.slotId)),
        and(
          eq(actionLog.targetKind, 'booking'),
          or(
            inArray(
              actionLog.targetId,
              tx.select({ id: bookings.id }).from(bookings).where(eq(bookings.slotId, q.slotId)),
            ),
            movedOut.length ? inArray(actionLog.targetId, movedOut) : undefined,
          ),
        ),
      )
    : undefined
  return and(
    q.staffId ? eq(actionLog.staffId, q.staffId) : undefined,
    q.coachId ? eq(actionLog.coachId, q.coachId) : undefined,
    q.actions?.length ? inArray(actionLog.action, q.actions) : undefined,
    q.studentId ? eq(actionLog.studentId, q.studentId) : undefined,
    lesson,
    q.from ? gte(actionLog.createdAt, q.from) : undefined,
    q.to ? lt(actionLog.createdAt, q.to) : undefined,
    q.q ? or(contains(actionLog.summary, q.q), ofStudents(actionLog.studentId, q.q)) : undefined,
  )
}

/**
 * Newest first, one page at a time: from `offset`, or after `before`, the last id of the
 * previous page. With how many entries match in all, for the log's page numbers.
 */
export function listActions(
  tx: Q,
  q: ActionFilters & { before?: number; limit?: number; offset?: number },
): { rows: ActionLogEntryDto[]; total: number } {
  const where = actionWhere(tx, q)
  const total = tx.select({ n: countAll }).from(actionLog).where(where).get()?.n ?? 0
  const rows = tx
    .select({
      entry: actionLog,
      staffName: staff.name,
      coachName: coaches.name,
    })
    .from(actionLog)
    .leftJoin(staff, eq(staff.id, actionLog.staffId))
    .leftJoin(coaches, eq(coaches.id, actionLog.coachId))
    .where(and(where, q.before ? lt(actionLog.id, q.before) : undefined))
    .orderBy(desc(actionLog.id))
    .limit(q.limit ?? ACTION_LOG_PAGE)
    .offset(q.before ? 0 : (q.offset ?? 0))
    .all()
  const ids = [...new Set(rows.flatMap((r) => (r.entry.studentId ? [r.entry.studentId] : [])))]
  const people = new Map(
    ids.length
      ? tx
          .select({
            id: students.id,
            name: students.name,
            phone: students.phone,
            deletedAt: students.deletedAt,
          })
          .from(students)
          .where(inArray(students.id, ids))
          .all()
          .map(({ deletedAt, ...s }) => [
            s.id,
            deletedAt ? { ...s, name: DELETED_NAME, phone: '' } : s,
          ])
      : [],
  )
  const entries = rows.map(({ entry, staffName, coachName }) => ({
    id: entry.id,
    action: entry.action as StaffAction,
    summary: entry.summary,
    amount: entry.amount,
    targetKind: entry.targetKind,
    targetId: entry.targetId,
    createdAt: entry.createdAt.toISOString(),
    staff: entry.staffId === null ? null : { id: entry.staffId, name: staffName ?? '' },
    coach: entry.coachId === null ? null : { id: entry.coachId, name: coachName ?? '' },
    student: entry.studentId ? (people.get(entry.studentId) ?? null) : null,
  }))
  return { rows: entries, total }
}

const hm = (p: { hours: number; minutes: number }) =>
  `${String(p.hours).padStart(2, '0')}:${String(p.minutes).padStart(2, '0')}`

/** 10月25日 14:00, venue time, for summaries; 2027年1月1日 11:00 in another year than `now`'s. */
export function venueMoment(instant: Date, now: Date) {
  const p = venueParts(instant)
  const year = p.year === venueParts(now).year ? '' : `${p.year}年`
  return `${year}${p.month}月${p.day}日 ${hm(p)}`
}

/** 10月25日 14:00-16:00, or 10月25日 14:00 至 10月27日 12:00 over several days. */
export function venueSpan(startsAt: Date, endsAt: Date, now: Date) {
  const end = venueParts(endsAt)
  const sameDay = venueDateKey(startsAt) === venueDateKey(new Date(endsAt.getTime() - 1))
  return sameDay
    ? `${venueMoment(startsAt, now)}-${end.hours || end.minutes ? hm(end) : '24:00'}`
    : `${venueMoment(startsAt, now)} 至 ${venueMoment(endsAt, now)}`
}

/** ¥2,800, as the admin shows money. */
export const yuan = formatMoney

/** What a venue or coach cancel gave back, as "，退款 ¥200" for its log summary. */
export function cancelOutcome(tx: Q, bookingId: number) {
  const refund = tx
    .select({
      amount: refunds.amount,
      provider: orders.provider,
      status: refunds.status,
      abnormal: refunds.abnormal,
    })
    .from(refunds)
    .innerJoin(orders, eq(orders.id, refunds.orderId))
    .where(eq(refunds.bookingId, bookingId))
    .orderBy(desc(refunds.id))
    .get()
  const returned = tx
    .select({ id: packageLedger.id })
    .from(packageLedger)
    .where(and(eq(packageLedger.bookingId, bookingId), eq(packageLedger.kind, 'return')))
    .get()
  // An unpaid hold was simply released.
  // WeChat Pay may have refused the refund already, when it was sent on the cancel, or answered
  // that it is stuck (ABNORMAL, say a closed card), which staff handle on the 退款 page too.
  const failed =
    refund?.status === 'failed' || (refund?.status !== 'succeeded' && !!refund?.abnormal)
  const text = refund
    ? `，${refund.provider === 'offline' ? '待线下退还' : refund.status === 'failed' ? '退款失败' : failed ? '退款异常' : '退款'} ${yuan(refund.amount)}`
    : returned
      ? '，退回课时 1 节'
      : ''
  return {
    text,
    refunded: refund?.amount ?? null,
    offline: refund?.provider === 'offline',
    lessonReturned: !refund && !!returned,
    refundFailed: failed,
  }
}

/** "10月25日 10:00 王教练 一对一私教" and whose booking it is, for log summaries. */
export function describeBooking(tx: Q, bookingId: number, now: Date) {
  const row = tx
    .select({
      startsAt: bookings.startsAt,
      studentId: bookings.studentId,
      coach: coaches.name,
      lesson: lessonTypes.name,
    })
    .from(bookings)
    .innerJoin(slots, eq(slots.id, bookings.slotId))
    .innerJoin(coaches, eq(coaches.id, slots.coachId))
    .innerJoin(lessonTypes, eq(lessonTypes.id, bookings.lessonTypeId))
    .where(eq(bookings.id, bookingId))
    .get()
  return {
    what: row
      ? `${venueMoment(row.startsAt, now)} ${row.coach} ${row.lesson}`
      : `预约 #${bookingId}`,
    studentId: row?.studentId ?? null,
  }
}
