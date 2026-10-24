import { describe, expect, it } from 'vitest'
import { bucketOf, daysBetween, statsBuckets, statsGrain } from './stats'

describe('statsGrain', () => {
  it('uses days up to a month, weeks up to half a year, then months', () => {
    expect(statsGrain('2026-10-01', '2026-10-31')).toBe('day')
    expect(statsGrain('2026-10-01', '2026-11-01')).toBe('week')
    expect(statsGrain('2026-05-01', '2026-10-30')).toBe('week')
    expect(statsGrain('2026-01-01', '2026-12-31')).toBe('month')
  })
})

describe('statsBuckets', () => {
  it('cuts a range into days', () => {
    const b = statsBuckets('2026-10-30', '2026-11-02')
    expect(b.map((x) => x.label)).toEqual(['10/30', '10/31', '11/1', '11/2'])
    expect(b[3]).toEqual({ from: '2026-11-02', to: '2026-11-03', label: '11/2' })
  })

  it('starts weeks on Monday and cuts the first and last week to the range', () => {
    // 2026-10-01 is a Thursday.
    const b = statsBuckets('2026-10-01', '2026-11-04')
    expect(b[0]).toEqual({ from: '2026-10-01', to: '2026-10-05', label: '10/1' })
    expect(b[1]).toEqual({ from: '2026-10-05', to: '2026-10-12', label: '10/5' })
    expect(b.at(-1)).toEqual({ from: '2026-11-02', to: '2026-11-05', label: '11/2' })
  })

  it('cuts long ranges into months and shows the year where it changes', () => {
    const b = statsBuckets('2025-11-15', '2026-10-24')
    expect(b.map((x) => x.label)).toEqual([
      '2025年11月',
      '12月',
      '2026年1月',
      '2月',
      '3月',
      '4月',
      '5月',
      '6月',
      '7月',
      '8月',
      '9月',
      '10月',
    ])
    expect(b[0]?.from).toBe('2025-11-15')
    expect(b.at(-1)?.to).toBe('2026-10-25')
  })

  it('covers every day exactly once', () => {
    const b = statsBuckets('2026-02-20', '2026-09-03')
    expect(b[0]?.from).toBe('2026-02-20')
    for (let i = 1; i < b.length; i++) expect(b[i]?.from).toBe(b[i - 1]?.to)
    expect(daysBetween('2026-02-20', '2026-09-03')).toBe(196)
  })
})

describe('bucketOf', () => {
  it('finds the bucket of a date', () => {
    const b = statsBuckets('2026-10-01', '2026-11-04')
    expect(bucketOf(b, '2026-10-01')).toBe(0)
    expect(bucketOf(b, '2026-10-05')).toBe(1)
    expect(bucketOf(b, '2026-11-04')).toBe(b.length - 1)
    expect(bucketOf(b, '2026-09-30')).toBe(-1)
    expect(bucketOf(b, '2026-11-05')).toBe(-1)
  })
})
