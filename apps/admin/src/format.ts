import { addVenueDays, formatMoney, VENUE_TIME_ZONE, venueDateKey, venueInstant } from '@rs/shared'

/**
 * Money shown anywhere in the admin: thousands separators, and two decimals unless whole, as
 * ¥9,640, ¥9,640.10 and ¥13,000.10. The API's 操作记录 writes it the same way.
 */
export const yuan = formatMoney

/** Yuan typed by the admin to fen. Returns null when it is not a valid amount. */
export function toFen(yuanValue: number | string | undefined | null): number | null {
  if (yuanValue === undefined || yuanValue === null || yuanValue === '') return null
  const n = Number(yuanValue)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n * 100)
}

export const toYuan = (fen: number | null | undefined) => (fen == null ? undefined : fen / 100)

const dateTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: VENUE_TIME_ZONE,
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})
const time = new Intl.DateTimeFormat('zh-CN', {
  timeZone: VENUE_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})
const weekday = new Intl.DateTimeFormat('zh-CN', { timeZone: VENUE_TIME_ZONE, weekday: 'short' })

export const fmtDateTime = (iso: string | Date | null | undefined) =>
  iso ? dateTime.format(new Date(iso)) : '-'
export const fmtTime = (iso: string | Date) => time.format(new Date(iso))
export const fmtDate = (iso: string | Date) => venueDateKey(new Date(iso))
/**
 * The last venue day a period ending at `end` covers. An end is exclusive, so one at midnight
 * belongs to the day before: a sale ending 11-08 00:00 runs to 11-07.
 */
export const fmtLastDay = (end: string | Date) => fmtDate(new Date(new Date(end).getTime() - 1))
export const fmtWeekday = (iso: string | Date) => weekday.format(new Date(iso))

/** "2026-10-25" + "14:30" at the venue to an ISO instant. */
export function venueIso(dateKey: string, hhmm: string) {
  const [h, m] = hhmm.split(':').map(Number)
  return venueInstant(dateKey, (h ?? 0) * 60 + (m ?? 0)).toISOString()
}

/** "YYYY-MM-DD HH:mm:ss" from the date picker, read as venue time. */
export function pickerToIso(value: string | null | undefined) {
  if (!value) return null
  const [d, t] = value.split(' ')
  return venueIso(d ?? '', (t ?? '00:00').slice(0, 5))
}

export function isoToPicker(iso: string | null | undefined) {
  if (!iso) return ''
  return `${fmtDate(iso)} ${fmtTime(iso)}:00`
}

export const addDays = addVenueDays

export const today = () => venueDateKey(new Date())

/** A week from the start of today at the venue, as the first guess for a sale. */
export function defaultSaleWindow() {
  const start = today()
  return {
    saleStartsAt: venueIso(start, '00:00'),
    saleEndsAt: venueIso(addDays(start, 7), '00:00'),
  }
}

/** Who made an action log entry: the staff member, or the coach from the mini program. */
export function actorName(e: { staff: { name: string } | null; coach: { name: string } | null }) {
  return e.staff?.name ?? (e.coach ? `${e.coach.name}（教练）` : '')
}
