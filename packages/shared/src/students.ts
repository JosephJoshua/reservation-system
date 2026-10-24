// 学员档案: what the venue records about a student for teaching. Coaches keep it up to date from
// their lesson pages, staff from the admin, and the student never sees it.

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

/** The part of the profile coaches and staff edit. */
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
  /** 课后点评 the student sees, from every coach. */
  feedbackCount: number
  /** Who saved it last, and when; null before anyone has, or for saves made before this was kept. */
  updatedBy: { kind: 'coach' | 'staff'; name: string } | null
  updatedAt: string | null
}

/** Length in characters as people count them, so an emoji is one, like the admin's counters. */
export function charLength(text: string): number {
  return Array.from(text).length
}

/** Tags trimmed, with empty ones and repeats dropped, in order. Too long ones are left to refuse. */
export function cleanTags(tags: string[]): string[] {
  return [...new Set(tags.map((t) => t.trim()).filter(Boolean))]
}

/** Why the tags cannot be saved, or null when they can. */
export function tagsError(tags: string[]): string | null {
  if (tags.some((t) => charLength(t) > PROFILE_TAG_LENGTH)) {
    return `每个标签不超过 ${PROFILE_TAG_LENGTH} 个字`
  }
  if (tags.length > PROFILE_MAX_TAGS) return `最多 ${PROFILE_MAX_TAGS} 个标签`
  return null
}

/** Lessons taken and missed, as staff and coaches see them on the profile. */
export function profileCounts(p: StudentProfileDto): string {
  return `已在本馆上课 ${p.lessons} 次${p.noShows ? `，缺席 ${p.noShows} 次` : ''}`
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
