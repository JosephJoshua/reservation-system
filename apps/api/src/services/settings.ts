import { defaultSettings, type VenueSettings, venueSettings } from '@rs/shared'
import { eq } from 'drizzle-orm'
import type { Q } from '../db/client'
import { settings } from '../db/schema'

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
