import {
  type BookingTerms,
  bookingRules,
  bookingTerms,
  defaultSettings,
  type RuleOverrides,
  ruleNames,
  rulesFor,
  type VenueSettings,
  venueSettings,
} from '@rs/shared'
import { eq } from 'drizzle-orm'
import type { Q } from '../db/client'
import { coachLessonTypes, lessonTypes, settings } from '../db/schema'

/** The venue settings, with defaults for anything missing or invalid. */
export function getSettings(db: Q): VenueSettings {
  const row = db.select().from(settings).where(eq(settings.id, 1)).get()
  if (!row) return defaultSettings
  const parsed = venueSettings.safeParse(mergeDefaults(row.data))
  return parsed.success ? parsed.data : defaultSettings
}

export function saveSettings(db: Q, data: VenueSettings, now: Date) {
  db.insert(settings)
    .values({ id: 1, data, updatedAt: now })
    .onConflictDoUpdate({ target: settings.id, set: { data, updatedAt: now } })
    .run()
}

// Settings saved before a field existed get that field's default.
function mergeDefaults(data: unknown): unknown {
  if (typeof data !== 'object' || data === null) return defaultSettings
  const out: Record<string, unknown> = { ...defaultSettings }
  for (const [key, value] of Object.entries(data)) {
    const base = (defaultSettings as Record<string, unknown>)[key]
    out[key] =
      typeof base === 'object' && base !== null && typeof value === 'object' && value !== null
        ? { ...base, ...value }
        : value
  }
  return out
}

/**
 * Every lesson type's booking rules, read once: `of` gives a type's own over the venue's, and the
 * venue's for a type it does not know.
 */
export function ruleBook(db: Q, settings = getSettings(db)) {
  const venue = rulesFor(settings.booking, null)
  const rows = db
    .select({ id: lessonTypes.id, rules: lessonTypes.rules, active: lessonTypes.active })
    .from(lessonTypes)
    .all()
  const byType = new Map(rows.map((t) => [t.id, rulesFor(venue, ownRules(t.rules))]))
  const of = (typeId: number | null | undefined) =>
    (typeId ? byType.get(typeId) : undefined) ?? venue
  /** Days ahead any of these lesson types on offer can be booked; all of them when left out. */
  const longest = (typeIds?: readonly number[]) => {
    const days = rows
      .filter((t) => t.active && (!typeIds || typeIds.includes(t.id)))
      .map((t) => of(t.id).advanceDays)
    return days.length ? Math.max(...days) : venue.advanceDays
  }
  return {
    venue,
    of,
    /** The cancel and move rules a booking follows: the ones it was booked under. */
    termsOf: (b: { terms: BookingTerms | null; lessonTypeId: number }) =>
      b.terms ?? bookingTerms(of(b.lessonTypeId)),
    longestAdvanceDays: longest,
    all: () => [...byType.values()],
  }
}

// A rule saved under an older shape is dropped, and follows the venue's, rather than trusted.
export function ownRules(data: unknown): RuleOverrides {
  if (typeof data !== 'object' || data === null) return {}
  const out: RuleOverrides = {}
  for (const name of ruleNames) {
    const parsed = bookingRules.shape[name].safeParse((data as Record<string, unknown>)[name])
    if (parsed.success) Object.assign(out, { [name]: parsed.data })
  }
  return out
}

/** The lesson types a coach teaches. */
export function taughtBy(db: Q, coachId: number): number[] {
  return db
    .select({ id: coachLessonTypes.lessonTypeId })
    .from(coachLessonTypes)
    .where(eq(coachLessonTypes.coachId, coachId))
    .all()
    .map((r) => r.id)
}
