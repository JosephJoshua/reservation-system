// What happened to moved lessons, read by the booking views, cancels and further moves.
import { asc, inArray } from 'drizzle-orm'
import type { Q } from '../db/client'
import { bookingMoves } from '../db/schema'

export interface MoveSummary {
  /** Moves the student made themselves, which count against the venue's allowance. */
  studentMoves: number
  /** Start of the lesson's first time. */
  movedFrom: Date
  /** Who moved it last, and when. */
  lastMove: { by: 'student' | 'coach' | 'venue'; at: Date }
}

/** The first time to show next to a moved lesson; none once it is back at that time. */
export function movedFromIso(summary: MoveSummary | undefined, startsAt: Date): string | null {
  if (!summary || summary.movedFrom.getTime() === startsAt.getTime()) return null
  return summary.movedFrom.toISOString()
}

/** How each moved booking was moved; bookings never moved are left out. */
export function moveSummaries(tx: Q, bookingIds: number[]): Map<number, MoveSummary> {
  const map = new Map<number, MoveSummary>()
  if (bookingIds.length === 0) return map
  const rows = tx
    .select({
      bookingId: bookingMoves.bookingId,
      by: bookingMoves.by,
      fromStartsAt: bookingMoves.fromStartsAt,
      createdAt: bookingMoves.createdAt,
    })
    .from(bookingMoves)
    .where(inArray(bookingMoves.bookingId, bookingIds))
    .orderBy(asc(bookingMoves.id))
    .all()
  for (const r of rows) {
    const lastMove = { by: r.by, at: r.createdAt }
    const summary = map.get(r.bookingId) ?? { studentMoves: 0, movedFrom: r.fromStartsAt, lastMove }
    if (r.by === 'student') summary.studentMoves++
    summary.lastMove = lastMove
    map.set(r.bookingId, summary)
  }
  return map
}
