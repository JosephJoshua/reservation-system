import { z } from 'zod'
import type { SlotTarget } from '../services/schedule'

const id = z.coerce.number().int().positive()

// A real calendar date: Date.parse would quietly turn 2026-02-30 into March 2. Years stay within
// 2000-2999, so the day or month after the last one is still a date.
export const dateKey = z
  .string()
  .regex(/^2\d{3}-\d{2}-\d{2}$/, '日期无效')
  .refine((d) => {
    const ms = Date.parse(`${d}T00:00:00Z`)
    return !Number.isNaN(ms) && new Date(ms).toISOString().startsWith(d)
  }, '日期无效')

/** A venue month, YYYY-MM, in 2000-2999. */
export const monthKey = z.string().regex(/^2\d{3}-(0[1-9]|1[0-2])$/, '月份无效')

/**
 * Where a booking or move goes, as a request names it: `slotId` for a group session, or `coachId`
 * and `startsAt` for a private lesson time. Spread into a body or query schema, then pass the
 * parsed object to `toTarget`.
 */
export const targetFields = {
  slotId: id.optional(),
  coachId: id.optional(),
  startsAt: z.iso.datetime({ offset: true }).optional(),
}

/** Refines a schema that has `targetFields`: exactly one of the two forms. */
export const oneTarget = (o: { slotId?: number; coachId?: number; startsAt?: string }) =>
  o.slotId !== undefined
    ? o.coachId === undefined && o.startsAt === undefined
    : o.coachId !== undefined && o.startsAt !== undefined

export function toTarget(o: { slotId?: number; coachId?: number; startsAt?: string }): SlotTarget {
  return o.slotId !== undefined
    ? { slotId: o.slotId }
    : { coachId: o.coachId as number, startsAt: new Date(o.startsAt as string) }
}
