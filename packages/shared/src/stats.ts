import { venueInstant, venueParts } from './time'

const DAY = 24 * 60 * 60 * 1000

/** The longest range the stats cover at once. */
export const STATS_MAX_DAYS = 366

export type StatsGrain = 'day' | 'week' | 'month'

/** One step of a stats chart: venue dates from `from` up to, not including, `to`. */
export interface StatsBucket {
  from: string
  to: string
  label: string
}

/** Days from one venue date to another, inclusive of both. */
export function daysBetween(from: string, to: string) {
  return Math.round((venueInstant(to, 0).getTime() - venueInstant(from, 0).getTime()) / DAY) + 1
}

function shift(dateKey: string, days: number) {
  return new Date(venueInstant(dateKey, 12 * 60).getTime() + days * DAY).toISOString().slice(0, 10)
}

/** Days for up to a month, weeks for up to half a year, months beyond. */
export function statsGrain(from: string, to: string): StatsGrain {
  const days = daysBetween(from, to)
  if (days <= 31) return 'day'
  if (days <= 183) return 'week'
  return 'month'
}

/**
 * The range from `from` through `to` (venue dates, inclusive) cut into days, weeks starting on
 * Monday, or calendar months. The first and last steps are cut to the range.
 */
export function statsBuckets(from: string, to: string): StatsBucket[] {
  const grain = statsGrain(from, to)
  const end = shift(to, 1)
  const years = from.slice(0, 4) !== to.slice(0, 4)
  const buckets: StatsBucket[] = []
  let start = from
  while (start < end) {
    let next: string
    if (grain === 'day') next = shift(start, 1)
    else if (grain === 'week') {
      const weekday = venueParts(venueInstant(start, 12 * 60)).weekday
      next = shift(start, weekday === 0 ? 1 : 8 - weekday)
    } else {
      const [y, m] = start.split('-').map(Number) as [number, number]
      next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
    }
    if (next > end) next = end
    const [y, m, d] = start.split('-').map(Number) as [number, number, number]
    const prev = buckets[buckets.length - 1]
    // The year shows on the first step and where a new year starts, when the range spans two.
    const year = years && (!prev || prev.from.slice(0, 4) !== start.slice(0, 4))
    const label =
      grain === 'month' ? `${year ? `${y}年` : ''}${m}月` : `${year ? `${y}/` : ''}${m}/${d}`
    buckets.push({ from: start, to: next, label })
    start = next
  }
  return buckets
}

/** Index of the bucket holding a venue date, or -1. */
export function bucketOf(buckets: StatsBucket[], dateKey: string) {
  let lo = 0
  let hi = buckets.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const b = buckets[mid] as StatsBucket
    if (dateKey < b.from) hi = mid - 1
    else if (dateKey >= b.to) lo = mid + 1
    else return mid
  }
  return -1
}

/** Business stats for a range of venue dates, from GET /admin/reports/stats. */
export interface StatsReport {
  from: string
  to: string
  grain: StatsGrain
  buckets: StatsBucket[]
  /** Per bucket, in fen. Payments by when they were paid, refunds by when they went through. */
  revenue: {
    paid: number[]
    refunded: number[]
    /** 课消: the value of lessons taken, by lesson date. */
    consumed: number[]
  }
  /** Per bucket: sessions that took place (a group session counts once). */
  lessons: number[]
  /** Student bookings of lessons that took place, by attendance. */
  attendance: { attended: number; noShow: number; unmarked: number }
  /** Students with a lesson in each bucket, split by whether it was their first ever. */
  students: {
    new: number[]
    returning: number[]
    /** Distinct students over the whole range. */
    total: { new: number; returning: number }
  }
  /** Packages used up or expired in the range, and how many of them were followed by a new one. */
  renewal: { ended: number; renewed: number }
  /** Hours each coach was open for lessons and how many of them were booked. */
  coaches: { id: number; name: string; offeredMinutes: number; bookedMinutes: number }[]
  /** Lesson starts by weekday (0 is Monday) and venue hour. Only cells with open lessons. */
  heatmap: { weekday: number; hour: number; offered: number; booked: number }[]
  packages: {
    sales: { productId: number; name: string; count: number; amount: number }[]
    /** Value of lessons paid for and not taken, at the end of each bucket, in fen. */
    liability: number[]
  }
  /** Group sessions that took place, per lesson type: seats on offer and seats booked. */
  groups: { lessonTypeId: number; name: string; sessions: number; seats: number; booked: number }[]
}

/** Students with lessons left who have not had a lesson in 30 days and have none booked. */
export interface DormantStudent {
  student: { id: number; name: string; phone: string }
  lessonsLeft: number
  /** The soonest expiry among the packages with lessons left. */
  expiresAt: string
  lastLessonAt: string | null
}

export const DORMANT_DAYS = 30

/** How many venue days back the admin overview's 待签到 count looks. */
export const UNMARKED_DAYS = 7
