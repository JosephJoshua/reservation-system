import { z } from 'zod'

export const healthResponse = z.object({
  ok: z.literal(true),
  time: z.string(),
})

export type HealthResponse = z.infer<typeof healthResponse>
