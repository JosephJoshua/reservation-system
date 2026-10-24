// A coach's view of their lessons, and the marks a coach or the venue puts on them.
import {
  type Attendance,
  attendanceError,
  type CoachLessonDto,
  type CoachSlotDto,
  venueInstant,
} from '@rs/shared'
import { and, asc, desc, eq, gte, inArray, lt, lte, ne } from 'drizzle-orm'
import { immediate } from '../db/client'
import { bookings, lessonTypes, packages, slots, students } from '../db/schema'
import type { Deps } from '../deps'
import { ApiError, notFound } from '../errors'
import { DELETED_NAME } from './account'
import { LIVE } from './bookings'
import { movedFromIso, moveSummaries } from './move-history'
import { bookingStatus } from './views'

const attendanceMessages = {
  not_confirmed: '该课程未在进行，无法签到',
  not_started: '课程开始后才能签到',
  too_late: '已超过签到期限，请联系场馆修改',
} as const

/** A coach's slots between two venue dates, inclusive, with the lesson booked in each. */
export function coachSchedule(deps: Deps, coachId: number, from: string, to: string) {
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
  const now = deps.now()
  return rows.map((s): CoachSlotDto => {
    const l = bySlot.get(s.id)
    return {
      id: s.id,
      startsAt: s.startsAt.toISOString(),
      endsAt: s.endsAt.toISOString(),
      open: s.open,
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

/** The booking with its slot's coach, or 404 when it is not this coach's lesson. */
export function ownBooking(deps: Deps, bookingId: number, coachId?: number) {
  const row = deps.db
    .select({ booking: bookings, coachId: slots.coachId })
    .from(bookings)
    .innerJoin(slots, eq(slots.id, bookings.slotId))
    .where(eq(bookings.id, bookingId))
    .get()
  if (!row || (coachId !== undefined && row.coachId !== coachId)) throw notFound('课程')
  return row
}

export function coachLesson(deps: Deps, bookingId: number, coachId: number): CoachLessonDto {
  const { db } = deps
  const { booking: b } = ownBooking(deps, bookingId, coachId)
  const now = deps.now()
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
    student: {
      id: b.studentId,
      name: student?.deletedAt ? DELETED_NAME : (student?.name ?? ''),
      phone: student?.phone ?? '',
    },
    paidWith: b.paidWith,
    price: b.price,
    packageName: pkg?.name ?? null,
    attendance: b.attendance,
    coachNote: b.coachNote,
    canMarkAttendance: attendanceError(b, now, 'coach') === null,
    canCancel: (b.status === 'confirmed' || b.status === 'pending_payment') && now < b.startsAt,
    canMove: b.status === 'confirmed' && now < b.startsAt,
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

/**
 * Marks whether the student came. A no-show changes nothing else: package lessons were spent when
 * the lesson was booked and per-class payments stay paid. Null clears the mark.
 */
export function setAttendance(
  deps: Deps,
  bookingId: number,
  attendance: Attendance | null,
  by: { coachId: number } | 'admin',
) {
  immediate(deps.db, (tx) => {
    const row = tx
      .select({ booking: bookings, coachId: slots.coachId })
      .from(bookings)
      .innerJoin(slots, eq(slots.id, bookings.slotId))
      .where(eq(bookings.id, bookingId))
      .get()
    if (!row || (by !== 'admin' && row.coachId !== by.coachId)) throw notFound('课程')
    const now = deps.now()
    const error = attendanceError(row.booking, now, by === 'admin' ? 'admin' : 'coach')
    if (error) throw new ApiError(409, error, attendanceMessages[error])
    tx.update(bookings)
      .set({ attendance, attendanceAt: attendance ? now : null })
      .where(eq(bookings.id, bookingId))
      .run()
  })
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

/** Opens or closes one of the coach's own future slots. */
export function setSlotOpen(deps: Deps, slotId: number, coachId: number, open: boolean) {
  const slot = deps.db.select().from(slots).where(eq(slots.id, slotId)).get()
  if (!slot || slot.coachId !== coachId) throw notFound('时段')
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
  deps.db.update(slots).set({ open, closedBySync: false }).where(eq(slots.id, slotId)).run()
}
