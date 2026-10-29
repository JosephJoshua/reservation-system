// 课后点评: what a coach writes for the student after a lesson, with photos, and what the venue
// can take down.
import { randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  type AdminFeedbackDto,
  FEEDBACK_LIST_LIMIT,
  FEEDBACK_PHOTOS,
  FEEDBACK_RECORD_LIMIT,
  type FeedbackDto,
  type FeedbackError,
  type FeedbackItemDto,
  feedbackError,
} from '@rs/shared'
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm'
import { immediate, type Q } from '../db/client'
import {
  bookings,
  coaches,
  lessonFeedback,
  lessonTypes,
  slots,
  studentNotices,
  students,
} from '../db/schema'
import type { Deps } from '../deps'
import { ApiError, notFound } from '../errors'
import { isVisible, visible } from './feedback-visibility'
import { countAll, ofStudents } from './lists'
import { queueStudentNotice } from './student-notices'

type FeedbackRow = typeof lessonFeedback.$inferSelect

export const MAX_PHOTO_BYTES = 5 * 1024 * 1024
/**
 * Photos uploaded for one lesson and not saved in its feedback, so uploads cannot fill the disk.
 * Room for a few editor sessions closed without saving; saving clears them.
 */
const MAX_UNSAVED = 4 * FEEDBACK_PHOTOS
/** Uploaded photos no feedback uses are removed after this long; the editor uses them sooner. */
const STRAY_MS = 24 * 3_600_000

const feedbackMessages: Record<FeedbackError, string> = {
  not_attended: '学员到课后才能写点评',
  too_late: '已超过 7 天点评期限',
}

/** The lesson a photo was uploaded for, from its name `fb<booking id>-<random>.<ext>`, if it is one. */
function lessonOfPhoto(name: string): number | null {
  const id = /^fb(\d+)-[0-9a-f]{12}\.(jpg|png|webp)$/.exec(name)?.[1]
  return id === undefined ? null : Number(id)
}

export const photoUrl = (name: string) => `/api/uploads/${name}`

/** Whether an uploaded file is a lesson photo, which only shows while its feedback may. */
export const isLessonPhoto = (name: string) => name.startsWith('fb')

const photoTypes = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' } as const

/**
 * Who asks for a lesson photo: anyone with its link, staff who may see students, or staff who
 * moderate feedback and so also see what the venue hid.
 */
export type PhotoViewer = 'anyone' | 'staff' | 'moderator'

/**
 * A lesson photo's bytes and type, or null when this viewer may not see it. Nobody sees photos of
 * deleted feedback or of a student who deleted their account. Anyone sees a photo of feedback the
 * student sees, and one not saved in feedback yet, for the coach's editor; unused ones are removed
 * within a day. `restricted` says the photo is not for anyone, so it is not to be cached.
 */
export function readLessonPhoto(deps: Deps, name: string, viewer: PhotoViewer) {
  const bookingId = lessonOfPhoto(name)
  if (bookingId === null) return null
  // Flat fields: drizzle reads a nested object of a left join as missing when its first field is
  // null, as hiddenAt is.
  const row = deps.db
    .select({
      status: bookings.status,
      attendance: bookings.attendance,
      studentDeletedAt: students.deletedAt,
      feedbackId: lessonFeedback.id,
      hiddenAt: lessonFeedback.hiddenAt,
      deletedAt: lessonFeedback.deletedAt,
      photos: lessonFeedback.photos,
    })
    .from(bookings)
    .innerJoin(students, eq(students.id, bookings.studentId))
    .leftJoin(lessonFeedback, eq(lessonFeedback.bookingId, bookings.id))
    .where(eq(bookings.id, bookingId))
    .get()
  if (!row || row.studentDeletedAt || row.deletedAt) return null
  const hidden = row.hiddenAt !== null
  const saved = row.feedbackId !== null && (row.photos ?? []).includes(name)
  const restricted = hidden || (saved && !isVisible({ hiddenAt: row.hiddenAt }, row))
  if (restricted && viewer === 'anyone') return null
  if (hidden && viewer !== 'moderator') return null
  try {
    const data = readFileSync(join(deps.uploadsDir, name))
    const ext = name.slice(name.lastIndexOf('.') + 1) as keyof typeof photoTypes
    return { data, type: photoTypes[ext], restricted }
  } catch {
    return null
  }
}

export function feedbackView(f: FeedbackRow): FeedbackDto {
  return { text: f.text, photos: f.photos.map(photoUrl), updatedAt: f.updatedAt.toISOString() }
}

/** Which of these lessons have feedback the student sees, without reading it. */
export function withVisibleFeedback(tx: Q, bookingIds: number[]): Set<number> {
  if (bookingIds.length === 0) return new Set()
  const rows = tx
    .select({ bookingId: lessonFeedback.bookingId })
    .from(lessonFeedback)
    .innerJoin(bookings, eq(bookings.id, lessonFeedback.bookingId))
    .where(and(inArray(lessonFeedback.bookingId, bookingIds), visible))
    .all()
  return new Set(rows.map((r) => r.bookingId))
}

export function visibleFeedback(tx: Q, bookingIds: number[]): Map<number, FeedbackDto> {
  if (bookingIds.length === 0) return new Map()
  const rows = tx
    .select({ feedback: lessonFeedback })
    .from(lessonFeedback)
    .innerJoin(bookings, eq(bookings.id, lessonFeedback.bookingId))
    .where(and(inArray(lessonFeedback.bookingId, bookingIds), visible))
    .all()
  return new Map(rows.map((r) => [r.feedback.bookingId, feedbackView(r.feedback)]))
}

/**
 * A lesson's feedback row. A hidden one the coach deleted stays as an empty row with `deletedAt`,
 * so the venue's decision still holds and the coach cannot write it again.
 */
export function feedbackOf(tx: Q, bookingId: number) {
  return tx.select().from(lessonFeedback).where(eq(lessonFeedback.bookingId, bookingId)).get()
}

/** Why the coach cannot write or change this lesson's feedback now, or null when they can. */
export function writeError(
  booking: Pick<typeof bookings.$inferSelect, 'status' | 'attendance' | 'attendanceAt' | 'endsAt'>,
  studentDeletedAt: Date | null,
  feedback: FeedbackRow | undefined,
  now: Date,
): ApiError | null {
  if (studentDeletedAt) return new ApiError(409, 'account_deleted', '该学员已注销')
  const error = feedbackError(booking, now)
  if (error) return new ApiError(409, error, feedbackMessages[error])
  if (feedback?.deletedAt) return new ApiError(409, 'feedback_deleted', '点评已删除，不能再写')
  if (feedback?.hiddenAt) {
    return new ApiError(409, 'feedback_hidden', '点评已被场馆隐藏，如需修改请联系场馆')
  }
  return null
}

/** Why the coach cannot write the lesson's feedback now, in words for the lesson page. */
export function writeBlock(
  booking: Pick<typeof bookings.$inferSelect, 'status' | 'attendance' | 'attendanceAt' | 'endsAt'>,
  studentDeletedAt: Date | null,
  feedback: FeedbackRow | undefined,
  now: Date,
): string | null {
  const error = writeError(booking, studentDeletedAt, feedback, now)
  if (error?.code !== 'not_attended') return error?.message ?? null
  if (booking.status !== 'confirmed') return '课程已取消，不能写点评'
  if (booking.attendance === 'no_show') return '学员缺席，不能写点评'
  return '签到为到课后才能写点评'
}

/** The coach's own lesson, or 404. */
function lessonOf(tx: Q, bookingId: number, coachId: number) {
  const row = tx
    .select({ booking: bookings, coachId: slots.coachId, deletedAt: students.deletedAt })
    .from(bookings)
    .innerJoin(slots, eq(slots.id, bookings.slotId))
    .innerJoin(students, eq(students.id, bookings.studentId))
    .where(eq(bookings.id, bookingId))
    .get()
  if (!row || row.coachId !== coachId) throw notFound('课程')
  return row
}

/** The coach's lesson, when its feedback can be written or changed now; throws otherwise. */
function writable(tx: Q, bookingId: number, coachId: number, now: Date) {
  const { booking, deletedAt } = lessonOf(tx, bookingId, coachId)
  const feedback = feedbackOf(tx, bookingId)
  const error = writeError(booking, deletedAt, feedback, now)
  if (error) throw error
  return { booking, feedback }
}

/** What an image upload is, from its first bytes rather than what the client says. */
export function imageType(data: Buffer): 'jpg' | 'png' | 'webp' | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg'
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png'
  }
  if (
    data.subarray(0, 4).toString('latin1') === 'RIFF' &&
    data.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'webp'
  }
  return null
}

// Files change right after the transaction that decides on them commits, with no await in
// between, so nothing else in the app runs in between, and a rollback leaves the files alone.

/**
 * Throws unless the coach can add a photo to this lesson's feedback now. A plain read: the photo is
 * written right after it, with no await in between.
 */
export function checkPhotoUpload(deps: Deps, bookingId: number, coachId: number) {
  const { feedback } = writable(deps.db, bookingId, coachId, deps.now())
  const saved = feedback?.photos ?? []
  if (photosOf(deps, bookingId).filter((n) => !saved.includes(n)).length >= MAX_UNSAVED) {
    throw new ApiError(409, 'too_many_photos', '照片太多，请先保存点评')
  }
}

/**
 * Stores a photo for a lesson's feedback; it shows once the feedback is saved with it. The upload
 * route checks before reading the body too.
 */
export async function savePhoto(deps: Deps, bookingId: number, coachId: number, file: File) {
  if (file.size > MAX_PHOTO_BYTES) throw new ApiError(400, 'too_large', '图片不能超过 5MB')
  const data = Buffer.from(await file.arrayBuffer())
  const ext = imageType(data)
  if (!ext) throw new ApiError(400, 'bad_type', '只支持 JPG、PNG、WebP 图片')
  const name = `fb${bookingId}-${randomBytes(6).toString('hex')}.${ext}`
  checkPhotoUpload(deps, bookingId, coachId)
  // Account deletion removes photos after its own commit, so one written here is not left over.
  mkdirSync(deps.uploadsDir, { recursive: true })
  writeFileSync(join(deps.uploadsDir, name), data)
  return photoUrl(name)
}

/**
 * Writes or changes a lesson's feedback. The student hears about it the first time only; later
 * changes are corrections. Photos are the URLs savePhoto returned for this lesson.
 */
export function saveFeedback(
  deps: Deps,
  bookingId: number,
  coachId: number,
  input: { text: string; photos: string[] },
) {
  const photos = [...new Set(input.photos.map((p) => p.replace(/^\/api\/uploads\//, '')))]
  if (photos.length > FEEDBACK_PHOTOS) {
    throw new ApiError(400, 'too_many_photos', `最多 ${FEEDBACK_PHOTOS} 张照片`)
  }
  const now = deps.now()
  immediate(deps.db, (tx) => {
    const { feedback } = writable(tx, bookingId, coachId, now)
    // Checked here, as a save from another device may have just removed them.
    for (const name of photos) {
      if (lessonOfPhoto(name) !== bookingId || !existsSync(join(deps.uploadsDir, name))) {
        throw new ApiError(400, 'bad_photo', '照片已失效，请重新上传')
      }
    }
    if (feedback) {
      tx.update(lessonFeedback)
        .set({ text: input.text, photos, updatedAt: now })
        .where(eq(lessonFeedback.id, feedback.id))
        .run()
      return
    }
    tx.insert(lessonFeedback)
      .values({ bookingId, text: input.text, photos, createdAt: now, updatedAt: now })
      .run()
    // Written again after the coach deleted it: one message about it is enough, unless the last
    // one was dropped because the feedback was gone by then.
    const told = tx
      .select({ id: studentNotices.id })
      .from(studentNotices)
      .where(
        and(
          eq(studentNotices.bookingId, bookingId),
          eq(studentNotices.kind, 'feedback'),
          or(isNull(studentNotices.result), ne(studentNotices.result, 'skipped')),
        ),
      )
      .get()
    if (!told) queueStudentNotice(tx, now, { bookingId, kind: 'feedback' })
  })
  // Photos taken out, and any uploaded in the editor but left out, go with it.
  removePhotosOf(deps, [bookingId], photos)
}

/**
 * Deletes a lesson's feedback and every photo uploaded for it. Deleting none is fine. Unlike
 * writing, the coach can always do this: their own words should never be stuck on show. Feedback
 * the venue hid is emptied rather than removed, so it cannot be written again around the venue.
 */
export function deleteFeedback(deps: Deps, bookingId: number, coachId: number) {
  immediate(deps.db, (tx) => {
    lessonOf(tx, bookingId, coachId)
    const feedback = feedbackOf(tx, bookingId)
    if (feedback?.hiddenAt) {
      if (feedback.deletedAt) return
      const now = deps.now()
      tx.update(lessonFeedback)
        .set({ text: '', photos: [], updatedAt: now, deletedAt: now })
        .where(eq(lessonFeedback.id, feedback.id))
        .run()
    } else if (feedback) {
      tx.delete(lessonFeedback).where(eq(lessonFeedback.id, feedback.id)).run()
    }
  })
  removePhotosOf(deps, [bookingId])
}

/** The student's 学习记录: feedback they can see, newest lesson first. */
export function studentFeedback(tx: Q, studentId: number): FeedbackItemDto[] {
  return tx
    .select({
      feedback: lessonFeedback,
      startsAt: bookings.startsAt,
      endsAt: bookings.endsAt,
      coachName: coaches.name,
      lessonTypeName: lessonTypes.name,
    })
    .from(lessonFeedback)
    .innerJoin(bookings, eq(bookings.id, lessonFeedback.bookingId))
    .innerJoin(slots, eq(slots.id, bookings.slotId))
    .innerJoin(coaches, eq(coaches.id, slots.coachId))
    .innerJoin(lessonTypes, eq(lessonTypes.id, bookings.lessonTypeId))
    .where(and(eq(bookings.studentId, studentId), visible))
    .orderBy(desc(bookings.startsAt))
    .limit(FEEDBACK_RECORD_LIMIT)
    .all()
    .map((r) => ({
      ...feedbackView(r.feedback),
      bookingId: r.feedback.bookingId,
      startsAt: r.startsAt.toISOString(),
      endsAt: r.endsAt.toISOString(),
      coachName: r.coachName,
      lessonTypeName: r.lessonTypeName,
    }))
}

export const feedbackStates = ['visible', 'invisible', 'hidden', 'deleted'] as const

export interface FeedbackFilters {
  from?: Date
  to?: Date
  coachId?: number
  lessonTypeId?: number
  studentId?: number
  slotId?: number
  ids?: number[]
  q?: string
  /** 学员可见, 学员不可见 (on a lesson not attended), 已隐藏 or deleted by the coach. */
  state?: (typeof feedbackStates)[number]
}

/** Feedback that matches, for a query that joins bookings and slots. */
function feedbackWhere(q: FeedbackFilters) {
  const live = isNull(lessonFeedback.deletedAt)
  return and(
    q.from ? gte(bookings.startsAt, q.from) : undefined,
    q.to ? lt(bookings.startsAt, q.to) : undefined,
    q.coachId ? eq(slots.coachId, q.coachId) : undefined,
    q.lessonTypeId ? eq(bookings.lessonTypeId, q.lessonTypeId) : undefined,
    q.studentId ? eq(bookings.studentId, q.studentId) : undefined,
    q.slotId ? eq(bookings.slotId, q.slotId) : undefined,
    q.ids ? inArray(lessonFeedback.id, q.ids) : undefined,
    ofStudents(bookings.studentId, q.q),
    q.state === 'visible'
      ? and(live, visible)
      : q.state === 'invisible'
        ? // Attendance not marked is null, which `not` alone would leave out.
          and(live, isNull(lessonFeedback.hiddenAt), sql`not coalesce(${visible}, 0)`)
        : q.state === 'hidden'
          ? and(live, isNotNull(lessonFeedback.hiddenAt))
          : q.state === 'deleted'
            ? isNotNull(lessonFeedback.deletedAt)
            : undefined,
  )
}

/** How many of the admin's list match, for its page numbers. */
export function adminFeedbackCount(tx: Q, q: FeedbackFilters) {
  return (
    tx
      .select({ n: countAll })
      .from(lessonFeedback)
      .innerJoin(bookings, eq(bookings.id, lessonFeedback.bookingId))
      .innerJoin(slots, eq(slots.id, bookings.slotId))
      .where(feedbackWhere(q))
      .get()?.n ?? 0
  )
}

/** The admin's list, newest lesson first. */
export function adminFeedback(
  tx: Q,
  q: FeedbackFilters & { limit?: number; offset?: number },
): AdminFeedbackDto[] {
  return tx
    .select({
      feedback: lessonFeedback,
      booking: bookings,
      visible: sql<number>`${visible}`,
      coach: { id: coaches.id, name: coaches.name },
      lessonTypeName: lessonTypes.name,
      student: { id: students.id, name: students.name, phone: students.phone },
    })
    .from(lessonFeedback)
    .innerJoin(bookings, eq(bookings.id, lessonFeedback.bookingId))
    .innerJoin(slots, eq(slots.id, bookings.slotId))
    .innerJoin(coaches, eq(coaches.id, slots.coachId))
    .innerJoin(lessonTypes, eq(lessonTypes.id, bookings.lessonTypeId))
    .innerJoin(students, eq(students.id, bookings.studentId))
    .where(feedbackWhere(q))
    .orderBy(desc(bookings.startsAt), desc(lessonFeedback.id))
    .limit(Math.min(q.limit ?? FEEDBACK_LIST_LIMIT, FEEDBACK_LIST_LIMIT))
    .offset(q.offset ?? 0)
    .all()
    .map((r) => ({
      ...feedbackView(r.feedback),
      id: r.feedback.id,
      bookingId: r.booking.id,
      slotId: r.booking.slotId,
      startsAt: r.booking.startsAt.toISOString(),
      coach: r.coach,
      lessonTypeName: r.lessonTypeName,
      student: r.student,
      createdAt: r.feedback.createdAt.toISOString(),
      hidden: r.feedback.hiddenAt !== null,
      deleted: r.feedback.deletedAt !== null,
      visible: Boolean(r.visible),
    }))
}

/** Takes feedback down or puts it back. Returns false when it already was that way. */
export function setFeedbackHidden(deps: Deps, id: number, staffId: number, hidden: boolean) {
  return immediate(deps.db, (tx) => {
    const row = tx.select().from(lessonFeedback).where(eq(lessonFeedback.id, id)).get()
    if (!row) throw notFound('点评')
    if (Boolean(row.hiddenAt) === hidden) return false
    if (row.deletedAt) throw new ApiError(409, 'feedback_deleted', '教练已删除这条点评')
    tx.update(lessonFeedback)
      .set(
        hidden
          ? { hiddenAt: deps.now(), hiddenByStaffId: staffId }
          : { hiddenAt: null, hiddenByStaffId: null },
      )
      .where(eq(lessonFeedback.id, id))
      .run()
    return true
  })
}

/** Inside account deletion: drops the student's feedback. Their photos go once it commits. */
export function deleteStudentFeedback(tx: Q, studentId: number): number[] {
  const ids = tx
    .select({ id: bookings.id })
    .from(bookings)
    .where(eq(bookings.studentId, studentId))
    .all()
    .map((b) => b.id)
  if (ids.length) tx.delete(lessonFeedback).where(inArray(lessonFeedback.bookingId, ids)).run()
  return ids
}

/**
 * Removes the photos uploaded for these lessons, saved in feedback or not, except `keep`. The
 * uploads folder is read in full; at one venue's scale that is a few thousand names.
 */
export function removePhotosOf(deps: Deps, bookingIds: number[], keep: string[] = []) {
  if (bookingIds.length === 0) return
  const ids = new Set(bookingIds)
  removeFiles(
    deps,
    uploads(deps).filter((n) => {
      const id = lessonOfPhoto(n)
      return id !== null && ids.has(id) && !keep.includes(n)
    }),
  )
}

/**
 * Removes lesson photos no feedback uses, a day after upload: ones uploaded in an editor that was
 * then closed without saving.
 */
export function removeStrayPhotos(deps: Deps) {
  const used = new Set(
    deps.db
      .select({ photos: lessonFeedback.photos })
      .from(lessonFeedback)
      .all()
      .flatMap((f) => f.photos),
  )
  const before = deps.now().getTime() - STRAY_MS
  removeFiles(
    deps,
    uploads(deps).filter((n) => {
      if (lessonOfPhoto(n) === null || used.has(n)) return false
      try {
        return statSync(join(deps.uploadsDir, n)).mtimeMs < before
      } catch {
        return false
      }
    }),
  )
}

/** The names of the photos uploaded for a lesson, saved or not. */
function photosOf(deps: Deps, bookingId: number) {
  return uploads(deps).filter((n) => lessonOfPhoto(n) === bookingId)
}

/** Every file in the uploads folder. Lesson photos share it with the venue's images. */
function uploads(deps: Deps): string[] {
  try {
    return readdirSync(deps.uploadsDir)
  } catch {
    return []
  }
}

function removeFiles(deps: Deps, names: string[]) {
  for (const name of names) {
    try {
      unlinkSync(join(deps.uploadsDir, name))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        deps.log('feedback photo not removed', { name, error: String(e) })
      }
    }
  }
}
