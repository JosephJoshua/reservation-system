import { z } from 'zod'
import { venueDateKey } from './time'

export const healthResponse = z.object({
  ok: z.literal(true),
  time: z.string(),
})

export type HealthResponse = z.infer<typeof healthResponse>

/**
 * An instant as requests send it: ISO 8601 with an offset, on a venue date in 2000-2999 like the
 * date keys, so the venue time helpers never see one they cannot turn into a date.
 */
export const instantString = z.iso.datetime({ offset: true }).refine((s) => {
  const ms = Date.parse(s)
  return (
    ms > Date.UTC(1999, 11, 30) &&
    ms < Date.UTC(3000, 0, 2) &&
    venueDateKey(new Date(ms))[0] === '2'
  )
}, '时间无效')

/** What a buyer was shown a package grants, sent with a purchase; see `samePackageTerms`. */
export const packageTermsSchema = z.object({
  lessonTypeId: z.number().int().positive(),
  coachIds: z.array(z.number().int().positive()).max(200),
  lessonCount: z.number().int().positive(),
  validityDays: z.number().int().positive(),
})
