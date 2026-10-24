// A coach's view of their lessons, and the marks a coach or the venue puts on them.
import {
  type CoachLessonDto,
  type CoachSessionDto,
  type CoachSlotDto,
  type StudentProfileEdit,
  venueInstant,
} from '@rs/shared'
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, ne } from 'drizzle-orm'
import { bookings, lessonFeedback, lessonTypes, packages, slots, students } from '../db/schema'
import type { Deps } from '../deps'
import { ApiError, notFound } from '../errors'
import { accountDeleted, DELETED_NAME } from './account'
import { coachCanMark } from './attendance'
import { LIVE } from './bookings'
import { feedbackOf, feedbackView, studentFeedback, writeBlock } from './feedback'
import { isVisible } from './feedback-visibility'
import { movedFromIso, moveSummaries } from './move-history'
import { assertNoSessionOverlap } from './sessions'
import { getSettings } from './settings'
import { saveStudentProfile, studentProfile } from './student-profiles'
import { slotsWithoutTable } from './tables'
import { bookingStatus } from './views'

/** How long after a lesson its coach still sees and keeps the student's 学员档案 on it. */
const PROFILE_DAYS_AFTER = 7

/**
 * Whether the coach reads and edits the student's 学员档案 on this lesson: only around a lesson
 * they teach, not once it was cancelled, and not for lessons that ended more than a week ago, so a
 * coach does not keep a student they no longer teach.
 */
function profileOpen(
  b: Pick<typeof bookings.$inferSelect, 'status' | 'endsAt'>,
  studentDeletedAt: Date | null,
  now: Date,
) {
  return (
    !studentDeletedAt &&
    (LIVE as readonly string[]).includes(b.status) &&
    b.endsAt.getTime() > now.getTime() - PROFILE_DAYS_AFTER * 86_400_000
  )
}

/** The lesson's student, or a refusal when the coach no longer has their 学员档案 on it. */
function profileStudent(deps: Deps, bookingId: number, coachId: number) {
  const { booking } = ownBooking(deps, bookingId, coachId)
  const student = deps.db
    .select({ deletedAt: students.deletedAt })
    .from(students)
    .where(eq(students.id, booking.studentId))
    .get()
  if (student?.deletedAt) throw accountDeleted()
  if (!profileOpen(booking, null, deps.now())) {
    throw new ApiError(409, 'profile_closed', '这节课已不能查看学员档案')
  }
  return booking.studentId
}

/** Saves the 学员档案 from a lesson page; returns the lesson as it is now. */
export function saveCoachProfile(
  deps: Deps,
  bookingId: number,
  coachId: number,
  edit: StudentProfileEdit,
  check: (current: StudentProfileEdit) => void,
): CoachLessonDto {
  const studentId = profileStudent(deps, bookingId, coachId)
  saveStudentProfile(deps, studentId, edit, { coachId }, (current) => {
    // Again inside the save's transaction, so a lesson cancelled or moved meanwhile refuses it.
    if (profileStudent(deps, bookingId, coachId) !== studentId) throw notFound('课程')
    check(current)
  })
  return coachLesson(deps, bookingId, coachId)
}

/** Every 课后点评 the lesson's student sees, from any coach, newest first. */
export function coachStudentFeedback(deps: Deps, bookingId: number, coachId: number) {
  return studentFeedback(deps.db, profileStudent(deps, bookingId, coachId))
}

/** A coach's slots between two venue dates, inclusive, with the lesson booked in each. */
export function coachSchedule(
  deps: Deps,
  coachId: number,
  from: string,
  to: string,
  /** The coach's lesson being moved, which gives up its table. */
  moving?: number,
) {
  const { db } = deps
  const rows = db
    .select()
    .from(slots)
    .where(
      and(
        eq(slots.coachId, coachId),
        gte(slots.startsAt, venueInstant(from, 0)),
        lt(slots.startsAt, venueInstant(to, 24 * 60)),
      ),
    )
    .orderBy(asc(slots.startsAt))
    .all()
  const lessons = rows.length
    ? db
        .select({
          booking: bookings,
          studentName: students.name,
          studentDeletedAt: students.deletedAt,
          lessonTypeName: lessonTypes.name,
          isTrial: lessonTypes.isTrial,
        })
        .from(bookings)
        .innerJoin(students, eq(students.id, bookings.studentId))
        .innerJoin(lessonTypes, eq(lessonTypes.id, bookings.lessonTypeId))
        .where(
          and(
            inArray(
              bookings.slotId,
              rows.map((r) => r.id),
            ),
            inArray(bookings.status, LIVE),
          ),
        )
        .all()
    : []
  const bySlot = new Map(lessons.map((l) => [l.booking.slotId, l]))
  const booked = new Map<number, number>()
  for (const l of lessons) booked.set(l.booking.slotId, (booked.get(l.booking.slotId) ?? 0) + 1)
  const typeNames = new Map(
    db
      .select({ id: lessonTypes.id, name: lessonTypes.name })
      .from(lessonTypes)
      .all()
      .map((t) => [t.id, t.name]),
  )
  const own =
    moving === undefined
      ? undefined
      : db
          .select({ id: bookings.id })
          .from(bookings)
          .innerJoin(slots, eq(slots.id, bookings.slotId))
          .where(and(eq(bookings.id, moving), eq(slots.coachId, coachId)))
          .get()
  const noTable = slotsWithoutTable(db, rows, own?.id)
  const now = deps.now()
  return rows.map((s): CoachSlotDto => {
    const l = s.lessonTypeId === null ? bySlot.get(s.id) : undefined
    return {
      id: s.id,
      startsAt: s.startsAt.toISOString(),
      endsAt: s.endsAt.toISOString(),
      open: s.open,
      group:
        s.lessonTypeId === null
          ? null
          : {
              lessonTypeName: typeNames.get(s.lessonTypeId) ?? '',
              capacity: s.capacity,
              booked: booked.get(s.id) ?? 0,
              cancelled: s.cancelledAt !== null,
            },
      tableFull: noTable.has(s.id),
      lesson: l
        ? {
            bookingId: l.booking.id,
            status: bookingStatus(l.booking, now),
            attendance: l.booking.attendance,
            studentName: l.studentDeletedAt ? DELETED_NAME : l.studentName,
            lessonTypeName: l.lessonTypeName,
            isTrial: l.isTrial,
          }
        : null,
    }
  })
}

/**
 * The booking with its slot's coach, and the group class its slot is a session of, or 404 when it
 * is not this coach's lesson.
 */
export function ownBooking(deps: Deps, bookingId: number, coachId?: number) {
  const row = deps.db
    .select({ booking: bookings, coachId: slots.coachId, sessionOf: slots.lessonTypeId })
    .from(bookings)
    .innerJoin(slots, eq(slots.id, bookings.slotId))
    .where(eq(bookings.id, bookingId))
    .get()
  if (!row || (coachId !== undefined && row.coachId !== coachId)) throw notFound('课程')
  return row
}

export function coachLesson(deps: Deps, bookingId: number, coachId: number): CoachLessonDto {
  const { db } = deps
  const { booking: b, sessionOf } = ownBooking(deps, bookingId, coachId)
  const now = deps.now()
  // The venue cancels and moves seats in its group sessions; the coach marks and reviews them.
  const own = sessionOf === null
  const student = db.select().from(students).where(eq(students.id, b.studentId)).get()
  const lessonType = db.select().from(lessonTypes).where(eq(lessonTypes.id, b.lessonTypeId)).get()
  const pkg = b.packageId
    ? db.select({ name: packages.name }).from(packages).where(eq(packages.id, b.packageId)).get()
    : undefined
  // Earlier lessons of this student with this coach that have ended, newest first.
  const together = db
    .select({
      id: bookings.id,
      startsAt: bookings.startsAt,
      attendance: bookings.attendance,
      coachNote: bookings.coachNote,
      lessonTypeName: lessonTypes.name,
    })
    .from(bookings)
    .innerJoin(slots, eq(slots.id, bookings.slotId))
    .innerJoin(lessonTypes, eq(lessonTypes.id, bookings.lessonTypeId))
    .where(
      and(
        eq(bookings.studentId, b.studentId),
        eq(slots.coachId, coachId),
        eq(bookings.status, 'confirmed'),
        ne(bookings.id, b.id),
        lt(bookings.startsAt, b.startsAt),
        lte(bookings.endsAt, now),
      ),
    )
    .orderBy(desc(bookings.startsAt))
    .all()
  const status = bookingStatus(b, now)
  const feedback = feedbackOf(db, b.id)
  const { coachMarks } = getSettings(db).attendance
  return {
    id: b.id,
    status,
    startsAt: b.startsAt.toISOString(),
    endsAt: b.endsAt.toISOString(),
    lessonType: {
      id: b.lessonTypeId,
      name: lessonType?.name ?? '',
      isTrial: lessonType?.isTrial ?? false,
    },
    sessionId: own ? null : b.slotId,
    student: {
      id: b.studentId,
      name: student?.deletedAt ? DELETED_NAME : (student?.name ?? ''),
      phone: student?.phone ?? '',
    },
    profile:
      student && profileOpen(b, student.deletedAt, now)
        ? studentProfile(db, student.id, now)
        : null,
    paidWith: b.paidWith,
    price: b.price,
    packageName: pkg?.name ?? null,
    attendance: b.attendance,
    coachNote: b.coachNote,
    feedback:
      feedback && !feedback.deletedAt
        ? {
            ...feedbackView(feedback),
            hidden: feedback.hiddenAt !== null,
            visible: isVisible(feedback, b),
          }
        : null,
    feedbackBlocked: writeBlock(b, student?.deletedAt ?? null, feedback, now),
    canMarkAttendance: coachCanMark(b, now, coachMarks),
    coachMarksOff: !coachMarks,
    canCancel:
      own && (b.status === 'confirmed' || b.status === 'pending_payment') && now < b.startsAt,
    canMove: own && b.status === 'confirmed' && now < b.startsAt,
    movedFrom: movedFromIso(moveSummaries(db, [b.id]).get(b.id), b.startsAt),
    cancelledBy: b.cancelledBy,
    cancelReason: b.cancelReason,
    lessonsTogether: together.filter((h) => h.attendance !== 'no_show').length,
    history: together.slice(0, 10).map((h) => ({
      id: h.id,
      startsAt: h.startsAt.toISOString(),
      lessonTypeName: h.lessonTypeName,
      attendance: h.attendance,
      coachNote: h.coachNote,
    })),
  }
}

export function setCoachNote(deps: Deps, bookingId: number, coachId: number, note: string) {
  const { booking } = ownBooking(deps, bookingId, coachId)
  if (booking.status === 'cancelled' || booking.status === 'expired') {
    throw new ApiError(409, 'not_live', '已取消的课程不能写备注')
  }
  const student = deps.db
    .select({ deletedAt: students.deletedAt })
    .from(students)
    .where(eq(students.id, booking.studentId))
    .get()
  if (student?.deletedAt) throw new ApiError(409, 'account_deleted', '该学员已注销')
  deps.db.update(bookings).set({ coachNote: note }).where(eq(bookings.id, bookingId)).run()
}

/** One of the coach's group sessions with its students, held or confirmed. */
export function coachSession(deps: Deps, slotId: number, coachId: number): CoachSessionDto {
  const { db } = deps
  const slot = db.select().from(slots).where(eq(slots.id, slotId)).get()
  if (!slot || slot.coachId !== coachId || slot.lessonTypeId === null) throw notFound('课程')
  const lessonType = db
    .select({ name: lessonTypes.name })
    .from(lessonTypes)
    .where(eq(lessonTypes.id, slot.lessonTypeId))
    .get()
  const rows = db
    .select({ booking: bookings, name: students.name, deletedAt: students.deletedAt })
    .from(bookings)
    .innerJoin(students, eq(students.id, bookings.studentId))
    .where(and(eq(bookings.slotId, slot.id), inArray(bookings.status, LIVE)))
    .orderBy(asc(bookings.id))
    .all()
  const written = new Set(
    rows.length
      ? db
          .select({ bookingId: lessonFeedback.bookingId })
          .from(lessonFeedback)
          .where(
            and(
              inArray(
                lessonFeedback.bookingId,
                rows.map((r) => r.booking.id),
              ),
              isNull(lessonFeedback.deletedAt),
            ),
          )
          .all()
          .map((f) => f.bookingId)
      : [],
  )
  const now = deps.now()
  const { coachMarks } = getSettings(db).attendance
  return {
    id: slot.id,
    startsAt: slot.startsAt.toISOString(),
    endsAt: slot.endsAt.toISOString(),
    lessonTypeName: lessonType?.name ?? '',
    capacity: slot.capacity,
    cancelled: slot.cancelledAt !== null,
    cancelReason: slot.cancelReason,
    coachMarksOff: !coachMarks,
    students: rows.map(({ booking: b, name, deletedAt }) => ({
      bookingId: b.id,
      name: deletedAt ? DELETED_NAME : name,
      status: bookingStatus(b, now),
      attendance: b.attendance,
      canMarkAttendance: coachCanMark(b, now, coachMarks),
      hasFeedback: written.has(b.id),
    })),
  }
}

/** Opens or closes one of the coach's own future slots. */
export function setSlotOpen(deps: Deps, slotId: number, coachId: number, open: boolean) {
  const slot = deps.db.select().from(slots).where(eq(slots.id, slotId)).get()
  if (!slot || slot.coachId !== coachId) throw notFound('时段')
  if (slot.lessonTypeId !== null) throw new ApiError(409, 'group_lesson', '小班课由场馆安排')
  if (slot.startsAt <= deps.now()) throw new ApiError(409, 'slot_started', '时段已开始')
  // The coach saw it free, but a student may have booked it since the list loaded.
  const booked = deps.db
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      and(eq(bookings.slotId, slotId), inArray(bookings.status, ['pending_payment', 'confirmed'])),
    )
    .get()
  if (!open && booked) throw new ApiError(409, 'slot_booked', '这个时段刚被预约，请刷新')
  if (open && !slot.open) assertNoSessionOverlap(deps.db, slot)
  deps.db.update(slots).set({ open, closedBySync: false }).where(eq(slots.id, slotId)).run()
}
