// Response shapes of the coach API. Instants are ISO strings; money is fen.
import type { Attendance, WeeklyHours } from './availability'
import type { BookingStatus } from './dto'

export interface CoachMeDto {
  id: number
  name: string
  title: string
  avatarUrl: string
  /** Subscription message templates to ask the coach for, empty when none are set up. */
  notifyTemplateIds: string[]
  /** How many days ahead lessons open for booking. */
  advanceDays: number
}

export interface CoachLoginResponse {
  token: string
  coach: CoachMeDto
}

export interface CoachSlotDto {
  id: number
  startsAt: string
  endsAt: string
  open: boolean
  /** The live booking in this slot. */
  lesson: {
    bookingId: number
    status: BookingStatus
    attendance: Attendance | null
    studentName: string
    lessonTypeName: string
    isTrial: boolean
  } | null
}

export interface CoachLessonDto {
  id: number
  status: BookingStatus
  startsAt: string
  endsAt: string
  lessonType: { id: number; name: string; isTrial: boolean }
  student: { id: number; name: string; phone: string }
  paidWith: 'order' | 'package'
  price: number
  packageName: string | null
  attendance: Attendance | null
  coachNote: string
  canMarkAttendance: boolean
  canCancel: boolean
  cancelledBy: 'student' | 'venue' | null
  cancelReason: string | null
  /** Lessons this student has taken with this coach, this one excluded. */
  lessonsTogether: number
  /** The student's earlier lessons with this coach, newest first. */
  history: {
    id: number
    startsAt: string
    lessonTypeName: string
    attendance: Attendance | null
    coachNote: string
  }[]
}

export interface CoachHoursDto {
  hours: WeeklyHours[]
  /** Upcoming days off as venue dates. */
  daysOff: string[]
  /** Lesson lengths the coach teaches, in minutes. */
  lessonMinutes: number[]
  /** How many days ahead lessons open for booking. */
  advanceDays: number
}

/** What saving hours or days off did to the coach's open slots. */
export interface SlotSyncDto {
  created: number
  removed: number
  /** Lessons already booked on days off. They stay until someone cancels them. */
  bookedOnDaysOff: number
}
