// A coach's view of their lessons, and the marks a coach or the venue puts on them.
import {
  addVenueDays,
  type CoachDaysDto,
  type CoachLessonDto,
  type CoachSessionDto,
  type CoachSlotDto,
  SCHEDULE_STEP,
  type StudentProfileDto,
  type StudentProfileEdit,
  subtractSpans,
  venueDates,
  venueInstant,
  withinSpans,
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
import { busyTime, exceptionsFor, shortestLesson, workingTime } from './schedule'
import { getSettings } from './settings'
import { saveStudentProfile, studentProfile } from './student-profiles'
import { bookingStatus } from './views'

/** How long after a lesson its coach still sees and keeps the student's 学员档案 on it. */
const PROFILE_DAYS_AFTER = 7

/**
 * Whether the coach reads and edits the student's 学员档案 on this lesson: only around a paid
 * lesson they teach, not before it is paid or once it was cancelled, and not for lessons that ended
 * more than a week ago, so a coach does not keep a student they no longer teach.
 */
function profileOpen(
  b: Pick<typeof bookings.$inferSelect, 'status' | 'endsAt'>,
  studentDeletedAt: Date | null,
  now: Date,
) {
  return (
    !studentDeletedAt &&
    b.status === 'confirmed' &&
    b.endsAt.getTime() > now.getTime() - PROFILE_DAYS_AFTER * 86_400_000
  )
}

/** The profile as coaches get it: staff who saved it show as the venue, not by name. */
function coachView(db: Deps['db'], studentId: number, now: Date): StudentProfileDto {
  const p = studentProfile(db, studentId, now)
  return p.updatedBy?.kind === 'staff' ? { ...p, updatedBy: { kind: 'staff', name: '场馆' } } : p
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
  if (!profileOpen(booking, student?.deletedAt ?? null, deps.now())) {
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

const DAY = 24 * 60 * 60 * 1000

/**
 * A coach's days between two venue dates, inclusive: their lessons and group sessions, the working
 * time still free for private lessons, and 请假 and 闭馆.
 */
export function coachSchedule(deps: Deps, coachId: number, from: string, to: string): CoachDaysDto {
  const { db } = deps
  const now = deps.now()
  const span = { startsAt: venueInstant(from, 0), endsAt: venueInstant(addVenueDays(to, 1), 0) }
  const rows = db
    .select()
    .from(slots)
    .where(
      and(
        eq(slots.coachId, coachId),
        gte(slots.startsAt, span.startsAt),
        lt(slots.startsAt, span.endsAt),
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
  const items = rows
    // A private lesson row left over from a cancelled booking is not a lesson.
    .filter((s) => s.lessonTypeId !== null || bySlot.has(s.id))
    .map((s): CoachSlotDto => {
      const l = s.lessonTypeId === null ? bySlot.get(s.id) : undefined
      return {
        id: s.id,
        startsAt: s.startsAt.toISOString(),
        endsAt: s.endsAt.toISOString(),
        group:
          s.lessonTypeId === null
            ? null
            : {
                lessonTypeName: typeNames.get(s.lessonTypeId) ?? '',
                capacity: s.capacity,
                booked: booked.get(s.id) ?? 0,
                cancelled: s.cancelledAt !== null,
              },
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
  const dates = venueDates(
    span.startsAt,
    (span.endsAt.getTime() - span.startsAt.getTime()) / DAY - 1,
  )
  const working = workingTime(db, [coachId], dates).get(coachId)
  const busy = busyTime(db, [coachId], span).get(coachId) ?? []
  // Only the part still ahead is free, from the next 5-minute mark so it reads as a time.
  const step = SCHEDULE_STEP * 60_000
  const ahead = new Date(Math.ceil(now.getTime() / step) * step)
  const future = [{ startsAt: ahead, endsAt: span.endsAt }]
  // Free means a student can book it: clear of the buffer around lessons, and long enough for the
  // shortest private lesson the coach teaches.
  const settings = getSettings(db)
  const buffer = settings.booking.bufferMinutes * 60_000
  const shortest = (shortestLesson(db, coachId) ?? Number.POSITIVE_INFINITY) * 60_000
  const padded = busy.map((b) => ({
    startsAt: new Date(b.startsAt.getTime() - buffer),
    endsAt: new Date(b.endsAt.getTime() + buffer),
  }))
  const free = dates.flatMap((d) =>
    subtractSpans(working?.get(d) ?? [], [
      ...padded,
      { startsAt: span.startsAt, endsAt: ahead },
    ]).filter(
      (f) => withinSpans(f, future) && f.endsAt.getTime() - f.startsAt.getTime() >= shortest,
    ),
  )
  const off = (exceptionsFor(db, [coachId], span).get(coachId) ?? [])
    .filter((e) => e.kind === 'off')
    .map((e) => ({
      id: e.id,
      startsAt: e.startsAt.toISOString(),
      endsAt: e.endsAt.toISOString(),
      note: e.note,
      closure: e.coachId === null,
    }))
  return {
    lessons: items,
    free: free.map((f) => ({ startsAt: f.startsAt.toISOString(), endsAt: f.endsAt.toISOString() })),
    off,
    coachEdits: settings.booking.coachEditsHours,
  }
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
      student && profileOpen(b, student.deletedAt, now) ? coachView(db, student.id, now) : null,
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
