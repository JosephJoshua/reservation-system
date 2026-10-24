import { venueDateKey, venueInstant, venueParts } from './time'

const MINUTE = 60 * 1000
const DAY = 24 * 60 * MINUTE

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

/** Who marked a lesson's attendance: the student scanning the venue code, the coach or the front desk. */
export type AttendanceBy = 'student' | 'coach' | 'staff'

/** How long after a lesson ends a coach can still mark or correct attendance. The admin can always. */
export const COACH_ATTENDANCE_DAYS = 7

/** How early a student can be checked in as arrived. 缺席 waits until the lesson starts. */
export const CHECK_IN_EARLY_MINUTES = 30

/** The path the venue's printed 签到码 points to on the app's own domain. */
export const CHECK_IN_PATH = '/checkin'

const checkInCode = new RegExp(`^https?://[^/\\s?#]+${CHECK_IN_PATH}/?(?:[?#]\\S*)?$`)

/**
 * Whether a scanned code is the venue's 签到码: a link to CHECK_IN_PATH on any host. It is not a
 * secret: a fake check-in gains a student nothing, since lessons are paid for when booked.
 */
export function isCheckInCode(text: string): boolean {
  return checkInCode.test(text.trim())
}

export type AttendanceError = 'not_confirmed' | 'not_started' | 'too_late' | 'marked'

/**
 * Whether a lesson can be marked as `attendance` now; null clears a mark. The front desk and the
 * student can mark an arrival, or clear one, from CHECK_IN_EARLY_MINUTES before the start; 缺席
 * and every coach mark wait for the start. A student checks in only until the lesson ends and
 * only fills a lesson nobody has marked absent.
 */
export function attendanceError(
  booking: { status: string; startsAt: Date; endsAt: Date; attendance: Attendance | null },
  now: Date,
  by: 'student' | 'coach' | 'admin',
  attendance: Attendance | null,
): AttendanceError | null {
  if (booking.status !== 'confirmed') return 'not_confirmed'
  const opens =
    attendance === 'no_show' || by === 'coach'
      ? booking.startsAt.getTime()
      : booking.startsAt.getTime() - CHECK_IN_EARLY_MINUTES * MINUTE
  if (now.getTime() < opens) return 'not_started'
  if (by === 'student') {
    if (now >= booking.endsAt) return 'too_late'
    if (booking.attendance === 'no_show') return 'marked'
  }
  if (by === 'coach' && now.getTime() - booking.endsAt.getTime() > COACH_ATTENDANCE_DAYS * DAY) {
    return 'too_late'
  }
  return null
}

/**
 * How long after a lesson ends its coach can still write or change the feedback, counted from when
 * attendance was marked if that came later, so a late mark still leaves a week.
 */
export const COACH_FEEDBACK_DAYS = 7

/** Photos a coach can add to one lesson's feedback. */
export const FEEDBACK_PHOTOS = 6

/** The admin's 课后点评 list shows at most this many, newest first. */
export const FEEDBACK_LIST_LIMIT = 500

/** A student's 学习记录 shows at most this many, newest first, which keeps the page light. */
export const FEEDBACK_RECORD_LIMIT = 100

export type FeedbackError = 'not_attended' | 'too_late'

/** Whether the coach can write or change a lesson's feedback now. */
export function feedbackError(
  booking: {
    status: string
    attendance: Attendance | null
    attendanceAt: Date | null
    endsAt: Date
  },
  now: Date,
): FeedbackError | null {
  if (booking.status !== 'confirmed' || booking.attendance !== 'attended') return 'not_attended'
  const from = Math.max(booking.endsAt.getTime(), booking.attendanceAt?.getTime() ?? 0)
  if (now.getTime() - from > COACH_FEEDBACK_DAYS * DAY) return 'too_late'
  return null
}
