// Zod-free, so the mini program can bundle it; the schema fields are in settings.ts.

/** Targets that name one record, so they come with an id. */
export const LINK_RECORD_KINDS = ['lesson_type', 'coach', 'package'] as const
/** Fixed mini program pages, with no id. */
export const LINK_PAGE_KINDS = [
  'packages',
  'my_packages',
  'lessons',
  'venue',
  'booking_policy',
] as const

export const LINK_KINDS = ['none', ...LINK_RECORD_KINDS, ...LINK_PAGE_KINDS] as const

export type LinkKind = (typeof LINK_KINDS)[number]
export type LinkRecordKind = (typeof LINK_RECORD_KINDS)[number]
export type LinkPageKind = (typeof LINK_PAGE_KINDS)[number]

/** Where a tap on a banner or the home notice goes in the mini program. */
export interface LinkTarget {
  linkKind: LinkKind
  linkId: number | null
}

export const NO_LINK: LinkTarget = { linkKind: 'none', linkId: null }

export function isRecordLink(kind: LinkKind): kind is LinkRecordKind {
  return (LINK_RECORD_KINDS as readonly string[]).includes(kind)
}

export const LINK_KIND_LABELS: Record<LinkKind, string> = {
  none: '不跳转',
  lesson_type: '课程',
  coach: '教练',
  package: '课时包',
  packages: '购买课时包',
  my_packages: '我的课时包',
  lessons: '我的课程',
  venue: '场馆位置',
  booking_policy: '预约须知',
}

/** What the student sees after the tap, for the admin's picker. */
export const LINK_PAGE_HINTS: Record<LinkPageKind, string> = {
  packages: '打开课时包列表',
  my_packages: '打开“我的课时包”页',
  lessons: '切换到“课程”页',
  venue: '在地图上打开场馆位置',
  booking_policy: '打开预约须知全文',
}

/** A record link needs its id, and a page link or no link has none. */
export function linkTargetValid(v: LinkTarget): boolean {
  return isRecordLink(v.linkKind) === (v.linkId !== null)
}

export const LINK_TARGET_MESSAGE = '请选择跳转目标'
