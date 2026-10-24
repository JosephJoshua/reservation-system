import { addVenueDays, formatYuan, VENUE_TIME_ZONE, venueDateKey, venueInstant } from '@rs/shared'

export const yuan = (fen: number) => `¥${formatYuan(fen)}`

const grouped = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 })

/** Yuan with thousands separators, for big figures such as report totals. */
export const yuanGrouped = (fen: number) => `¥${grouped.format(fen / 100)}`

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
