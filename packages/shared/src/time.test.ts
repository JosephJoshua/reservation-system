import { describe, expect, it } from 'vitest'
import { instantString } from './api'
import { venueDateKey, venueInstant } from './time'

describe('instantString', () => {
  it('takes venue dates in 2000-2999 only', () => {
    const ok = (s: string) => instantString.safeParse(s).success
    expect(ok('2026-10-26T02:00:00Z')).toBe(true)
    expect(ok('2026-10-26T10:00:00+08:00')).toBe(true)
    expect(ok('1999-12-31T16:00:00Z')).toBe(true) // 2000-01-01 00:00 at the venue
    expect(ok('1999-12-31T15:59:59Z')).toBe(false)
    expect(ok('2999-12-31T15:59:59Z')).toBe(true)
    expect(ok('2999-12-31T16:00:00Z')).toBe(false)
    for (const s of [
      '9999-12-31T20:00:00Z',
      '0000-01-01T00:00:00Z',
      '1970-01-01T00:00:00Z',
      '2026-10-26',
    ]) {
      expect(ok(s), s).toBe(false)
    }
  })
})

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
