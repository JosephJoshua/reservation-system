import { venueDateKey, venueInstant } from '../lib/shared'

/** Longest wait set at once, as long timers are not kept reliably; the page sets the next one then. */
const MAX_WAIT = 6 * 3_600_000

/**
 * How long until just after the next of these instants, for a page that redraws as a lesson
 * crosses one of them; null when none is still ahead.
 */
export function edgeWait(times: number[], now: number): number | null {
  const next = Math.min(...times.filter((t) => t > now))
  return Number.isFinite(next) ? Math.min(next - now + 1000, MAX_WAIT) : null
}

/** The venue midnight that ends the day `now` falls on, when a page's 今天 moves on. */
export function nextMidnight(now: number): number {
  return venueInstant(venueDateKey(new Date(now)), 24 * 60).getTime()
}
