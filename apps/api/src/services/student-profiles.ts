// 学员档案: level, grip, tags and a note that staff keep on a student for the coaches.
import { profileEdit, type StudentProfileDto, type StudentProfileEdit } from '@rs/shared'
import { and, eq, sql } from 'drizzle-orm'
import { immediate, type Q } from '../db/client'
import { bookings, studentProfiles, students } from '../db/schema'
import type { Deps } from '../deps'
import { notFound } from '../errors'
import { accountDeleted } from './account'

const EMPTY: StudentProfileEdit = { level: null, grip: null, tags: [], note: '' }

function editOf(tx: Q, studentId: number): StudentProfileEdit {
  const row = tx
    .select()
    .from(studentProfiles)
    .where(eq(studentProfiles.studentId, studentId))
    .get()
  return profileEdit(row ?? EMPTY)
}

/** The profile with the student's lesson and no-show counts at the venue. */
export function studentProfile(tx: Q, studentId: number, now: Date): StudentProfileDto {
  const counts = tx
    .select({
      lessons: sql<number>`coalesce(sum(case when coalesce(${bookings.attendance}, '') != 'no_show' and ${bookings.endsAt} <= ${now.getTime()} then 1 else 0 end), 0)`,
      noShows: sql<number>`coalesce(sum(case when ${bookings.attendance} = 'no_show' then 1 else 0 end), 0)`,
    })
    .from(bookings)
    .where(and(eq(bookings.studentId, studentId), eq(bookings.status, 'confirmed')))
    .get()
  return { ...editOf(tx, studentId), lessons: counts?.lessons ?? 0, noShows: counts?.noShows ?? 0 }
}

/** Tags trimmed, empty ones dropped and repeats removed, in the order given. */
export function cleanTags(tags: string[]): string[] {
  return [...new Set(tags.map((t) => t.trim()).filter(Boolean))]
}

/**
 * Replaces the profile. Returns the names of the fields that changed, empty when nothing did, so a
 * repeat of the same save succeeds and logs nothing. `check` sees the profile as it was, to refuse
 * a save made on top of someone else's change.
 */
export function saveStudentProfile(
  deps: Deps,
  studentId: number,
  edit: StudentProfileEdit,
  check: (current: StudentProfileEdit) => void,
): string[] {
  const next = profileEdit({ ...edit, tags: cleanTags(edit.tags), note: edit.note.trim() })
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
    tx.insert(studentProfiles)
      .values({ studentId, ...next, updatedAt: deps.now() })
      .onConflictDoUpdate({
        target: studentProfiles.studentId,
        set: { ...next, updatedAt: deps.now() },
      })
      .run()
    return changed
  })
}
