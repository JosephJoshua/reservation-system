import { describe, expect, it } from 'vitest'
import { fmtLastDay, yuan } from './format'

describe('yuan', () => {
  it('groups thousands and shows cents only when there are any, always two of them', () => {
    expect(yuan(964_000)).toBe('¥9,640')
    expect(yuan(964_010)).toBe('¥9,640.10')
    expect(yuan(1_300_010)).toBe('¥13,000.10')
    expect(yuan(5)).toBe('¥0.05')
    expect(yuan(0)).toBe('¥0')
    expect(yuan(-2_000)).toBe('¥-20')
  })
})

describe('fmtLastDay', () => {
  it('gives the last venue day an exclusive end covers', () => {
    // 2026-11-08 00:00 at the venue (UTC+8) ends the 7th.
    expect(fmtLastDay('2026-11-07T16:00:00.000Z')).toBe('2026-11-07')
    // 18:00 on the 8th still covers the 8th.
    expect(fmtLastDay('2026-11-08T10:00:00.000Z')).toBe('2026-11-08')
  })
})
