// Response shapes of the coach API. Instants are ISO strings; money is fen.
import type { Attendance, WeeklyHours } from './availability'
import type { BookingStatus, FeedbackDto } from './dto'
import type { StudentProfileDto } from './students'

/** Starts the stored reason of a lesson the coach cancelled, before the coach's own words. */
export const COACH_CANCEL_PREFIX = '教练取消：'

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
  /** Every table is in use at some moment of it, so it cannot take a new lesson. */
  tableFull: boolean
  /** The live booking in a private slot; null in a group session. */
  lesson: {
    bookingId: number
    status: BookingStatus
    attendance: Attendance | null
    studentName: string
    lessonTypeName: string
    isTrial: boolean
  } | null
  /** A group session and its students. */
  group: {
    lessonTypeName: string
    capacity: number
    /** Live bookings, held or confirmed. */
    booked: number
    cancelled: boolean
  } | null
}

/** A group session with its roster, for the coach's session page. */
export interface CoachSessionDto {
  id: number
  startsAt: string
  endsAt: string
  lessonTypeName: string
  capacity: number
  cancelled: boolean
  cancelReason: string | null
  /** The venue turned 教练点名 off: the front desk marks attendance. */
  coachMarksOff: boolean
  students: {
    bookingId: number
    name: string
    status: BookingStatus
    attendance: Attendance | null
    canMarkAttendance: boolean
    hasFeedback: boolean
  }[]
}

export interface CoachLessonDto {
  id: number
  status: BookingStatus
  startsAt: string
  endsAt: string
  lessonType: { id: number; name: string; isTrial: boolean }
  /** The group session it is a seat in, or null for a private lesson. */
  sessionId: number | null
  student: { id: number; name: string; phone: string }
  /**
   * The 学员档案, which the coach can edit while it is here. Null once the lesson is cancelled or
   * ended over a week ago, or the student deleted their account.
   */
  profile: StudentProfileDto | null
  paidWith: 'order' | 'package'
  price: number
  packageName: string | null
  attendance: Attendance | null
  coachNote: string
  /**
   * The 课后点评; `hidden` when the venue took it down, `visible` while the student sees it: not
   * hidden, and the lesson is still on and marked attended.
   */
  feedback: (FeedbackDto & { hidden: boolean; visible: boolean }) | null
  /**
   * Why the coach cannot write or change the feedback now, such as 学员缺席，不能写点评; null when
   * they can. Deleting it is always allowed.
   */
  feedbackBlocked: string | null
  canMarkAttendance: boolean
  /** The venue turned 教练点名 off: the front desk marks attendance. */
  coachMarksOff: boolean
  canCancel: boolean
  /** The coach can move it to another of their slots. */
  canMove: boolean
  /** Start of the lesson's first time, when it was moved. */
  movedFrom: string | null
  cancelledBy: 'student' | 'venue' | null
  cancelReason: string | null
  /** Earlier lessons this student came to with this coach, no-shows left out. */
  lessonsTogether: number
  /** The student's earlier lessons with this coach that have ended, newest first. */
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
