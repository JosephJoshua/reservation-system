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
  if (Number.isNaN(midnightUtc)) throw new RangeError(`Invalid date key: ${dateKey}`)
  return new Date(midnightUtc - VENUE_UTC_OFFSET_MS + minutes * 60_000)
}
