// Attendance: the front desk, the coach, or the student scanning the venue's 签到码 marks whether
// the student came. Marks never move money: package lessons were spent when the lesson was booked
// and per-class payments stay paid. They decide 课后点评 and, with no-shows unpaid, coach pay.
import {
  type Attendance,
  type AttendanceError,
  attendanceError,
  CHECK_IN_EARLY_MINUTES,
  type CheckInLessonDto,
  DISRUPTION_TEXT,
  type FrontDeskLessonDto,
  venueDateKey,
  venueInstant,
  venueParts,
} from '@rs/shared'
import { and, asc, eq, gt, gte, inArray, isNull, lt } from 'drizzle-orm'
import { immediate } from '../db/client'
import { bookings, coaches, lessonTypes, slots, staff, students } from '../db/schema'
import type { Deps } from '../deps'
import { ApiError, notFound } from '../errors'
import { personColumns } from './account'
import { attendanceDisruptions, disruptions } from './disruption'
import { getSettings } from './settings'

const messages: Record<AttendanceError, string> = {
  not_confirmed: '该课程未在进行，无法签到',
  not_started: `课前 ${CHECK_IN_EARLY_MINUTES} 分钟起可签到，课程开始后可记缺席`,
  too_late: '已超过签到期限，请联系场馆修改',
  marked: '该课程已记为缺席，请联系前台',
  staff_marked: '前台已登记这节课的签到，如需修改请联系前台',
}

type Booking = Pick<
  typeof bookings.$inferSelect,
  'status' | 'startsAt' | 'endsAt' | 'attendance' | 'attendanceBy'
>

/**
 * Whether the coach can mark this lesson now: 点名 is on, the lesson has started and the front desk
 * has not marked it.
 */
export function coachCanMark(b: Booking, now: Date, coachMarks: boolean) {
  return coachMarks && attendanceError(b, now, 'coach', null) === null
}

/** Whether the student can scan the 签到码 for this lesson now. */
export function studentCanCheckIn(b: Booking, now: Date, selfCheckIn: boolean) {
  return (
    selfCheckIn && b.attendance === null && attendanceError(b, now, 'student', 'attended') === null
  )
}

/**
 * The coach or the front desk marks whether the student came; null clears the mark. A repeat
 * keeps who marked it first and when, which the feedback window counts from, except that the
 * front desk takes over a mark the student or coach made, so the coach can no longer change it.
 * Returns whether anything was written.
 */
export function setAttendance(
  deps: Deps,
  bookingId: number,
  attendance: Attendance | null,
  by: { coachId: number } | { staffId: number },
): boolean {
  return immediate(deps.db, (tx) => {
    const row = tx
      .select({ booking: bookings, coachId: slots.coachId })
      .from(bookings)
      .innerJoin(slots, eq(slots.id, bookings.slotId))
      .where(eq(bookings.id, bookingId))
      .get()
    if (!row || ('coachId' in by && row.coachId !== by.coachId)) throw notFound('课程')
    if ('coachId' in by && !getSettings(tx).attendance.coachMarks) {
      throw new ApiError(403, 'coach_marks_off', '场馆已关闭教练点名，签到由前台办理')
    }
    const now = deps.now()
    const error = attendanceError(row.booking, now, 'coachId' in by ? 'coach' : 'admin', attendance)
    if (error) throw new ApiError(409, error, messages[error])
    if (row.booking.attendance === attendance) {
      if (!attendance || !('staffId' in by) || row.booking.attendanceBy === 'staff') return false
      // Kept as marked and when, now the desk's.
      tx.update(bookings)
        .set({ attendanceBy: 'staff', attendanceStaffId: by.staffId })
        .where(eq(bookings.id, bookingId))
        .run()
      return true
    }
    tx.update(bookings)
      .set({
        attendance,
        attendanceAt: attendance ? now : null,
        attendanceBy: attendance ? ('coachId' in by ? 'coach' : 'staff') : null,
        attendanceStaffId: attendance && 'staffId' in by ? by.staffId : null,
      })
      .where(eq(bookings.id, bookingId))
      .run()
    return true
  })
}

/** A lesson start as a student reads it: 今天 10:00, or 10月25日 10:00 on another day. */
function when(d: Date, now: Date) {
  const p = venueParts(d)
  const day = venueDateKey(d) === venueDateKey(now) ? '今天' : `${p.month}月${p.day}日`
  return `${day} ${String(p.hours).padStart(2, '0')}:${String(p.minutes).padStart(2, '0')}`
}

/**
 * The student scanned the venue's 签到码: checks in every lesson of theirs that is open for it,
 * from CHECK_IN_EARLY_MINUTES before the start until the end. Safe to repeat.
 */
export function studentCheckIn(deps: Deps, studentId: number): CheckInLessonDto[] {
  return immediate(deps.db, (tx) => {
    if (!getSettings(tx).attendance.selfCheckIn) {
      throw new ApiError(403, 'check_in_off', '场馆未开启扫码签到，请到前台签到')
    }
    const now = deps.now()
    const rows = tx
      .select({
        booking: bookings,
        coachName: coaches.name,
        lessonTypeName: lessonTypes.name,
      })
      .from(bookings)
      .innerJoin(slots, eq(slots.id, bookings.slotId))
      .innerJoin(coaches, eq(coaches.id, slots.coachId))
      .innerJoin(lessonTypes, eq(lessonTypes.id, bookings.lessonTypeId))
      .where(
        and(
          eq(bookings.studentId, studentId),
          eq(bookings.status, 'confirmed'),
          gt(bookings.endsAt, now),
          // A called-off session's seat the sweeper has yet to cancel.
          isNull(slots.cancelledAt),
        ),
      )
      .orderBy(asc(bookings.startsAt))
      // The ones open now come first; the rest only name the next lesson.
      .limit(10)
      .all()
    const open = rows.filter(
      (r) => attendanceError(r.booking, now, 'student', 'attended') !== 'not_started',
    )
    if (open.length === 0) {
      const next = rows[0]
      throw new ApiError(
        409,
        'nothing_to_check_in',
        next
          ? `下节课${when(next.booking.startsAt, now)} 开始，课前 ${CHECK_IN_EARLY_MINUTES} 分钟起可签到`
          : '没有待上的课程。如果是在前台预约的，请联系前台',
      )
    }
    const marked = open.filter((r) => r.booking.attendance !== 'no_show')
    if (marked.length === 0) throw new ApiError(409, 'marked', messages.marked)
    // A lesson the venue cannot give (闭馆, 请假, the coach stopped) is not checked in to.
    const disrupted = disruptions(
      tx,
      marked.map((r) => r.booking),
    )
    const done = marked.filter((r) => !disrupted.has(r.booking.id))
    const why = marked[0] ? disrupted.get(marked[0].booking.id) : undefined
    if (done.length === 0 && why) {
      // Shown under a 无法签到 title, so only the reason.
      throw new ApiError(409, 'lesson_unavailable', DISRUPTION_TEXT[why])
    }
    for (const r of done) {
      if (r.booking.attendance === 'attended') continue
      tx.update(bookings)
        .set({ attendance: 'attended', attendanceAt: now, attendanceBy: 'student' })
        .where(eq(bookings.id, r.booking.id))
        .run()
    }
    return done.map((r) => ({
      bookingId: r.booking.id,
      startsAt: r.booking.startsAt.toISOString(),
      endsAt: r.booking.endsAt.toISOString(),
      coachName: r.coachName,
      lessonTypeName: r.lessonTypeName,
      already: r.booking.attendance === 'attended',
    }))
  })
}

/** Every confirmed lesson on a venue day, one row per student, for the front desk's 签到 list. */
export function frontDeskLessons(deps: Deps, date: string): FrontDeskLessonDto[] {
  const { db } = deps
  const now = deps.now()
  const rows = db
    .select({
      booking: bookings,
      coach: { id: coaches.id, name: coaches.name },
      capacity: slots.capacity,
      lessonTypeName: lessonTypes.name,
      student: personColumns,
    })
    .from(bookings)
    .innerJoin(slots, eq(slots.id, bookings.slotId))
    .innerJoin(coaches, eq(coaches.id, slots.coachId))
    .innerJoin(lessonTypes, eq(lessonTypes.id, bookings.lessonTypeId))
    .innerJoin(students, eq(students.id, bookings.studentId))
    .where(
      and(
        eq(bookings.status, 'confirmed'),
        // A called-off session's seat the sweeper has yet to cancel.
        isNull(slots.cancelledAt),
        gte(bookings.startsAt, venueInstant(date, 0)),
        lt(bookings.startsAt, venueInstant(date, 24 * 60)),
      ),
    )
    .orderBy(asc(bookings.startsAt), asc(coaches.name), asc(bookings.id))
    .all()
  const staffIds = [
    ...new Set(
      rows.flatMap((r) => (r.booking.attendanceStaffId ? [r.booking.attendanceStaffId] : [])),
    ),
  ]
  const staffNames = new Map(
    staffIds.length
      ? db
          .select({ id: staff.id, name: staff.name })
          .from(staff)
          .where(inArray(staff.id, staffIds))
          .all()
          .map((s) => [s.id, s.name])
      : [],
  )
  // A lesson the student was told the venue cannot give, which the desk is asked about before 签到.
  const disrupted = attendanceDisruptions(
    db,
    rows.map((r) => r.booking),
    now,
  )
  return rows.map(({ booking: b, ...r }) => ({
    bookingId: b.id,
    slotId: b.slotId,
    startsAt: b.startsAt.toISOString(),
    endsAt: b.endsAt.toISOString(),
    coach: r.coach,
    lessonTypeName: r.lessonTypeName,
    capacity: r.capacity,
    student: r.student,
    attendance: b.attendance,
    attendanceAt: b.attendanceAt?.toISOString() ?? null,
    markedBy:
      b.attendance && b.attendanceBy
        ? {
            kind: b.attendanceBy,
            name: b.attendanceStaffId ? (staffNames.get(b.attendanceStaffId) ?? null) : null,
          }
        : null,
    canArrive: attendanceError(b, now, 'admin', 'attended') === null,
    canMarkAbsent: attendanceError(b, now, 'admin', 'no_show') === null,
    disruption: disrupted.get(b.id) ?? null,
  }))
}
