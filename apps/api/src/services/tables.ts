import { tablesFree } from '@rs/shared'
import { and, gt, inArray, lt, ne } from 'drizzle-orm'
import type { Q } from '../db/client'
import { bookings } from '../db/schema'
import { ApiError } from '../errors'
import { getSettings } from './settings'

/**
 * Whether the venue has a table for a lesson in this slot at every moment of it. Each slot with
 * a live booking holds one table, so a slot that already has one needs no new table. `except`
 * is a booking being moved, which gives up its place. Call it inside the IMMEDIATE transaction
 * that books, so two requests cannot both take the last table.
 */
export function hasFreeTable(
  tx: Q,
  slot: { id: number; startsAt: Date; endsAt: Date },
  except?: number,
): boolean {
  return !slotsWithoutTable(tx, [slot], except).has(slot.id)
}

export function assertTableFree(
  tx: Q,
  slot: { id: number; startsAt: Date; endsAt: Date },
  except?: number,
) {
  if (!hasFreeTable(tx, slot, except)) throw new ApiError(409, 'tables_full', '该时段球台已满')
}

/**
 * The slots among these that a new lesson could not get a table for. `except` is the student's
 * booking being moved, which gives up its place.
 */
export function slotsWithoutTable(
  tx: Q,
  slots: readonly { id: number; startsAt: Date; endsAt: Date }[],
  except?: number,
): Set<number> {
  const { tables } = getSettings(tx).booking
  const full = new Set<number>()
  if (tables === null || slots.length === 0) return full
  const from = new Date(Math.min(...slots.map((s) => s.startsAt.getTime())))
  const to = new Date(Math.max(...slots.map((s) => s.endsAt.getTime())))
  const running = runningLessons(tx, { startsAt: from, endsAt: to }, except)
  for (const s of slots) {
    if (running.some((r) => r.slotId === s.id)) continue
    if (!tablesFree(s, running, tables)) full.add(s.id)
  }
  return full
}

/** Each slot with a live booking during this time, apart from booking `except`. */
function runningLessons(tx: Q, span: { startsAt: Date; endsAt: Date }, except?: number) {
  const rows = tx
    .select({ slotId: bookings.slotId, startsAt: bookings.startsAt, endsAt: bookings.endsAt })
    .from(bookings)
    .where(
      and(
        inArray(bookings.status, ['pending_payment', 'confirmed']),
        lt(bookings.startsAt, span.endsAt),
        gt(bookings.endsAt, span.startsAt),
        except === undefined ? undefined : ne(bookings.id, except),
      ),
    )
    .all()
  return [...new Map(rows.map((r) => [r.slotId, r])).values()]
}
