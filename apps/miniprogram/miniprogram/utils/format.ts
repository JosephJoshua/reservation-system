import { formatYuan, type PriceTag, venueDateKey, venueParts } from '../lib/shared'

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** Venue wall-clock parts of an instant, ready to print. */
function parts(iso: string | Date) {
  const p = venueParts(new Date(iso))
  return {
    year: p.year,
    month: p.month,
    day: p.day,
    weekday: WEEKDAYS[p.weekday] ?? '',
    hh: String(p.hours).padStart(2, '0'),
    mm: String(p.minutes).padStart(2, '0'),
  }
}

export function yuan(fen: number): string {
  return `¥${formatYuan(fen)}`
}

export function priceText(tag: PriceTag | null): { price: string; original: string } {
  if (!tag) return { price: '', original: '' }
  return {
    price: yuan(tag.price),
    original: tag.originalPrice == null ? '' : yuan(tag.originalPrice),
  }
}

export function time(iso: string): string {
  const p = parts(iso)
  return `${p.hh}:${p.mm}`
}

/** 今天, 明天, 后天, or 10月24日. */
export function dayName(iso: string | Date, now = new Date()): string {
  const key = venueDateKey(new Date(iso))
  const diff = Math.round(
    (Date.parse(`${key}T00:00:00Z`) - Date.parse(`${venueDateKey(now)}T00:00:00Z`)) / 86400000,
  )
  if (diff === 0) return '今天'
  if (diff === 1) return '明天'
  if (diff === 2) return '后天'
  const p = parts(iso)
  return `${p.month}月${p.day}日`
}

/** 10月24日 周六 */
export function dateText(iso: string | Date): string {
  const p = parts(iso)
  return `${p.month}月${p.day}日 ${p.weekday}`
}

/** 10月24日 周六 14:00-15:00 */
export function lessonTime(startsAt: string, endsAt: string): string {
  return `${dateText(startsAt)} ${time(startsAt)}-${time(endsAt)}`
}

/** 10月24日 14:00 */
export function dateTime(iso: string): string {
  const p = parts(iso)
  return `${p.month}月${p.day}日 ${p.hh}:${p.mm}`
}

/** 4月22日, with the year when it is not this year: 2027年4月22日 */
export function fullDate(iso: string | Date, now = new Date()): string {
  const p = parts(iso)
  const year = p.year === venueParts(now).year ? '' : `${p.year}年`
  return `${year}${p.month}月${p.day}日`
}

export function weekday(iso: string | Date): string {
  return parts(iso).weekday
}

export function monthDay(iso: string | Date): string {
  const p = parts(iso)
  return `${p.month}/${p.day}`
}

export function maskPhone(phone: string): string {
  return phone.length === 11 ? `${phone.slice(0, 3)}****${phone.slice(7)}` : phone
}

export interface Day {
  key: string
  label: string
  date: string
}

/** Today and the days after it that can be booked, for the day strip. */
export function bookableDays(advanceDays: number, now = Date.now()): Day[] {
  return Array.from({ length: advanceDays + 1 }, (_, i) => {
    const at = new Date(now + i * 86400000)
    return { key: venueDateKey(at), label: i < 3 ? dayName(at) : weekday(at), date: monthDay(at) }
  })
}

/**
 * Where the day strip scrolls to show `key`: days on the first screen keep it at its start,
 * later ones bring the day before into view, so the picked day keeps some room on its left.
 */
export function dayAnchor(days: Day[], key: string): string {
  const index = days.findIndex((d) => d.key === key)
  return index < 4 ? 'day-start' : `day-${days[index - 1]?.key}`
}
