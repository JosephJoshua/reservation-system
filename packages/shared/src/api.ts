import { z } from 'zod'

export const healthResponse = z.object({
  ok: z.literal(true),
  time: z.string(),
})

export type HealthResponse = z.infer<typeof healthResponse>

/** What a buyer was shown a package grants, sent with a purchase; see `samePackageTerms`. */
export const packageTermsSchema = z.object({
  lessonTypeId: z.number().int().positive(),
  coachIds: z.array(z.number().int().positive()).max(200),
  lessonCount: z.number().int().positive(),
  validityDays: z.number().int().positive(),
})
