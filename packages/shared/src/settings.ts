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
    // Times a student can move a booking themselves, before the free-cancel deadline. 0 turns it off.
    studentMoves: z.number().int().min(0).max(5),
    // Lessons that can run at once, one per table. null is no limit.
    tables: z.number().int().min(1).max(99).nullable(),
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
  // Which lessons count toward a coach's pay besides the ones taught. Venue cancels never count.
  pay: z.object({
    noShows: z.boolean(),
    lateCancels: z.boolean(),
  }),
  // Who can mark attendance besides the front desk, which always can.
  attendance: z.object({
    // Students scan the venue's 签到码 at the front desk.
    selfCheckIn: z.boolean(),
    coachMarks: z.boolean(),
  }),
  // Who runs the mini program, as named in the privacy policy and the mini program console.
  legal: z.object({
    operator: z.string().max(60),
    contact: z.string().max(60),
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
    studentMoves: 1,
    tables: null,
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
  pay: { noShows: true, lateCancels: false },
  attendance: { selfCheckIn: true, coachMarks: true },
  legal: { operator: '', contact: '' },
}
