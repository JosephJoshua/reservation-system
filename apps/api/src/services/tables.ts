import { peakOverlap, tablesFor, tablesFree, venueDateKey } from '@rs/shared'
import { and, eq, gt, inArray, lt, ne } from 'drizzle-orm'
import type { Q } from '../db/client'
import { bookings, lessonTypes, slots } from '../db/schema'
import { ApiError } from '../errors'
import { getSettings } from './settings'

interface SlotSpan {
  id: number
  startsAt: Date
  endsAt: Date
  /** Set for a group session: the class it teaches. */
  lessonTypeId: number | null
}

/**
 * Whether the venue has a table for one more student in this slot at every moment of it. A
 * private lesson takes one table; a group session takes one per its lesson type's students per
 * table (or one for the whole class), so joining a session may need no new table. `except` is a
 * booking being moved, which gives up its place. Call it inside the IMMEDIATE transaction that
 * books, so two requests cannot both take the last table.
 */
export function hasFreeTable(tx: Q, slot: SlotSpan, except?: number): boolean {
  return !slotsWithoutTable(tx, [slot], except).has(slot.id)
}

export function assertTableFree(tx: Q, slot: SlotSpan, except?: number) {
  if (!hasFreeTable(tx, slot, except)) throw new ApiError(409, 'tables_full', '该时段球台已满')
}

/**
 * The slots among these that could not take one more student for want of a table. `except` is a
 * booking being moved, which gives up its place wherever it goes. `freed` are slots where one
 * seat counted now is given up by booking it: the student's own unpaid hold whose payment time is
 * up, which booking again closes first.
 */
export function slotsWithoutTable(
  tx: Q,
  candidates: readonly SlotSpan[],
  except?: number,
  freed?: ReadonlySet<number>,
): Set<number> {
  const { tables } = getSettings(tx).booking
  const full = new Set<number>()
  if (tables === null || candidates.length === 0) return full
  const from = new Date(Math.min(...candidates.map((s) => s.startsAt.getTime())))
  const to = new Date(Math.max(...candidates.map((s) => s.endsAt.getTime())))
  const running = runningLessons(tx, { startsAt: from, endsAt: to }, except)
  const perTable = studentsPerTable(
    tx,
    candidates.flatMap((s) => (s.lessonTypeId === null ? [] : [s.lessonTypeId])),
  )
  for (const s of candidates) {
    const students = Math.max(0, (running.get(s.id)?.students ?? 0) - (freed?.has(s.id) ? 1 : 0))
    const need =
      s.lessonTypeId === null ? 1 : tablesFor(students + 1, perTable.get(s.lessonTypeId) ?? null)
    const others = [...running.values()].filter((r) => r.slotId !== s.id)
    if (!tablesFree(s, others, tables, need)) full.add(s.id)
  }
  return full
}

/**
 * For each private lesson time not booked yet, whether no table would be free for it. `except` is
 * a booking being moved, which gives up its place.
 */
export function spansWithoutTable(
  tx: Q,
  spans: readonly { startsAt: Date; endsAt: Date }[],
  except?: number,
): boolean[] {
  const { tables } = getSettings(tx).booking
  if (tables === null || spans.length === 0) return spans.map(() => false)
  const from = new Date(Math.min(...spans.map((s) => s.startsAt.getTime())))
  const to = new Date(Math.max(...spans.map((s) => s.endsAt.getTime())))
  // Lessons never cross midnight, so each time is checked against its own day's lessons only.
  const byDay = new Map<string, { startsAt: Date; endsAt: Date; tables: number }[]>()
  for (const r of runningLessons(tx, { startsAt: from, endsAt: to }, except).values()) {
    const day = venueDateKey(r.startsAt)
    byDay.set(day, [...(byDay.get(day) ?? []), r])
  }
  return spans.map((s) => !tablesFree(s, byDay.get(venueDateKey(s.startsAt)) ?? [], tables, 1))
}

/** Tables in use at the busiest moment of each half hour of a span, for the half hours with any. */
export function tablesInUse(tx: Q, span: { startsAt: Date; endsAt: Date }) {
  const running = [...runningLessons(tx, span).values()]
  const out: { startsAt: string; used: number }[] = []
  for (let t = span.startsAt.getTime(); t < span.endsAt.getTime(); t += HALF_HOUR) {
    const used = peakOverlap({ startsAt: new Date(t), endsAt: new Date(t + HALF_HOUR) }, running)
    if (used > 0) out.push({ startsAt: new Date(t).toISOString(), used })
  }
  return out
}

const HALF_HOUR = 30 * 60_000

/**
 * Each slot with a live booking during this time, apart from booking `except`, with how many
 * students it has and the tables they use.
 */
function runningLessons(tx: Q, span: { startsAt: Date; endsAt: Date }, except?: number) {
  const rows = tx
    .select({
      slotId: bookings.slotId,
      startsAt: bookings.startsAt,
      endsAt: bookings.endsAt,
      group: slots.lessonTypeId,
      perTable: lessonTypes.studentsPerTable,
    })
    .from(bookings)
    .innerJoin(slots, eq(slots.id, bookings.slotId))
    .leftJoin(lessonTypes, eq(lessonTypes.id, slots.lessonTypeId))
    .where(
      and(
        inArray(bookings.status, ['pending_payment', 'confirmed']),
        lt(bookings.startsAt, span.endsAt),
        gt(bookings.endsAt, span.startsAt),
        except === undefined ? undefined : ne(bookings.id, except),
      ),
    )
    .all()
  const bySlot = new Map<
    number,
    { slotId: number; startsAt: Date; endsAt: Date; students: number; tables: number }
  >()
  for (const r of rows) {
    const students = (bySlot.get(r.slotId)?.students ?? 0) + 1
    bySlot.set(r.slotId, {
      slotId: r.slotId,
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      students,
      tables: r.group === null ? 1 : tablesFor(students, r.perTable),
    })
  }
  return bySlot
}

function studentsPerTable(tx: Q, ids: number[]) {
  if (ids.length === 0) return new Map<number, number | null>()
  return new Map(
    tx
      .select({ id: lessonTypes.id, perTable: lessonTypes.studentsPerTable })
      .from(lessonTypes)
      .where(inArray(lessonTypes.id, [...new Set(ids)]))
      .all()
      .map((t) => [t.id, t.perTable]),
  )
}
