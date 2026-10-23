import { venueDateKey, venueInstant, venueParts } from './time'

const DAY = 24 * 60 * 60 * 1000

/** A weekly window a coach takes lessons in, cut into lessons of a fixed length. */
export interface WeeklyHours {
  /** 0 is Sunday. */
  weekday: number
  /** Minutes after venue midnight. */
  startMinute: number
  endMinute: number
  lessonMinutes: number
}

/** Why a set of weekly hours cannot be saved, or null. */
export function weeklyHoursError(hours: WeeklyHours[]): string | null {
  for (const h of hours) {
    if (h.startMinute >= h.endMinute) return '结束时间需晚于开始时间'
    if (h.endMinute - h.startMinute < h.lessonMinutes) return '时间段短于一节课'
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

/** Venue dates from `from` through `days` days later, inclusive. */
export function venueDates(from: Date, days: number): string[] {
  const start = venueInstant(venueDateKey(from), 12 * 60).getTime()
  return Array.from({ length: days + 1 }, (_, i) => venueDateKey(new Date(start + i * DAY)))
}

/**
 * The lessons weekly hours give on these venue dates, skipping days off. A window that does not
 * divide evenly leaves its last minutes unused.
 */
export function lessonsFromHours(
  hours: WeeklyHours[],
  dates: string[],
  daysOff: ReadonlySet<string>,
): { startsAt: Date; endsAt: Date }[] {
  const lessons: { startsAt: Date; endsAt: Date }[] = []
  for (const date of dates) {
    if (daysOff.has(date)) continue
    const weekday = venueParts(venueInstant(date, 12 * 60)).weekday
    for (const h of hours) {
      if (h.weekday !== weekday) continue
      for (let m = h.startMinute; m + h.lessonMinutes <= h.endMinute; m += h.lessonMinutes) {
        lessons.push({
          startsAt: venueInstant(date, m),
          endsAt: venueInstant(date, m + h.lessonMinutes),
        })
      }
    }
  }
  return lessons.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
}

export type Attendance = 'attended' | 'no_show'

/** How long after a lesson ends a coach can still mark or correct attendance. The admin can always. */
export const COACH_ATTENDANCE_DAYS = 7

export type AttendanceError = 'not_confirmed' | 'not_started' | 'too_late'

/** Whether attendance can be marked for a booking now. */
export function attendanceError(
  booking: { status: string; startsAt: Date; endsAt: Date },
  now: Date,
  by: 'coach' | 'admin',
): AttendanceError | null {
  if (booking.status !== 'confirmed') return 'not_confirmed'
  if (now < booking.startsAt) return 'not_started'
  if (by === 'coach' && now.getTime() - booking.endsAt.getTime() > COACH_ATTENDANCE_DAYS * DAY) {
    return 'too_late'
  }
  return null
}
