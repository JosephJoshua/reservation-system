import { z } from 'zod'
import { LINK_KINDS, LINK_TARGET_MESSAGE, linkTargetValid } from './links'

/** Fields of a banner or notice link; refine the object with `linkTargetValid`. */
export const linkShape = {
  linkKind: z.enum(LINK_KINDS).default('none'),
  linkId: z.number().int().positive().nullable().default(null),
}

export const lateCancelRule = z.discriminatedUnion('kind', [
  // The lesson counts as taken: no refund, no lesson returned.
  z.object({ kind: z.literal('forfeit') }),
  // Refund this share of a per-class payment; a package lesson is returned only at 100.
  z.object({ kind: z.literal('partial'), percent: z.number().int().min(0).max(100) }),
])

/** Bounds of the booking rules that are numbers, for the schema and the admin inputs alike. */
export const ruleLimits = {
  advanceDays: { min: 1, max: 90 },
  minNoticeMinutes: { min: 0, max: 7 * 24 * 60 },
  cancelDeadlineHours: { min: 0, max: 14 * 24 },
  studentMoves: { min: 0, max: 5 },
} as const

const ruleNumber = (name: keyof typeof ruleLimits) =>
  z.number().int().min(ruleLimits[name].min).max(ruleLimits[name].max)

/** The booking rules a lesson type can set for itself; the venue's are the defaults. */
export const bookingRules = z.object({
  advanceDays: ruleNumber('advanceDays'),
  minNoticeMinutes: ruleNumber('minNoticeMinutes'),
  cancelDeadlineHours: ruleNumber('cancelDeadlineHours'),
  lateCancel: lateCancelRule,
  // Times a student can move a booking themselves, before the free-cancel deadline. 0 turns it off.
  studentMoves: ruleNumber('studentMoves'),
})

/** A lesson type's own rules: a rule left out follows the venue's. */
export const ruleOverrides = bookingRules.partial()

/** The rules a booking keeps from when it was made. */
export const bookingTermsSchema = bookingRules.pick({
  cancelDeadlineHours: true,
  lateCancel: true,
  studentMoves: true,
})

export const venueSettings = z.object({
  venue: z.object({
    // Named in the mini program and, without an operator, in the privacy policy.
    name: z.string().trim().min(1).max(40),
    address: z.string().max(120),
    phone: z.string().max(30),
    latitude: z.number().min(-90).max(90).nullable(),
    longitude: z.number().min(-180).max(180).nullable(),
    openingHours: z.string().max(60),
  }),
  booking: bookingRules.extend({
    // Lessons that can run at once, one per table. null is no limit.
    tables: z.number().int().min(1).max(99).nullable(),
    // How far apart the start times students are offered are, in minutes from midnight.
    startGrid: z.union([z.literal(15), z.literal(30), z.literal(60)]),
    // Minutes kept free between two private lessons of one coach.
    bufferMinutes: z.number().int().min(0).max(60).multipleOf(5),
    // Coaches change their own weekly hours and 请假 in the mini program; off, only staff can.
    coachEditsHours: z.boolean(),
  }),
  payment: z.object({
    trialEnabled: z.boolean(),
    perClassEnabled: z.boolean(),
    packagesEnabled: z.boolean(),
    timeoutMinutes: z.number().int().min(5).max(30),
    trialLimitPerStudent: z.number().int().min(1).max(10),
  }),
  notice: z
    .object({
      text: z.string().max(60),
      endsAt: z.iso.datetime({ offset: true }).nullable(),
      // Where a tap on the notice goes.
      ...linkShape,
    })
    .refine(linkTargetValid, { message: LINK_TARGET_MESSAGE, path: ['linkId'] }),
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
    operator: z.string().trim().max(60),
    contact: z.string().trim().max(60),
  }),
})

export type VenueSettings = z.infer<typeof venueSettings>
export type LateCancelRule = z.infer<typeof lateCancelRule>
export type BookingRules = z.infer<typeof bookingRules>
export type RuleOverrides = z.infer<typeof ruleOverrides>
export type RuleName = keyof BookingRules
export const ruleNames = Object.keys(bookingRules.shape) as RuleName[]

export const ruleLabels: Record<RuleName, string> = {
  advanceDays: '可提前预约',
  minNoticeMinutes: '最晚预约',
  cancelDeadlineHours: '免费取消',
  lateCancel: '晚于此时取消',
  studentMoves: '学员改约',
}

/** Rule names that read on their own, in lists and the action log. */
export const ruleShortLabels: Record<RuleName, string> = {
  ...ruleLabels,
  lateCancel: '逾时取消',
}

/** Names of the rules a lesson type sets on its own. */
export function ownRuleLabels(rules: RuleOverrides | null | undefined): string[] {
  return ruleNames.filter((n) => rules?.[n] !== undefined).map((n) => ruleShortLabels[n])
}

/** One rule's value in a few words, as the admin and the action log show it. */
export function ruleText<K extends RuleName>(name: K, value: BookingRules[K]): string {
  const v = value as BookingRules[RuleName]
  switch (name as RuleName) {
    case 'advanceDays':
      return `${v} 天以内`
    case 'minNoticeMinutes':
      return v === 0
        ? '开课前都可以预约'
        : `开课前 ${Math.round(((v as number) / 60) * 10) / 10} 小时`
    case 'cancelDeadlineHours':
      return v === 0 ? '开课前都可以免费取消' : `开课前 ${v} 小时以上`
    case 'lateCancel': {
      const late = v as LateCancelRule
      // Nothing back at 0% either, which reads plainer as the forfeit rule.
      return late.kind === 'forfeit' || late.percent === 0
        ? '视为已上课，不退款，也不退回课时'
        : `退还 ${late.percent}% 的费用`
    }
    default:
      return v === 0 ? '不允许' : `每节课 ${v} 次`
  }
}

export const defaultSettings: VenueSettings = {
  venue: {
    name: 'Lumi乒乓',
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
    startGrid: 30,
    bufferMinutes: 0,
    coachEditsHours: true,
  },
  payment: {
    trialEnabled: true,
    perClassEnabled: true,
    packagesEnabled: true,
    timeoutMinutes: 10,
    trialLimitPerStudent: 1,
  },
  notice: { text: '', endsAt: null, linkKind: 'none', linkId: null },
  policies: {
    booking: '课前 24 小时以上取消的，全额退款或退回课时；之后再取消，则视为已上课。',
    agreement: '',
  },
  pay: { noShows: true, lateCancels: false },
  attendance: { selfCheckIn: true, coachMarks: true },
  legal: { operator: '', contact: '' },
}
