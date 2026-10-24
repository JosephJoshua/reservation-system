import type { Attendance, BookingStatus, StudentProfileDto } from '../../lib/shared'
import { dateTime } from '../../utils/format'

export interface Tag {
  text: string
  tone: 'primary' | 'warning' | 'success' | 'danger' | 'default'
}

/** What a coach needs to know about a lesson at a glance. */
export function lessonTag(
  lesson: { status: BookingStatus; attendance: Attendance | null },
  startsAt: string,
  now: number,
): Tag {
  if (lesson.status === 'pending_payment') return { text: '待支付', tone: 'warning' }
  if (lesson.status === 'cancelled') return { text: '已取消', tone: 'default' }
  if (lesson.status === 'expired') return { text: '已失效', tone: 'default' }
  if (lesson.attendance === 'attended') return { text: '已到课', tone: 'success' }
  if (lesson.attendance === 'no_show') return { text: '缺席', tone: 'danger' }
  if (Date.parse(startsAt) <= now) return { text: '待签到', tone: 'warning' }
  return { text: '已预约', tone: 'primary' }
}

export const ATTENDANCE: Record<Attendance, string> = {
  attended: '已到课',
  no_show: '缺席',
}

export const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** Minutes after midnight as 09:30. */
export function hhmm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

/** Who saved the profile last: a coach by name, staff as 场馆 (the API names them so). */
export function profileEdited(p: StudentProfileDto): string {
  if (!p.updatedBy || !p.updatedAt) return ''
  return `${p.updatedBy.name} ${dateTime(p.updatedAt)} 修改`
}
