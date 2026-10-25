// 排班: when each coach takes private lessons, and the start times that leaves for booking.
// Weekly hours plus dated exceptions make the coach's working time; bookable start times are
// worked out from it whenever someone looks, never stored.
import { endsSameVenueDay } from './rules'
import { addVenueDays, venueDateKey, venueInstant, venueParts } from './time'

const MINUTE = 60_000
const DAY_MINUTES = 24 * 60

export interface Span {
  startsAt: Date
  endsAt: Date
}

/** A weekly window a coach takes lessons in. */
export interface WeeklyHours {
  /** 0 is Sunday. */
  weekday: number
  /** Minutes after venue midnight. */
  startMinute: number
  endMinute: number
}

/**
 * A dated change to the weekly hours: `off` (请假, or 闭馆 for the whole venue) takes time out,
 * `extra` (加班) adds time the weekly hours do not have.
 */
export type ExceptionKind = 'off' | 'extra'

export interface ScheduleException extends Span {
  kind: ExceptionKind
}

/** Weekly hours that apply from a venue date on, until the next period starts. */
export interface HoursPeriod {
  from: string
  hours: WeeklyHours[]
}

/** How far apart offered start times are, in minutes. */
export const START_GRIDS = [15, 30, 60] as const
export type StartGrid = (typeof START_GRIDS)[number]

/** Times in 排班 are whole multiples of this many minutes. */
export const SCHEDULE_STEP = 5

/** The longest single 请假 or 闭馆, in days. */
export const MAX_OFF_DAYS = 366

/** Why a set of weekly hours cannot be saved, or null. */
export function weeklyHoursError(hours: WeeklyHours[]): string | null {
  for (const h of hours) {
    if (!Number.isInteger(h.weekday) || h.weekday < 0 || h.weekday > 6) return '星期无效'
    if (
      !Number.isInteger(h.startMinute) ||
      !Number.isInteger(h.endMinute) ||
      h.startMinute < 0 ||
      h.endMinute > DAY_MINUTES
    ) {
      return '时间无效'
    }
    if (h.startMinute % SCHEDULE_STEP || h.endMinute % SCHEDULE_STEP) {
      return `时间需为 ${SCHEDULE_STEP} 分钟的整数倍`
    }
    if (h.startMinute >= h.endMinute) return '结束时间需晚于开始时间'
  }
  for (let i = 0; i < hours.length; i++) {
    for (let j = i + 1; j < hours.length; j++) {
      const a = hours[i] as WeeklyHours
      const b = hours[j] as WeeklyHours
      if (a.weekday === b.weekday && a.startMinute < b.endMinute && b.startMinute < a.endMinute) {
        return '同一天的时间段不能重叠'
      }
    }
  }
  return null
}

/** Why a 请假 or 加班 cannot be saved, or null. */
export function exceptionError(e: ScheduleException, now: Date): string | null {
  const start = e.startsAt.getTime()
  const end = e.endsAt.getTime()
  if (Number.isNaN(start) || Number.isNaN(end)) return '时间无效'
  if (start % (SCHEDULE_STEP * MINUTE) || end % (SCHEDULE_STEP * MINUTE)) {
    return `时间需为 ${SCHEDULE_STEP} 分钟的整数倍`
  }
  if (end <= start) return '结束时间需晚于开始时间'
  if (end <= now.getTime()) return '不能设置已过去的时间'
  if (start - now.getTime() > MAX_OFF_DAYS * DAY_MINUTES * MINUTE) return '只能设置一年内的时间'
  if (e.kind === 'off' && end - start > MAX_OFF_DAYS * DAY_MINUTES * MINUTE) {
    return '请假最长一年'
  }
  if (e.kind === 'extra' && !endsSameVenueDay(e.startsAt, e.endsAt)) return '加班不能跨到第二天'
  return null
}

/** The weekly hours in effect on a venue date. */
export function hoursOn(periods: readonly HoursPeriod[], date: string): WeeklyHours[] {
  let found: WeeklyHours[] = []
  for (const p of periods) if (p.from <= date) found = p.hours
  return found
}

/** Spans sorted by start, with touching or overlapping ones joined. */
export function mergeSpans(spans: readonly Span[]): Span[] {
  const sorted = [...spans]
    .filter((s) => s.endsAt > s.startsAt)
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
  const out: Span[] = []
  for (const s of sorted) {
    const last = out[out.length - 1]
    if (last && s.startsAt <= last.endsAt) {
      if (s.endsAt > last.endsAt) last.endsAt = s.endsAt
    } else {
      out.push({ startsAt: s.startsAt, endsAt: s.endsAt })
    }
  }
  return out
}

/** `spans` with every moment in `cuts` taken out. */
export function subtractSpans(spans: readonly Span[], cuts: readonly Span[]): Span[] {
  let out = mergeSpans(spans)
  for (const c of mergeSpans(cuts)) {
    out = out.flatMap((s) => {
      if (c.endsAt <= s.startsAt || c.startsAt >= s.endsAt) return [s]
      const parts: Span[] = []
      if (c.startsAt > s.startsAt) parts.push({ startsAt: s.startsAt, endsAt: c.startsAt })
      if (c.endsAt < s.endsAt) parts.push({ startsAt: c.endsAt, endsAt: s.endsAt })
      return parts
    })
  }
  return out
}

/**
 * A coach's working time on one venue date: the weekly hours in effect that day plus 加班, less
 * 请假 and 闭馆 (both `off`). Exceptions may be passed for any dates; only this date's part counts.
 */
export function workingSpans(
  periods: readonly HoursPeriod[],
  exceptions: readonly ScheduleException[],
  date: string,
): Span[] {
  const dayStart = venueInstant(date, 0)
  const dayEnd = venueInstant(addVenueDays(date, 1), 0)
  const weekday = venueParts(venueInstant(date, 12 * 60)).weekday
  const weekly = hoursOn(periods, date)
    .filter((h) => h.weekday === weekday)
    .map((h) => ({
      startsAt: venueInstant(date, h.startMinute),
      endsAt: venueInstant(date, h.endMinute),
    }))
  const clip = (s: Span): Span => ({
    startsAt: new Date(Math.max(s.startsAt.getTime(), dayStart.getTime())),
    endsAt: new Date(Math.min(s.endsAt.getTime(), dayEnd.getTime())),
  })
  const today = exceptions
    .filter((e) => e.startsAt < dayEnd && e.endsAt > dayStart)
    .map((e) => ({
      kind: e.kind,
      ...clip(e),
    }))
  return subtractSpans(
    [...weekly, ...today.filter((e) => e.kind === 'extra')],
    today.filter((e) => e.kind === 'off'),
  )
}

/** Whether a span lies wholly inside one of the working spans. */
export function withinSpans(span: Span, working: readonly Span[]): boolean {
  return mergeSpans(working).some((w) => w.startsAt <= span.startsAt && w.endsAt >= span.endsAt)
}

/** Whether two spans share a moment, once `gap` minutes are kept clear around `b`. */
export function clashes(a: Span, b: Span, gap = 0): boolean {
  const g = gap * MINUTE
  return (
    a.startsAt.getTime() < b.endsAt.getTime() + g && a.endsAt.getTime() + g > b.startsAt.getTime()
  )
}

export interface FreeStartsInput {
  /** The coach's working time, as from `workingSpans`. */
  working: readonly Span[]
  /** Lessons and group sessions the coach already has. */
  busy: readonly Span[]
  /** The lesson's length. */
  minutes: number
  grid: StartGrid
  /** Minutes kept free between two lessons. */
  buffer: number
  /** The earliest start offered. */
  notBefore?: Date
}

/**
 * The start times a lesson of `minutes` can be booked at. Starts fall on the venue's grid (every
 * 30 minutes from midnight, say), and also at the start of a working span and right after a lesson
 * (plus the buffer), so the coach's day packs without gaps when lesson lengths differ. The whole
 * lesson must fit in one working span and keep the buffer clear of every other lesson.
 */
export function freeStarts(input: FreeStartsInput): Span[] {
  const { minutes, grid, buffer } = input
  const length = minutes * MINUTE
  const notBefore = input.notBefore?.getTime() ?? Number.NEGATIVE_INFINITY
  const busy = mergeSpans(input.busy)
  const out = new Map<number, Span>()
  for (const w of mergeSpans(input.working)) {
    const from = w.startsAt.getTime()
    const lastStart = w.endsAt.getTime() - length
    if (lastStart < from) continue
    const starts = new Set<number>([from])
    // The first grid line at or after the span starts, on the venue's clock.
    const offset = venueParts(w.startsAt).hours * 60 + venueParts(w.startsAt).minutes
    const toGrid = (grid - (offset % grid)) % grid
    for (let t = from + toGrid * MINUTE; t <= lastStart; t += grid * MINUTE) starts.add(t)
    for (const b of busy) {
      const t = b.endsAt.getTime() + buffer * MINUTE
      if (t >= from && t <= lastStart) starts.add(t)
    }
    for (const t of starts) {
      if (t < notBefore || t > lastStart) continue
      const span = { startsAt: new Date(t), endsAt: new Date(t + length) }
      if (busy.some((b) => clashes(span, b, buffer))) continue
      out.set(t, span)
    }
  }
  return [...out.values()].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
}

/** Total minutes in a set of spans, counting overlaps once. */
export function spanMinutes(spans: readonly Span[]): number {
  return mergeSpans(spans).reduce(
    (sum, s) => sum + (s.endsAt.getTime() - s.startsAt.getTime()) / MINUTE,
    0,
  )
}

/** Venue dates from `from` through `days` days later, inclusive. */
export function venueDates(from: Date, days: number): string[] {
  const first = venueDateKey(from)
  return Array.from({ length: days + 1 }, (_, i) => addVenueDays(first, i))
}

// Response shapes

/** A 请假, 加班 or 闭馆 (coachId null) as the API sends it. */
export interface ScheduleExceptionDto {
  id: number
  coachId: number | null
  kind: ExceptionKind
  startsAt: string
  endsAt: string
  note: string
  /** The staff member who added it, or null when the coach did. */
  byStaff: string | null
}

/** A coach's 排班 from today on, for the editors. */
export interface ScheduleViewDto {
  /** The first period starts today; later ones are changes already planned. */
  periods: HoursPeriod[]
  /** The coach's 请假 and 加班 that have not ended. */
  exceptions: ScheduleExceptionDto[]
  /** 闭馆 that has not ended. */
  closures: ScheduleExceptionDto[]
  /** Whether coaches change their own 排班 in the mini program. */
  coachEdits: boolean
  /** How many days ahead lessons open for booking. */
  advanceDays: number
  /** The coach's shortest private lesson in minutes; null when they teach none. */
  lessonMinutes: number | null
}

/** A lesson or group session yet to start that needs moving or cancelling after a 排班 change. */
export interface ScheduleConflictDto {
  slotId: number
  /** The private lesson's booking; null for a group session. */
  bookingId: number | null
  coachId: number
  coachName: string
  startsAt: string
  endsAt: string
  /** The student's name, or the group class's name. */
  title: string
  group: boolean
}

/** A start time a private lesson can be booked at. */
export interface OpenTimeDto {
  coachId: number
  startsAt: string
  endsAt: string
  /** No table is free for the whole lesson, so it cannot be booked now. */
  tableFull: boolean
}

/** One day for the admin 日程 board, beside the day's lessons and sessions. */
export interface DayPlanDto {
  date: string
  /** Active coaches, and inactive ones with a lesson that day, in the venue's order. */
  coaches: {
    id: number
    name: string
    active: boolean
    categoryName: string | null
    /** Working time: weekly hours with 加班, less 请假 and 闭馆. */
    working: { startsAt: string; endsAt: string }[]
    /** 请假 and 闭馆 touching the day. */
    off: ScheduleExceptionDto[]
  }[]
  tables: number | null
  /** Tables in use at the busiest moment of each half hour, where any are. */
  tableUse: { startsAt: string; used: number }[]
}
