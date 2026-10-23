// The venue runs on China Standard Time, which has no daylight saving.
export const VENUE_TIME_ZONE = 'Asia/Shanghai'
const VENUE_UTC_OFFSET_MS = 8 * 60 * 60 * 1000

/** Calendar date at the venue as YYYY-MM-DD. */
export function venueDateKey(instant: Date): string {
  return new Date(instant.getTime() + VENUE_UTC_OFFSET_MS).toISOString().slice(0, 10)
}

/** Instant for a venue-local date (YYYY-MM-DD) and minutes after midnight. */
export function venueInstant(dateKey: string, minutes: number): Date {
  const midnightUtc = Date.parse(`${dateKey}T00:00:00Z`)
  // Date.parse rolls impossible days such as 2026-02-30 into the next month, so round-trip it.
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(dateKey) ||
    Number.isNaN(midnightUtc) ||
    new Date(midnightUtc).toISOString().slice(0, 10) !== dateKey
  ) {
    throw new RangeError(`Invalid date key: ${dateKey}`)
  }
  return new Date(midnightUtc - VENUE_UTC_OFFSET_MS + minutes * 60_000)
}
