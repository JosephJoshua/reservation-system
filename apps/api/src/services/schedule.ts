// 排班: each coach's weekly hours and dated exceptions, the start times they leave for private
// lessons, and the lesson rows a booking at one of those times lands in.
import {
  addVenueDays,
  clashes,
  type DayPlanDto,
  endsSameVenueDay,
  exceptionError,
  freeStarts,
  type HoursPeriod,
  hoursOn,
  isGroup,
  SCHEDULE_STEP,
  type ScheduleConflictDto,
  type ScheduleException,
  type ScheduleExceptionDto,
  type ScheduleViewDto,
  type Span,
  venueDateKey,
  venueInstant,
  type WeeklyHours,
  weeklyHoursError,
  withinSpans,
  workingSpans,
} from '@rs/shared'
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lt, min, ne, or } from 'drizzle-orm'
import { immediate, type Q } from '../db/client'
import {
  bookings,
  coachCategories,
  coaches,
  coachHours,
  coachLessonTypes,
  lessonTypes,
  scheduleExceptions,
  slots,
  staff,
  students,
} from '../db/schema'
import type { Deps } from '../deps'
import { ApiError, notFound } from '../errors'
import { DELETED_NAME } from './account'
import { LIVE } from './bookings'
import { getSettings, ruleBook, taughtBy } from './settings'
import { spansWithoutTable, tablesInUse } from './tables'

const MINUTE = 60_000

type SlotRow = typeof slots.$inferSelect

/** A private lesson time on offer. */
export interface OpenTime extends Span {
  coachId: number
  /** No table is free for the whole of it. */
  tableFull: boolean
}

// Reading 排班

/** Each coach's weekly hours as periods: a period starts wherever a row starts or ends. */
export function hoursPeriods(tx: Q, coachIds: readonly number[]): Map<number, HoursPeriod[]> {
  const out = new Map<number, HoursPeriod[]>()
  if (!coachIds.length) return out
  const rows = tx
    .select()
    .from(coachHours)
    .where(inArray(coachHours.coachId, [...new Set(coachIds)]))
    .orderBy(asc(coachHours.weekday), asc(coachHours.startMinute))
    .all()
  for (const id of new Set(coachIds)) {
    const mine = rows.filter((r) => r.coachId === id)
    const bounds = [
      ...new Set(mine.flatMap((r) => (r.toDate ? [r.fromDate, r.toDate] : [r.fromDate]))),
    ].sort()
    out.set(
      id,
      bounds.map((from) => ({
        from,
        hours: mine
          .filter((r) => r.fromDate <= from && (r.toDate === null || r.toDate > from))
          .map(({ weekday, startMinute, endMinute }) => ({ weekday, startMinute, endMinute })),
      })),
    )
  }
  return out
}

/** 请假, 加班 and 闭馆 touching a span of time, per coach; 闭馆 is given to every coach asked for. */
export function exceptionsFor(
  tx: Q,
  coachIds: readonly number[],
  span: Span,
): Map<number, (typeof scheduleExceptions.$inferSelect)[]> {
  const rows = tx
    .select()
    .from(scheduleExceptions)
    .where(
      and(
        or(
          isNull(scheduleExceptions.coachId),
          coachIds.length ? inArray(scheduleExceptions.coachId, [...coachIds]) : undefined,
        ),
        lt(scheduleExceptions.startsAt, span.endsAt),
        gt(scheduleExceptions.endsAt, span.startsAt),
      ),
    )
    .orderBy(asc(scheduleExceptions.startsAt))
    .all()
  const closures = rows.filter((r) => r.coachId === null)
  return new Map(coachIds.map((id) => [id, [...rows.filter((r) => r.coachId === id), ...closures]]))
}

/** The span from the start of the first venue date to the end of the last. */
function datesSpan(dates: readonly string[]): Span {
  const sorted = [...dates].sort()
  return {
    startsAt: venueInstant(sorted[0] as string, 0),
    endsAt: venueInstant(addVenueDays(sorted[sorted.length - 1] as string, 1), 0),
  }
}

/** Each coach's working time on each date: weekly hours with 加班, less 请假 and 闭馆. */
export function workingTime(
  tx: Q,
  coachIds: readonly number[],
  dates: readonly string[],
): Map<number, Map<string, Span[]>> {
  const out = new Map<number, Map<string, Span[]>>()
  if (!coachIds.length || !dates.length) return out
  const periods = hoursPeriods(tx, coachIds)
  const exceptions = exceptionsFor(tx, coachIds, datesSpan(dates))
  for (const id of coachIds) {
    const byDate = new Map<string, Span[]>()
    for (const date of dates) {
      byDate.set(
        date,
        workingSpans(
          periods.get(id) ?? [],
          (exceptions.get(id) ?? []) as ScheduleException[],
          date,
        ),
      )
    }
    out.set(id, byDate)
  }
  return out
}

/**
 * The time each coach is already taken: private lessons with a live booking and group sessions
 * that are not called off. `except` is a booking being moved, whose time is free to it.
 */
export function busyTime(
  tx: Q,
  coachIds: readonly number[],
  span: Span,
  except?: number,
): Map<number, Span[]> {
  const out = new Map<number, Span[]>(coachIds.map((id) => [id, []]))
  if (!coachIds.length) return out
  const lessons = tx
    .select({ coachId: slots.coachId, startsAt: bookings.startsAt, endsAt: bookings.endsAt })
    .from(bookings)
    .innerJoin(slots, eq(slots.id, bookings.slotId))
    .where(
      and(
        inArray(slots.coachId, [...coachIds]),
        isNull(slots.lessonTypeId),
        inArray(bookings.status, LIVE),
        lt(bookings.startsAt, span.endsAt),
        gt(bookings.endsAt, span.startsAt),
        except === undefined ? undefined : ne(bookings.id, except),
      ),
    )
    .all()
  const sessions = tx
    .select({ coachId: slots.coachId, startsAt: slots.startsAt, endsAt: slots.endsAt })
    .from(slots)
    .where(
      and(
        inArray(slots.coachId, [...coachIds]),
        isNotNull(slots.lessonTypeId),
        isNull(slots.cancelledAt),
        lt(slots.startsAt, span.endsAt),
        gt(slots.endsAt, span.startsAt),
      ),
    )
    .all()
  for (const b of [...lessons, ...sessions]) out.get(b.coachId)?.push(b)
  return out
}

/**
 * Start times on these dates at which each coach can take a private lesson of `minutes`, with
 * whether a table is free. `except` is a booking being moved; `notBefore` hides earlier starts.
 */
export function openTimes(
  tx: Q,
  q: {
    coachIds: readonly number[]
    dates: readonly string[]
    minutes: number
    notBefore: Date
    except?: number
  },
): OpenTime[] {
  if (!q.coachIds.length || !q.dates.length) return []
  const { startGrid, bufferMinutes } = getSettings(tx).booking
  const working = workingTime(tx, q.coachIds, q.dates)
  const busy = busyTime(tx, q.coachIds, datesSpan(q.dates), q.except)
  const times: Omit<OpenTime, 'tableFull'>[] = []
  for (const coachId of q.coachIds) {
    // By the venue date they start on: a day only needs its own lessons and its neighbours'
    // (lessons are shorter than a day, and the buffer reaches over midnight at most).
    const byDate = new Map<string, Span[]>()
    for (const b of busy.get(coachId) ?? []) {
      const key = venueDateKey(b.startsAt)
      byDate.set(key, [...(byDate.get(key) ?? []), b])
    }
    for (const date of q.dates) {
      for (const span of freeStarts({
        working: working.get(coachId)?.get(date) ?? [],
        busy: [addVenueDays(date, -1), date, addVenueDays(date, 1)].flatMap(
          (d) => byDate.get(d) ?? [],
        ),
        minutes: q.minutes,
        grid: startGrid,
        buffer: bufferMinutes,
        notBefore: q.notBefore,
      })) {
        times.push({ coachId, ...span })
      }
    }
  }
  const full = spansWithoutTable(tx, times, q.except)
  return times
    .map((t, i) => ({ ...t, tableFull: full[i] ?? false }))
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.coachId - b.coachId)
}

// Booking a private lesson time

/** Who is asking for a time: a student or coach keeps to 排班; the venue may go outside it. */
export type TimeRule = 'schedule' | 'anytime'

/**
 * Refuses a private lesson time the coach cannot take. Under `schedule` it must be one of the
 * start times 排班 offers; `anytime` (the front desk, after a confirm) only needs the coach free
 * and the time on the 5-minute step. Tables and the booking window are checked by the caller.
 */
export function assertPrivateTime(
  tx: Q,
  q: { coachId: number; span: Span; rule: TimeRule; except?: number },
) {
  const { coachId, span, rule } = q
  const step = SCHEDULE_STEP * MINUTE
  if (span.startsAt.getTime() % step || span.endsAt.getTime() % step) {
    throw new ApiError(400, 'invalid_time', `时间需为 ${SCHEDULE_STEP} 分钟的整数倍`)
  }
  if (!endsSameVenueDay(span.startsAt, span.endsAt)) {
    throw new ApiError(409, 'crosses_midnight', '课程不能跨到第二天')
  }
  const date = venueDateKey(span.startsAt)
  const busy = busyTime(tx, [coachId], datesSpan([date]), q.except).get(coachId) ?? []
  if (rule === 'anytime') {
    if (busy.some((b) => clashes(span, b))) {
      throw new ApiError(409, 'coach_busy', '该教练在这个时间已有课')
    }
    // Outside 排班 is time the coach agreed to, never their 请假 or a 闭馆.
    assertNotOff(tx, coachId, span)
    return
  }
  const { startGrid, bufferMinutes } = getSettings(tx).booking
  const offered = freeStarts({
    working: workingTime(tx, [coachId], [date]).get(coachId)?.get(date) ?? [],
    busy,
    minutes: (span.endsAt.getTime() - span.startsAt.getTime()) / MINUTE,
    grid: startGrid,
    buffer: bufferMinutes,
  }).some((s) => s.startsAt.getTime() === span.startsAt.getTime())
  if (offered) return
  if (busy.some((b) => clashes(span, b, bufferMinutes))) throw timeTaken()
  throw new ApiError(409, 'time_unavailable', '该时间不可预约')
}

/** Refuses a lesson that runs into the coach's 请假 or a 闭馆, naming the 闭馆 first. */
function assertNotOff(tx: Q, coachId: number, span: Span) {
  const off = (exceptionsFor(tx, [coachId], span).get(coachId) ?? []).filter(
    (e) => e.kind === 'off',
  )
  if (off.some((e) => e.coachId === null)) {
    throw new ApiError(409, 'venue_closed', '这个时间闭馆')
  }
  if (off.length) throw new ApiError(409, 'coach_off', '该教练这个时间请假')
}

export const timeTaken = () => new ApiError(409, 'slot_taken', '该时段已被预约')

/**
 * The lesson row for a private lesson at this time: one left free by an earlier cancel, or a new
 * one. Call it after assertPrivateTime, in the same IMMEDIATE transaction.
 */
export function privateSlot(tx: Q, coachId: number, span: Span): SlotRow {
  const free = tx
    .select()
    .from(slots)
    .where(
      and(
        eq(slots.coachId, coachId),
        isNull(slots.lessonTypeId),
        eq(slots.startsAt, span.startsAt),
        eq(slots.endsAt, span.endsAt),
      ),
    )
    .all()
    .find(
      (s) =>
        !tx
          .select({ id: bookings.id })
          .from(bookings)
          .where(and(eq(bookings.slotId, s.id), inArray(bookings.status, LIVE)))
          .get(),
    )
  return (
    free ??
    tx
      .insert(slots)
      .values({ coachId, ...span })
      .returning()
      .get()
  )
}

/** Where a booking or move goes: a group session, or a coach and start time for a private lesson. */
export type SlotTarget = { slotId: number } | { coachId: number; startsAt: Date }

/**
 * The slot a booking or move lands in. A session is looked up as it is. A private lesson time is
 * checked against 排班 under `rule` and given its lesson row; a private slot id stands for its
 * coach and time, so a time once booked can be booked again by id. `minutes` is the lesson's
 * length. Call it inside the IMMEDIATE transaction that books.
 */
export function targetSlot(
  tx: Q,
  target: SlotTarget,
  q: { minutes: number; lessonType: { capacity: number }; rule: TimeRule; except?: number },
): SlotRow {
  let coachId: number
  let startsAt: Date
  if ('slotId' in target) {
    const slot = tx.select().from(slots).where(eq(slots.id, target.slotId)).get()
    if (!slot) throw new ApiError(404, 'slot_not_found', '时段不存在')
    if (slot.lessonTypeId !== null) {
      // A session that a later 请假 or 闭馆 covers takes no one new.
      assertNotOff(tx, slot.coachId, slot)
      return slot
    }
    coachId = slot.coachId
    startsAt = slot.startsAt
  } else {
    coachId = target.coachId
    startsAt = target.startsAt
  }
  // A group class is booked in its sessions only.
  if (isGroup(q.lessonType)) {
    throw new ApiError(409, 'lesson_type_mismatch', '该时段不能预约这门课')
  }
  const coach = tx
    .select({ active: coaches.active })
    .from(coaches)
    .where(eq(coaches.id, coachId))
    .get()
  if (!coach) throw notFound('教练')
  if (!coach.active) throw new ApiError(409, 'coach_not_teaching', '该教练暂不可预约')
  const span = { startsAt, endsAt: new Date(startsAt.getTime() + q.minutes * MINUTE) }
  assertPrivateTime(tx, { coachId, span, rule: q.rule, except: q.except })
  return privateSlot(tx, coachId, span)
}

// Editing 排班

function assertCoach(tx: Q, coachId: number) {
  if (!tx.select({ id: coaches.id }).from(coaches).where(eq(coaches.id, coachId)).get()) {
    throw notFound('教练')
  }
}

/** Refuses a coach's own edit when the venue keeps 排班 to staff. */
export function assertCoachMayEdit(tx: Q) {
  if (!getSettings(tx).booking.coachEditsHours) {
    throw new ApiError(403, 'schedule_locked', '排班由场馆设置，请联系前台')
  }
}

function exceptionDto(
  e: typeof scheduleExceptions.$inferSelect,
  staffNames: Map<number, string>,
): ScheduleExceptionDto {
  return {
    id: e.id,
    coachId: e.coachId,
    kind: e.kind,
    startsAt: e.startsAt.toISOString(),
    endsAt: e.endsAt.toISOString(),
    note: e.note,
    byStaff: e.byStaffId === null ? null : (staffNames.get(e.byStaffId) ?? ''),
  }
}

function staffNames(tx: Q, ids: (number | null)[]) {
  const wanted = [...new Set(ids.filter((id): id is number => id !== null))]
  if (!wanted.length) return new Map<number, string>()
  return new Map(
    tx
      .select({ id: staff.id, name: staff.name })
      .from(staff)
      .where(inArray(staff.id, wanted))
      .all()
      .map((s) => [s.id, s.name]),
  )
}

/** Upcoming 闭馆, for the settings page and every 排班 view. */
export function upcomingClosures(tx: Q, now: Date): ScheduleExceptionDto[] {
  const rows = tx
    .select()
    .from(scheduleExceptions)
    .where(and(isNull(scheduleExceptions.coachId), gt(scheduleExceptions.endsAt, now)))
    .orderBy(asc(scheduleExceptions.startsAt))
    .all()
  const names = staffNames(
    tx,
    rows.map((r) => r.byStaffId),
  )
  return rows.map((r) => exceptionDto(r, names))
}

/** The coach's shortest active private lesson in minutes, or null when they teach none. */
export function shortestLesson(tx: Q, coachId: number): number | null {
  const row = tx
    .select({ minutes: min(lessonTypes.durationMinutes) })
    .from(coachLessonTypes)
    .innerJoin(lessonTypes, eq(lessonTypes.id, coachLessonTypes.lessonTypeId))
    .where(
      and(
        eq(coachLessonTypes.coachId, coachId),
        eq(lessonTypes.active, true),
        eq(lessonTypes.capacity, 1),
      ),
    )
    .get()
  return row?.minutes ?? null
}

/** A coach's 排班 from today on, for the editors in the admin app and the mini program. */
export function scheduleView(tx: Q, now: Date, coachId: number): ScheduleViewDto {
  assertCoach(tx, coachId)
  const today = venueDateKey(now)
  const periods = hoursPeriods(tx, [coachId]).get(coachId) ?? []
  const fromToday: HoursPeriod[] = [
    { from: today, hours: hoursOn(periods, today) },
    ...periods.filter((p) => p.from > today),
  ]
  const rows = tx
    .select()
    .from(scheduleExceptions)
    .where(and(eq(scheduleExceptions.coachId, coachId), gt(scheduleExceptions.endsAt, now)))
    .orderBy(asc(scheduleExceptions.startsAt))
    .all()
  const names = staffNames(
    tx,
    rows.map((r) => r.byStaffId),
  )
  const settings = getSettings(tx)
  return {
    periods: fromToday,
    exceptions: rows.map((r) => exceptionDto(r, names)),
    closures: upcomingClosures(tx, now),
    coachEdits: settings.booking.coachEditsHours,
    // The days any of the coach's own lessons can be booked on.
    advanceDays: ruleBook(tx, settings).longestAdvanceDays(taughtBy(tx, coachId)),
    lessonMinutes: shortestLesson(tx, coachId),
  }
}

/**
 * Replaces a coach's weekly hours from a venue date on: rows that started earlier end there, and
 * any planned from that date or later are dropped. Booked lessons are never touched; the result
 * lists the ones now outside 排班.
 */
export function saveHours(
  deps: Deps,
  coachId: number,
  input: { from: string; hours: WeeklyHours[] },
): ScheduleConflictDto[] {
  const now = deps.now()
  const today = venueDateKey(now)
  try {
    venueInstant(input.from, 0)
  } catch {
    throw new ApiError(400, 'invalid_date', '日期无效')
  }
  if (input.from < today) throw new ApiError(400, 'invalid_date', '生效日期不能早于今天')
  if (input.from > addVenueDays(today, 366)) {
    throw new ApiError(400, 'invalid_date', '生效日期需在一年内')
  }
  const error = weeklyHoursError(input.hours)
  if (error) throw new ApiError(400, 'invalid_hours', error)
  return immediate(deps.db, (tx) => {
    assertCoach(tx, coachId)
    tx.delete(coachHours)
      .where(and(eq(coachHours.coachId, coachId), gte(coachHours.fromDate, input.from)))
      .run()
    tx.update(coachHours)
      .set({ toDate: input.from })
      .where(
        and(
          eq(coachHours.coachId, coachId),
          or(isNull(coachHours.toDate), gt(coachHours.toDate, input.from)),
        ),
      )
      .run()
    for (const h of input.hours) {
      tx.insert(coachHours)
        .values({ coachId, ...h, fromDate: input.from })
        .run()
    }
    return outsideSchedule(tx, now, coachId)
  })
}

/** Adds a 请假 or 加班 for a coach, or a 闭馆 when coachId is null. */
export function addException(
  deps: Deps,
  input: {
    coachId: number | null
    kind: 'off' | 'extra'
    startsAt: Date
    endsAt: Date
    note: string
  },
  byStaffId: number | null,
): { id: number; conflicts: ScheduleConflictDto[] } {
  const now = deps.now()
  if (input.coachId === null && input.kind !== 'off') {
    throw new ApiError(400, 'invalid_body', '闭馆只能是休息')
  }
  const error = exceptionError(input, now)
  if (error) throw new ApiError(400, 'invalid_time', error)
  return immediate(deps.db, (tx) => {
    if (input.coachId !== null) assertCoach(tx, input.coachId)
    // A repeat of the same request adds nothing.
    const same = tx
      .select({ id: scheduleExceptions.id })
      .from(scheduleExceptions)
      .where(
        and(
          input.coachId === null
            ? isNull(scheduleExceptions.coachId)
            : eq(scheduleExceptions.coachId, input.coachId),
          eq(scheduleExceptions.kind, input.kind),
          eq(scheduleExceptions.startsAt, input.startsAt),
          eq(scheduleExceptions.endsAt, input.endsAt),
        ),
      )
      .get()
    const id =
      same?.id ??
      tx
        .insert(scheduleExceptions)
        .values({ ...input, byStaffId, createdAt: now })
        .returning({ id: scheduleExceptions.id })
        .get().id
    return { id, conflicts: input.kind === 'off' ? leaveConflicts(tx, now, input.coachId) : [] }
  })
}

/**
 * Removes a 请假, 加班 or 闭馆 that has not ended. One under way is cut short at now, so the part
 * already past stays on record. `coachId` limits it to that coach's own, or to 闭馆 when null; returns what was removed,
 * or null when it was already gone.
 */
export function removeException(deps: Deps, id: number, coachId?: number | null) {
  const now = deps.now()
  return immediate(deps.db, (tx) => {
    const row = tx.select().from(scheduleExceptions).where(eq(scheduleExceptions.id, id)).get()
    if (!row || (coachId !== undefined && row.coachId !== coachId)) return null
    if (row.endsAt <= now) throw new ApiError(409, 'ended', '已过去的不能删除')
    if (row.startsAt < now) {
      // Cut to the 5-minute step, which keeps it a valid exception.
      const step = SCHEDULE_STEP * MINUTE
      const end = new Date(Math.ceil(now.getTime() / step) * step)
      tx.update(scheduleExceptions).set({ endsAt: end }).where(eq(scheduleExceptions.id, id)).run()
    } else {
      tx.delete(scheduleExceptions).where(eq(scheduleExceptions.id, id)).run()
    }
    return row
  })
}

// Lessons that need sorting out

interface FutureLesson {
  slotId: number
  bookingId: number | null
  coachId: number
  startsAt: Date
  endsAt: Date
  title: string
  group: boolean
}

/** Booked private lessons and sessions not called off that have not started, for some coaches. */
function futureLessons(tx: Q, now: Date, coachId: number | null): FutureLesson[] {
  const byCoach = coachId === null ? undefined : eq(slots.coachId, coachId)
  const lessons = tx
    .select({
      slotId: slots.id,
      bookingId: bookings.id,
      coachId: slots.coachId,
      startsAt: bookings.startsAt,
      endsAt: bookings.endsAt,
      name: students.name,
      deletedAt: students.deletedAt,
    })
    .from(bookings)
    .innerJoin(slots, eq(slots.id, bookings.slotId))
    .innerJoin(students, eq(students.id, bookings.studentId))
    .where(
      and(
        byCoach,
        isNull(slots.lessonTypeId),
        inArray(bookings.status, LIVE),
        gt(bookings.startsAt, now),
      ),
    )
    .all()
  const sessions = tx
    .select({
      slotId: slots.id,
      coachId: slots.coachId,
      startsAt: slots.startsAt,
      endsAt: slots.endsAt,
      name: lessonTypes.name,
    })
    .from(slots)
    .innerJoin(lessonTypes, eq(lessonTypes.id, slots.lessonTypeId))
    .where(and(byCoach, isNull(slots.cancelledAt), gt(slots.startsAt, now)))
    .all()
  return [
    ...lessons.map((l) => ({
      slotId: l.slotId,
      bookingId: l.bookingId,
      coachId: l.coachId,
      startsAt: l.startsAt,
      endsAt: l.endsAt,
      title: l.deletedAt ? DELETED_NAME : l.name || '未填写姓名',
      group: false,
    })),
    ...sessions.map((s) => ({ ...s, bookingId: null, title: s.name, group: true })),
  ].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
}

function conflictDtos(tx: Q, lessons: FutureLesson[]): ScheduleConflictDto[] {
  const names = new Map(
    lessons.length
      ? tx
          .select({ id: coaches.id, name: coaches.name })
          .from(coaches)
          .where(inArray(coaches.id, [...new Set(lessons.map((l) => l.coachId))]))
          .all()
          .map((c) => [c.id, c.name])
      : [],
  )
  return lessons.map((l) => ({
    slotId: l.slotId,
    bookingId: l.bookingId,
    coachId: l.coachId,
    coachName: names.get(l.coachId) ?? '',
    startsAt: l.startsAt.toISOString(),
    endsAt: l.endsAt.toISOString(),
    title: l.title,
    group: l.group,
  }))
}

/**
 * Lessons and sessions yet to start that fall in their coach's 请假 or in 闭馆: the venue moves or
 * cancels them. Null coachId looks at every coach.
 */
export function leaveConflicts(tx: Q, now: Date, coachId: number | null): ScheduleConflictDto[] {
  const lessons = futureLessons(tx, now, coachId)
  if (!lessons.length) return []
  const last = new Date(Math.max(...lessons.map((l) => l.endsAt.getTime())))
  const offs = tx
    .select()
    .from(scheduleExceptions)
    .where(
      and(
        eq(scheduleExceptions.kind, 'off'),
        gt(scheduleExceptions.endsAt, now),
        lt(scheduleExceptions.startsAt, last),
      ),
    )
    .all()
  return conflictDtos(
    tx,
    lessons.filter((l) =>
      offs.some((o) => (o.coachId === null || o.coachId === l.coachId) && clashes(l, o)),
    ),
  )
}

/** A coach's private lessons yet to start that are no longer inside their 排班. */
function outsideSchedule(tx: Q, now: Date, coachId: number): ScheduleConflictDto[] {
  const lessons = futureLessons(tx, now, coachId).filter((l) => !l.group)
  if (!lessons.length) return []
  const dates = [...new Set(lessons.map((l) => venueDateKey(l.startsAt)))]
  const working = workingTime(tx, [coachId], dates).get(coachId)
  return conflictDtos(
    tx,
    lessons.filter((l) => !withinSpans(l, working?.get(venueDateKey(l.startsAt)) ?? [])),
  )
}

/** A day for the admin 日程 board: who works when, 请假 and 闭馆, and tables in use. */
export function dayPlan(tx: Q, date: string): DayPlanDto {
  const span = datesSpan([date])
  const withLessons = new Set(
    tx
      .select({ coachId: slots.coachId })
      .from(slots)
      .leftJoin(bookings, and(eq(bookings.slotId, slots.id), inArray(bookings.status, LIVE)))
      .where(
        and(
          gte(slots.startsAt, span.startsAt),
          lt(slots.startsAt, span.endsAt),
          or(isNotNull(slots.lessonTypeId), isNotNull(bookings.id)),
        ),
      )
      .all()
      .map((r) => r.coachId),
  )
  const rows = tx
    .select({
      id: coaches.id,
      name: coaches.name,
      active: coaches.active,
      categoryName: coachCategories.name,
    })
    .from(coaches)
    .leftJoin(coachCategories, eq(coachCategories.id, coaches.categoryId))
    .orderBy(asc(coaches.sort), asc(coaches.id))
    .all()
    .filter((c) => c.active || withLessons.has(c.id))
  const ids = rows.map((r) => r.id)
  const working = workingTime(tx, ids, [date])
  const exceptions = exceptionsFor(tx, ids, span)
  const names = staffNames(
    tx,
    [...exceptions.values()].flat().map((e) => e.byStaffId),
  )
  const { tables } = getSettings(tx).booking
  const iso = (s: Span) => ({ startsAt: s.startsAt.toISOString(), endsAt: s.endsAt.toISOString() })
  return {
    date,
    coaches: rows.map((c) => ({
      ...c,
      working: (working.get(c.id)?.get(date) ?? []).map(iso),
      off: (exceptions.get(c.id) ?? [])
        .filter((e) => e.kind === 'off')
        .map((e) => exceptionDto(e, names)),
    })),
    tables,
    tableUse: tablesInUse(tx, span),
  }
}
