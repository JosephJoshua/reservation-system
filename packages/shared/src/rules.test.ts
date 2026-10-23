import { describe, expect, it } from 'vitest'
import { bookingWindowError, cancelDeadline, cancellationOutcome, validityEnd } from './rules'
import { defaultSettings, type VenueSettings } from './settings'

const rules = defaultSettings.booking
const at = (iso: string) => new Date(iso)

describe('bookingWindowError', () => {
  const now = at('2026-10-23T02:00:00Z') // 10:00 at the venue

  it('accepts a lesson within the window', () => {
    expect(bookingWindowError(at('2026-10-24T02:00:00Z'), now, rules)).toBeNull()
  })

  it('rejects lessons that started or start too soon', () => {
    expect(bookingWindowError(now, now, rules)).toBe('started')
    expect(bookingWindowError(at('2026-10-23T03:59:00Z'), now, rules)).toBe('too_soon')
    expect(bookingWindowError(at('2026-10-23T04:00:00Z'), now, rules)).toBeNull()
  })

  it('allows the whole venue day at the end of the window', () => {
    // 14 days from 2026-10-23 is 2026-11-06; its last minute at the venue is 15:59 UTC.
    expect(bookingWindowError(at('2026-11-06T15:59:00Z'), now, rules)).toBeNull()
    expect(bookingWindowError(at('2026-11-06T16:00:00Z'), now, rules)).toBe('too_far')
  })
})

describe('cancellationOutcome', () => {
  const startsAt = at('2026-10-25T02:00:00Z')
  const base = { startsAt, amountPaid: 20000, rules }

  it('refunds everything before the deadline', () => {
    const now = at('2026-10-24T01:59:00Z')
    expect(
      cancellationOutcome({ ...base, now, cancelledBy: 'student', paidWith: 'order' }),
    ).toEqual({ late: false, refund: 20000, returnLesson: false })
    expect(
      cancellationOutcome({ ...base, now, cancelledBy: 'student', paidWith: 'package' }),
    ).toEqual({ late: false, refund: 0, returnLesson: true })
  })

  it('forfeits after the deadline by default', () => {
    const now = at('2026-10-24T02:00:01Z')
    expect(
      cancellationOutcome({ ...base, now, cancelledBy: 'student', paidWith: 'order' }),
    ).toEqual({ late: true, refund: 0, returnLesson: false })
    expect(
      cancellationOutcome({ ...base, now, cancelledBy: 'student', paidWith: 'package' }),
    ).toEqual({ late: true, refund: 0, returnLesson: false })
  })

  it('applies a partial late refund, rounding down', () => {
    const partial: VenueSettings['booking'] = {
      ...rules,
      lateCancel: { kind: 'partial', percent: 33 },
    }
    const now = at('2026-10-24T12:00:00Z')
    const input = { ...base, rules: partial, now, cancelledBy: 'student' as const }
    expect(cancellationOutcome({ ...input, paidWith: 'order', amountPaid: 10001 })).toEqual({
      late: true,
      refund: 3300,
      returnLesson: false,
    })
    const full = { ...rules, lateCancel: { kind: 'partial' as const, percent: 100 } }
    expect(cancellationOutcome({ ...input, rules: full, paidWith: 'package' })).toEqual({
      late: true,
      refund: 0,
      returnLesson: true,
    })
  })

  it('stops students cancelling once the lesson started', () => {
    expect(
      cancellationOutcome({ ...base, now: startsAt, cancelledBy: 'student', paidWith: 'order' }),
    ).toBe('started')
  })

  it('always gives everything back when the venue cancels', () => {
    const now = at('2026-10-25T03:00:00Z')
    expect(cancellationOutcome({ ...base, now, cancelledBy: 'venue', paidWith: 'order' })).toEqual({
      late: false,
      refund: 20000,
      returnLesson: false,
    })
  })
})

describe('cancelDeadline', () => {
  it('is the configured hours before the start', () => {
    expect(cancelDeadline(at('2026-10-25T02:00:00Z'), rules).toISOString()).toBe(
      '2026-10-24T02:00:00.000Z',
    )
  })
})

describe('validityEnd', () => {
  it('runs to the end of the venue day', () => {
    // Bought 2026-10-23 23:30 at the venue; 30 days later is 2026-11-22, ending 16:00 UTC.
    expect(validityEnd(at('2026-10-23T15:30:00Z'), 30).toISOString()).toBe(
      '2026-11-22T16:00:00.000Z',
    )
  })
})
