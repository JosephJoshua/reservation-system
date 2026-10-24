import { describe, expect, it } from 'vitest'
import { freeSeat, groupSettingsError, isGroup, minCheckDue, minCheckHours } from './groups'

const H = 3_600_000

describe('freeSeat', () => {
  it('takes the lowest free seat', () => {
    expect(freeSeat([], 1)).toBe(1)
    expect(freeSeat([1, 3], 4)).toBe(2)
    expect(freeSeat([2, 1], 3)).toBe(3)
  })
  it('is null when every seat is taken', () => {
    expect(freeSeat([1], 1)).toBeNull()
    expect(freeSeat([1, 2, 3], 3)).toBeNull()
  })
  it('ignores seats above a capacity that was lowered', () => {
    expect(freeSeat([5], 2)).toBe(1)
    expect(freeSeat([1, 2, 5], 2)).toBeNull()
  })
})

describe('groupSettingsError', () => {
  it('accepts private and group lesson types', () => {
    expect(groupSettingsError({ capacity: 1, minStudents: null, isTrial: true })).toBeNull()
    expect(groupSettingsError({ capacity: 6, minStudents: null, isTrial: false })).toBeNull()
    expect(groupSettingsError({ capacity: 6, minStudents: 2, isTrial: false })).toBeNull()
    expect(groupSettingsError({ capacity: 6, minStudents: 6, isTrial: false })).toBeNull()
  })
  it('refuses odd combinations', () => {
    expect(groupSettingsError({ capacity: 0, minStudents: null, isTrial: false })).toMatch(
      '人数上限',
    )
    expect(groupSettingsError({ capacity: 31, minStudents: null, isTrial: false })).toMatch(
      '人数上限',
    )
    expect(groupSettingsError({ capacity: 1, minStudents: 2, isTrial: false })).toMatch('一对一')
    expect(groupSettingsError({ capacity: 6, minStudents: 1, isTrial: false })).toMatch('开班人数')
    expect(groupSettingsError({ capacity: 6, minStudents: 7, isTrial: false })).toMatch('开班人数')
    expect(groupSettingsError({ capacity: 6, minStudents: null, isTrial: true })).toMatch('体验课')
  })
  it('tells group classes apart', () => {
    expect(isGroup({ capacity: 1 })).toBe(false)
    expect(isGroup({ capacity: 2 })).toBe(true)
  })
})

describe('minCheckDue', () => {
  const startsAt = new Date('2026-11-01T02:00:00Z')
  const rules = { cancelDeadlineHours: 12 }
  const createdAt = new Date(startsAt.getTime() - 48 * H)
  it('is due from the deadline until the start', () => {
    expect(minCheckDue({ startsAt, createdAt }, new Date(startsAt.getTime() - 13 * H), rules)).toBe(
      false,
    )
    expect(minCheckDue({ startsAt, createdAt }, new Date(startsAt.getTime() - 12 * H), rules)).toBe(
      true,
    )
    expect(minCheckDue({ startsAt, createdAt }, new Date(startsAt.getTime() - 1), rules)).toBe(true)
    expect(minCheckDue({ startsAt, createdAt }, startsAt, rules)).toBe(false)
  })
  it('skips a session scheduled after its deadline', () => {
    const late = new Date(startsAt.getTime() - 2 * H)
    expect(
      minCheckDue({ startsAt, createdAt: late }, new Date(startsAt.getTime() - H), rules),
    ).toBe(false)
  })
  it('checks an hour before the start when cancelling is free until the start', () => {
    const zero = { cancelDeadlineHours: 0 }
    expect(minCheckHours(zero)).toBe(1)
    expect(
      minCheckDue({ startsAt, createdAt }, new Date(startsAt.getTime() - 61 * 60_000), zero),
    ).toBe(false)
    expect(minCheckDue({ startsAt, createdAt }, new Date(startsAt.getTime() - H), zero)).toBe(true)
  })
})
