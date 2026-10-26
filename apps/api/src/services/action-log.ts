import { type ActionLogEntryDto, formatYuan, type StaffAction, venueParts } from '@rs/shared'
import { and, desc, eq, gte, inArray, lt, or } from 'drizzle-orm'
import type { Q } from '../db/client'
import {
  actionLog,
  bookingMoves,
  bookings,
  coaches,
  lessonTypes,
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

/**
 * Records what a staff member did. Routes call it right after the change commits, so a refused
 * change leaves no entry; changes made in one transaction here pass their own `tx`.
 */
export function logAction(tx: Q, now: Date, staffId: number, entry: ActionEntry) {
  tx.insert(actionLog)
    .values({
      staffId,
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
      staff: { id: staff.id, name: staff.name },
    })
    .from(actionLog)
    .innerJoin(staff, eq(staff.id, actionLog.staffId))
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
  const entries = rows.map(({ entry, staff }) => ({
    id: entry.id,
    action: entry.action as StaffAction,
    summary: entry.summary,
    amount: entry.amount,
    targetKind: entry.targetKind,
    targetId: entry.targetId,
    createdAt: entry.createdAt.toISOString(),
    staff,
    student: entry.studentId ? (people.get(entry.studentId) ?? null) : null,
  }))
  return { rows: entries, total }
}

const hm = (p: { hours: number; minutes: number }) =>
  `${String(p.hours).padStart(2, '0')}:${String(p.minutes).padStart(2, '0')}`

/** 10月25日 14:00, venue time, for summaries. */
export function venueMoment(instant: Date) {
  const p = venueParts(instant)
  return `${p.month}月${p.day}日 ${hm(p)}`
}

export const yuan = (fen: number) => `¥${formatYuan(fen)}`

/** "10月25日 10:00 王教练 一对一私教" and whose booking it is, for log summaries. */
export function describeBooking(tx: Q, bookingId: number) {
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
    what: row ? `${venueMoment(row.startsAt)} ${row.coach} ${row.lesson}` : `预约 #${bookingId}`,
    studentId: row?.studentId ?? null,
  }
}
