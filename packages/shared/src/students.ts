// 学员档案: what the venue records about a student for teaching. Staff edit it in admin, coaches
// read it on the lesson page, and the student never sees it.

export const studentLevelLabels = {
  beginner: '零基础',
  elementary: '初级',
  intermediate: '中级',
  advanced: '高级',
} as const

export type StudentLevel = keyof typeof studentLevelLabels

export const studentLevels = Object.keys(studentLevelLabels) as [StudentLevel, ...StudentLevel[]]

export const gripLabels = {
  shakehand: '横拍',
  penhold: '直拍',
} as const

export type Grip = keyof typeof gripLabels

export const grips = Object.keys(gripLabels) as [Grip, ...Grip[]]

export const PROFILE_MAX_TAGS = 8
export const PROFILE_TAG_LENGTH = 10
export const PROFILE_NOTE_LENGTH = 500

/** The part of the profile staff edit. */
export interface StudentProfileEdit {
  level: StudentLevel | null
  grip: Grip | null
  tags: string[]
  note: string
}

export interface StudentProfileDto extends StudentProfileEdit {
  /** Lessons at the venue that have ended, no-shows left out. */
  lessons: number
  /** Lessons marked 缺席. */
  noShows: number
}

/** Length in characters as people count them, so an emoji is one, like the admin's counters. */
export function charLength(text: string): number {
  return Array.from(text).length
}

/** Tags trimmed, cut to the longest allowed, with empty ones and repeats dropped, in order. */
export function cleanTags(tags: string[]): string[] {
  const cut = tags.map((t) => Array.from(t.trim()).slice(0, PROFILE_TAG_LENGTH).join('').trim())
  return [...new Set(cut.filter(Boolean))]
}

/** Level and grip as labels, in that order, for the chips shown before the tags. */
export function profileTraits(p: StudentProfileEdit): string[] {
  return [p.level && studentLevelLabels[p.level], p.grip && gripLabels[p.grip]].filter(
    (t): t is NonNullable<typeof t> => Boolean(t),
  )
}

/** The editable fields in a fixed order, for `versionOf` on both sides. */
export function profileEdit(p: StudentProfileEdit): StudentProfileEdit {
  return { level: p.level, grip: p.grip, tags: p.tags, note: p.note }
}
