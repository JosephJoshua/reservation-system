// 学员档案: level, grip, tags and a note that coaches and staff keep on a student for teaching.
import {
  charLength,
  cleanTags,
  grips,
  PROFILE_MAX_TAGS,
  PROFILE_NOTE_LENGTH,
  profileEdit,
  type StudentProfileDto,
  type StudentProfileEdit,
  studentLevels,
  tagsError,
} from '@rs/shared'
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { immediate, type Q } from '../db/client'
import { bookings, coaches, lessonFeedback, staff, studentProfiles, students } from '../db/schema'
import type { Deps } from '../deps'
import { notFound } from '../errors'
import { accountDeleted } from './account'
import { visible } from './feedback-visibility'

/** A profile save, from the admin or a coach's lesson page, with tags cleaned. */
export const profileInput = z.object({
  level: z.enum(studentLevels).nullable(),
  grip: z.enum(grips).nullable(),
  tags: z
    .array(z.string().max(100))
    // Only bounds the request; the limits are counted after blanks and repeats go.
    .max(PROFILE_MAX_TAGS * 4, `最多 ${PROFILE_MAX_TAGS} 个标签`)
    .transform(cleanTags)
    .superRefine((tags, ctx) => {
      const message = tagsError(tags)
      if (message) ctx.addIssue({ code: 'custom', message })
    }),
  note: z
    .string()
    .trim()
    .refine((n) => charLength(n) <= PROFILE_NOTE_LENGTH, `备注不能超过 ${PROFILE_NOTE_LENGTH} 字`),
})

/** Who saves the profile: a coach from a lesson page, or staff in the admin. */
export type ProfileEditor = { coachId: number } | { staffId: number }

function editOf(tx: Q, studentId: number): StudentProfileEdit {
  const row = tx
    .select()
    .from(studentProfiles)
    .where(eq(studentProfiles.studentId, studentId))
    .get()
  return row ? profileEdit(row) : { level: null, grip: null, tags: [], note: '' }
}

/** The profile with the student's lesson, no-show and feedback counts at the venue. */
export function studentProfile(tx: Q, studentId: number, now: Date): StudentProfileDto {
  const row = tx
    .select({ profile: studentProfiles, coach: coaches.name, staff: staff.name })
    .from(studentProfiles)
    .leftJoin(coaches, eq(coaches.id, studentProfiles.updatedByCoach))
    .leftJoin(staff, eq(staff.id, studentProfiles.updatedByStaff))
    .where(eq(studentProfiles.studentId, studentId))
    .get()
  const counts = tx
    .select({
      lessons: sql<number>`coalesce(sum(case when coalesce(${bookings.attendance}, '') != 'no_show' and ${bookings.endsAt} <= ${now.getTime()} then 1 else 0 end), 0)`,
      noShows: sql<number>`coalesce(sum(case when ${bookings.attendance} = 'no_show' then 1 else 0 end), 0)`,
    })
    .from(bookings)
    .where(and(eq(bookings.studentId, studentId), eq(bookings.status, 'confirmed')))
    .get()
  const feedback = tx
    .select({ n: sql<number>`count(*)` })
    .from(lessonFeedback)
    .innerJoin(bookings, eq(bookings.id, lessonFeedback.bookingId))
    .where(and(eq(bookings.studentId, studentId), visible))
    .get()
  const by =
    row?.coach != null
      ? { kind: 'coach' as const, name: row.coach }
      : row?.staff != null
        ? { kind: 'staff' as const, name: row.staff }
        : null
  return {
    ...(row ? profileEdit(row.profile) : { level: null, grip: null, tags: [], note: '' }),
    lessons: counts?.lessons ?? 0,
    noShows: counts?.noShows ?? 0,
    feedbackCount: feedback?.n ?? 0,
    updatedBy: by,
    updatedAt: by && row ? row.profile.updatedAt.toISOString() : null,
  }
}

/**
 * Replaces the profile, its tags already cleaned. Returns the names of the fields that changed,
 * empty when nothing did, so a repeat of the same save succeeds and logs nothing. `check` sees the
 * profile as it was, to refuse a save made on top of someone else's change.
 */
export function saveStudentProfile(
  deps: Deps,
  studentId: number,
  edit: StudentProfileEdit,
  by: ProfileEditor,
  check: (current: StudentProfileEdit) => void,
): string[] {
  const next = profileEdit(edit)
  const now = deps.now()
  return immediate(deps.db, (tx) => {
    const student = tx
      .select({ deletedAt: students.deletedAt })
      .from(students)
      .where(eq(students.id, studentId))
      .get()
    if (!student) throw notFound('学员')
    if (student.deletedAt) throw accountDeleted()
    const current = editOf(tx, studentId)
    const changed = [
      next.level !== current.level && '水平',
      next.grip !== current.grip && '握拍',
      JSON.stringify(next.tags) !== JSON.stringify(current.tags) && '标签',
      next.note !== current.note && '备注',
    ].filter((x): x is string => Boolean(x))
    if (!changed.length) return changed
    check(current)
    const saved = {
      ...next,
      updatedAt: now,
      updatedByCoach: 'coachId' in by ? by.coachId : null,
      updatedByStaff: 'staffId' in by ? by.staffId : null,
    }
    tx.insert(studentProfiles)
      .values({ studentId, ...saved })
      .onConflictDoUpdate({ target: studentProfiles.studentId, set: saved })
      .run()
    return changed
  })
}
