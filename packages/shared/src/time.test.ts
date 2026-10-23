import { describe, expect, it } from 'vitest'
import { venueDateKey, venueInstant } from './time'

describe('venueDateKey', () => {
  it('uses the venue date, not the UTC date', () => {
    expect(venueDateKey(new Date('2026-10-23T15:59:59Z'))).toBe('2026-10-23')
    expect(venueDateKey(new Date('2026-10-23T16:00:00Z'))).toBe('2026-10-24')
  })
})

describe('venueInstant', () => {
  it('converts venue-local time to an instant', () => {
    expect(venueInstant('2026-10-24', 0).toISOString()).toBe('2026-10-23T16:00:00.000Z')
    expect(venueInstant('2026-10-24', 15 * 60).toISOString()).toBe('2026-10-24T07:00:00.000Z')
  })

  it('round-trips with venueDateKey', () => {
    expect(venueDateKey(venueInstant('2026-12-31', 23 * 60 + 59))).toBe('2026-12-31')
  })

  it('rejects malformed dates', () => {
    expect(() => venueInstant('2026-13-01', 0)).toThrow(RangeError)
    expect(() => venueInstant('2026-02-30', 0)).toThrow(RangeError)
    expect(() => venueInstant('2026-2-3', 0)).toThrow(RangeError)
    expect(venueInstant('2028-02-29', 0).toISOString()).toBe('2028-02-28T16:00:00.000Z')
  })
})
