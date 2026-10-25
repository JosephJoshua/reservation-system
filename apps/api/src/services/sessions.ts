// Group sessions (小班课): slots the venue schedules for one group class, with a seat per student.
import {
  endsSameVenueDay,
  isGroup,
  MAX_CAPACITY,
  minCheckDue,
  minCheckHours,
  venueParts,
} from '@rs/shared'
import { and, eq, gt, inArray, isNotNull, isNull, lt } from 'drizzle-orm'
import { immediate, type Q } from '../db/client'
import { bookings, coaches, lessonTypes, orders, slots } from '../db/schema'
import type { Deps } from '../deps'
import { ApiError, notFound } from '../errors'
import { cancelBooking, LIVE, takenSeats } from './bookings'
import { priceFor } from './catalog'
import { exceptionsFor } from './schedule'
import { getSettings, ruleBook } from './settings'

export interface NewSessions {
  lessonTypeId: number
  capacity: number
  sessions: { coachId: number; startsAt: Date; endsAt: Date }[]
}

export const UNDERFILLED_REASON = '报名人数不足，课程取消'

const pad = (n: number) => String(n).padStart(2, '0')
function when(at: Date) {
  const t = venueParts(at)
  return `${t.month}月${t.day}日 ${pad(t.hours)}:${pad(t.minutes)}`
}

/** Live bookings per slot. */
export function liveCounts(tx: Q, slotIds: number[]) {
  const counts = new Map<number, number>()
  if (!slotIds.length) return counts
  const rows = tx
    .select({ slotId: bookings.slotId })
    .from(bookings)
    .where(and(inArray(bookings.slotId, slotIds), inArray(bookings.status, LIVE)))
    .all()
  for (const r of rows) counts.set(r.slotId, (counts.get(r.slotId) ?? 0) + 1)
  return counts
}

/**
 * Schedules group sessions, all or none. A session takes the coach's time: it is refused over a
 * booked lesson, another session, 请假 or 闭馆, and private lessons cannot be booked over it while
 * it is on. It may lie outside the coach's weekly hours. Returns the new slot ids.
 */
export function createSessions(tx: Q, now: Date, input: NewSessions) {
  const lessonType = tx
    .select()
    .from(lessonTypes)
    .where(eq(lessonTypes.id, input.lessonTypeId))
    .get()
  if (!lessonType) throw notFound('课程')
  if (!isGroup(lessonType)) throw new ApiError(409, 'not_group', '请选择小班课课程')
  assertCapacity(input.capacity, lessonType.minStudents)
  const ids: number[] = []
  for (const s of input.sessions) {
    const coach = tx.select().from(coaches).where(eq(coaches.id, s.coachId)).get()
    if (!coach) throw notFound('教练')
    if (s.startsAt <= now) throw new ApiError(400, 'slot_in_past', '不能给已过去的时间排课')
    if (s.endsAt.getTime() - s.startsAt.getTime() !== lessonType.durationMinutes * 60_000) {
      throw new ApiError(400, 'duration_mismatch', `每节需为 ${lessonType.durationMinutes} 分钟`)
    }
    if (!endsSameVenueDay(s.startsAt, s.endsAt)) {
      throw new ApiError(400, 'crosses_midnight', `${when(s.startsAt)} 开始会上到第二天`)
    }
    if (!priceFor(tx, s.coachId, lessonType, now)) {
      throw new ApiError(409, 'coach_not_teaching', `${coach.name}不教${lessonType.name}`)
    }
    // Includes sessions inserted earlier in this request.
    const overlapping = tx
      .select()
      .from(slots)
      .where(
        and(
          eq(slots.coachId, s.coachId),
          lt(slots.startsAt, s.endsAt),
          gt(slots.endsAt, s.startsAt),
        ),
      )
      .all()
    const counts = liveCounts(
      tx,
      overlapping.map((o) => o.id),
    )
    if (overlapping.some((o) => o.lessonTypeId !== null && !o.cancelledAt)) {
      throw new ApiError(409, 'slot_overlap', `${when(s.startsAt)} 与该教练已有的小班课重叠`)
    }
    if (overlapping.some((o) => (counts.get(o.id) ?? 0) > 0)) {
      throw new ApiError(409, 'slot_overlap', `${when(s.startsAt)} 该教练已有预约`)
    }
    const off = exceptionsFor(tx, [s.coachId], s)
      .get(s.coachId)
      ?.find((e) => e.kind === 'off')
    if (off) {
      throw new ApiError(
        409,
        'coach_off',
        `${when(s.startsAt)} ${off.coachId === null ? '场馆闭馆' : `${coach.name}请假`}`,
      )
    }
    ids.push(
      tx
        .insert(slots)
        .values({ ...s, lessonTypeId: lessonType.id, capacity: input.capacity, createdAt: now })
        .returning({ id: slots.id })
        .get().id,
    )
  }
  return { ids, lessonType }
}

/** A session takes 2 to 30 students, and never fewer than its class needs to go ahead. */
function assertCapacity(capacity: number, minStudents: number | null) {
  const least = Math.max(2, minStudents ?? 0)
  if (capacity < least || capacity > MAX_CAPACITY) {
    throw new ApiError(400, 'invalid_capacity', `人数需在 ${least} 到 ${MAX_CAPACITY} 之间`)
  }
}

/** Changes how many students a session takes; never below those already booked. */
export function setSessionCapacity(tx: Q, slotId: number, capacity: number) {
  const slot = tx.select().from(slots).where(eq(slots.id, slotId)).get()
  if (!slot) throw notFound('时段')
  if (slot.lessonTypeId === null) throw new ApiError(409, 'not_group', '只有小班课可以修改人数')
  const lessonType = tx
    .select({ minStudents: lessonTypes.minStudents })
    .from(lessonTypes)
    .where(eq(lessonTypes.id, slot.lessonTypeId))
    .get()
  assertCapacity(capacity, lessonType?.minStudents ?? null)
  const seats = takenSeats(tx, slot.id)
  const booked = seats.length
  if (capacity < booked) {
    throw new ApiError(
      409,
      'capacity_below_booked',
      `已有 ${booked} 人报名，人数不能少于 ${booked}`,
    )
  }
  // Seats are numbered from 1; a lower capacity must not strand a booking on a higher seat.
  if (Math.max(0, ...seats) > capacity) renumberSeats(tx, slot.id)
  tx.update(slots).set({ capacity }).where(eq(slots.id, slot.id)).run()
  return { slot, before: slot.capacity }
}

/** Gives a slot's live bookings seats 1, 2, 3 and so on, in booking order. */
function renumberSeats(tx: Q, slotId: number) {
  const live = tx
    .select({ id: bookings.id })
    .from(bookings)
    .where(and(eq(bookings.slotId, slotId), inArray(bookings.status, LIVE)))
    .orderBy(bookings.id)
    .all()
  // Out of the way first, so no two live bookings share a seat midway.
  live.forEach((b, i) => {
    tx.update(bookings)
      .set({ seat: -(i + 1) })
      .where(eq(bookings.id, b.id))
      .run()
  })
  live.forEach((b, i) => {
    tx.update(bookings)
      .set({ seat: i + 1 })
      .where(eq(bookings.id, b.id))
      .run()
  })
}

/**
 * Calls off a whole session: it takes no more bookings, and every student's seat is cancelled by
 * the venue, with everything given back and each student told. Safe to repeat: a retry after a
 * failure cancels the seats still live. Returns the bookings this call cancelled.
 */
export async function cancelSession(deps: Deps, slotId: number, reason: string) {
  const now = deps.now()
  const slot = immediate(deps.db, (tx) => {
    const row = tx.select().from(slots).where(eq(slots.id, slotId)).get()
    if (!row) throw notFound('时段')
    if (row.lessonTypeId === null) throw new ApiError(409, 'not_group', '只有小班课可以整节取消')
    if (row.endsAt <= now) throw new ApiError(409, 'ended', '课程已结束，无法取消')
    tx.update(slots)
      .set({
        open: false,
        cancelledAt: row.cancelledAt ?? now,
        cancelReason: row.cancelReason ?? reason,
      })
      .where(eq(slots.id, row.id))
      .run()
    return row
  })
  const live = deps.db
    .select({ id: bookings.id })
    .from(bookings)
    .where(and(eq(bookings.slotId, slot.id), inArray(bookings.status, LIVE)))
    .all()
  const cancelled: number[] = []
  // One seat that fails leaves the others to go ahead; the sweeper tries it again.
  for (const b of live) {
    try {
      if (await cancelBooking(deps, b.id, 'venue', { reason: slot.cancelReason ?? reason })) {
        cancelled.push(b.id)
      }
    } catch (e) {
      deps.log('session seat cancel failed', { bookingId: b.id, error: (e as Error).message })
    }
  }
  return cancelled
}

/**
 * Finishes sessions called off while some seats could not be cancelled, say when a payment was
 * landing at that moment. Run by the sweeper until the session ends.
 */
export async function finishCancelledSessions(deps: Deps) {
  const now = deps.now()
  const open = deps.db
    .selectDistinct({ id: slots.id })
    .from(slots)
    .innerJoin(bookings, eq(bookings.slotId, slots.id))
    .where(and(isNotNull(slots.cancelledAt), gt(slots.endsAt, now), inArray(bookings.status, LIVE)))
    .all()
  for (const { id } of open) {
    try {
      await cancelSession(deps, id, UNDERFILLED_REASON)
    } catch (e) {
      deps.log('cancelled session cleanup failed', { slotId: id, error: (e as Error).message })
    }
  }
}

/**
 * Calls off sessions short of their class's minimum headcount once the free-cancel deadline
 * passes. Each session is checked once; a session that goes ahead stays on even if students
 * cancel later. Run by the sweeper.
 */
export async function cancelUnderfilledSessions(deps: Deps) {
  const now = deps.now()
  const settings = getSettings(deps.db)
  const rulesBook = ruleBook(deps.db, settings)
  // Any session that could be due: the longest check time of any class.
  const longest = Math.max(...[rulesBook.venue, ...rulesBook.all()].map(minCheckHours))
  // Checked at the class's free-cancel deadline as it is now, which is what students are shown.
  const rulesOf = (slot: typeof slots.$inferSelect) => rulesBook.of(slot.lessonTypeId)
  const due = deps.db
    .select({ slot: slots, minStudents: lessonTypes.minStudents })
    .from(slots)
    .innerJoin(lessonTypes, eq(lessonTypes.id, slots.lessonTypeId))
    .where(
      and(
        isNull(slots.minCheckedAt),
        isNull(slots.cancelledAt),
        isNotNull(lessonTypes.minStudents),
        gt(slots.startsAt, now),
        lt(slots.startsAt, new Date(now.getTime() + (longest + 1) * 3_600_000)),
      ),
    )
    .all()
    .filter((r) => minCheckDue(r.slot, now, rulesOf(r.slot)))
  for (const { slot, minStudents } of due) {
    const rules = rulesOf(slot)
    // A session never needs more students than it holds, should the class's minimum rise later.
    const least = Math.min(minStudents ?? 0, slot.capacity)
    try {
      const verdict = immediate(deps.db, (tx) => {
        const fresh = tx
          .select({ minCheckedAt: slots.minCheckedAt })
          .from(slots)
          .where(eq(slots.id, slot.id))
          .get()
        if (!fresh || fresh.minCheckedAt) return 'done'
        const seats = tx
          .select({ status: bookings.status, expiresAt: orders.expiresAt })
          .from(bookings)
          .leftJoin(orders, eq(orders.bookingId, bookings.id))
          .where(and(eq(bookings.slotId, slot.id), inArray(bookings.status, LIVE)))
          .all()
        const paid = seats.filter((b) => b.status === 'confirmed').length
        // Students who were paying at the check time could still make up the number, so their
        // holds are waited out. Holds taken later are not, or a stream of them could put the
        // check off until the class starts.
        const checkAt = slot.startsAt.getTime() - minCheckHours(rules) * 3_600_000
        const holdEnd = checkAt + settings.payment.timeoutMinutes * 60_000
        const paying = seats.filter(
          (b) => b.status === 'pending_payment' && b.expiresAt && b.expiresAt.getTime() <= holdEnd,
        ).length
        if (paid < least && paid + paying >= least) return 'wait'
        // Marked first: whatever happens next, the session is never checked twice.
        tx.update(slots).set({ minCheckedAt: now }).where(eq(slots.id, slot.id)).run()
        return paid < least ? 'cancel' : 'done'
      })
      if (verdict === 'cancel') await cancelSession(deps, slot.id, UNDERFILLED_REASON)
    } catch (e) {
      deps.log('underfilled session cancel failed', {
        slotId: slot.id,
        error: (e as Error).message,
      })
    }
  }
}
