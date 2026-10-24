// Response shapes of the coach API. Instants are ISO strings; money is fen.
import type { Attendance, WeeklyHours } from './availability'
import type { BookingStatus, FeedbackDto } from './dto'
import type { StudentProfileDto } from './students'

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
  /** The venue's 学员档案, read only; null unless the booking is live and the account exists. */
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
