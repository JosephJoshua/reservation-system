import { z } from 'zod'

export const lateCancelRule = z.discriminatedUnion('kind', [
  // The lesson counts as taken: no refund, no lesson returned.
  z.object({ kind: z.literal('forfeit') }),
  // Refund this share of a per-class payment; a package lesson is returned only at 100.
  z.object({ kind: z.literal('partial'), percent: z.number().int().min(0).max(100) }),
])

export const venueSettings = z.object({
  venue: z.object({
    name: z.string().max(40),
    address: z.string().max(120),
    phone: z.string().max(30),
    latitude: z.number().min(-90).max(90).nullable(),
    longitude: z.number().min(-180).max(180).nullable(),
    openingHours: z.string().max(60),
  }),
  booking: z.object({
    advanceDays: z.number().int().min(1).max(90),
    minNoticeMinutes: z
      .number()
      .int()
      .min(0)
      .max(7 * 24 * 60),
    cancelDeadlineHours: z
      .number()
      .int()
      .min(0)
      .max(14 * 24),
    lateCancel: lateCancelRule,
  }),
  payment: z.object({
    trialEnabled: z.boolean(),
    perClassEnabled: z.boolean(),
    packagesEnabled: z.boolean(),
    timeoutMinutes: z.number().int().min(5).max(30),
    trialLimitPerStudent: z.number().int().min(1).max(10),
  }),
  notice: z.object({
    text: z.string().max(60),
    endsAt: z.iso.datetime({ offset: true }).nullable(),
  }),
  policies: z.object({
    booking: z.string().max(2000),
    agreement: z.string().max(5000),
  }),
})

export type VenueSettings = z.infer<typeof venueSettings>
export type LateCancelRule = z.infer<typeof lateCancelRule>

export const defaultSettings: VenueSettings = {
  venue: {
    name: '乒乓球馆',
    address: '',
    phone: '',
    latitude: null,
    longitude: null,
    openingHours: '09:00-21:00',
  },
  booking: {
    advanceDays: 14,
    minNoticeMinutes: 120,
    cancelDeadlineHours: 24,
    lateCancel: { kind: 'forfeit' },
  },
  payment: {
    trialEnabled: true,
    perClassEnabled: true,
    packagesEnabled: true,
    timeoutMinutes: 10,
    trialLimitPerStudent: 1,
  },
  notice: { text: '', endsAt: null },
  policies: {
    booking: '课前 24 小时以上取消，全额退款或退回课时；之后取消视为已上课。',
    agreement: '',
  },
}
