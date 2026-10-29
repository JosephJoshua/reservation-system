import { describe, expect, it } from 'vitest'
import { ApiError, refreshAfter } from '../miniprogram/utils/api'
import { bookableDays } from '../miniprogram/utils/format'
import { moveFailure } from '../miniprogram/utils/move'

describe('bookableDays', () => {
  it('starts on the venue day of the time given, not the phone clock', () => {
    // 23:30 on Oct 29 in Shanghai, while the phone may say anything.
    const days = bookableDays(2, Date.parse('2026-10-29T15:30:00Z'))
    expect(days.map((d) => d.key)).toEqual(['2026-10-29', '2026-10-30', '2026-10-31'])
    expect(days.map((d) => d.label)).toEqual(['今天', '明天', '后天'])
  })

  it('labels days against the time given, past venue midnight too', () => {
    const days = bookableDays(3, Date.parse('2026-10-29T16:30:00Z'))
    expect(days[0]).toEqual({ key: '2026-10-30', label: '今天', date: '10/30' })
    expect(days[3]?.label).toBe('周一')
  })
})

describe('moveFailure', () => {
  it('treats a lost or still running move as maybe moved', () => {
    expect(moveFailure(0, 'result_unknown')).toBe('unknown')
    expect(moveFailure(0, 'network')).toBe('unknown')
    expect(moveFailure(409, 'in_progress')).toBe('unknown')
  })

  it('tells a fixed lesson, a refused time and a gone time apart', () => {
    expect(moveFailure(409, 'move_deadline')).toBe('fixed')
    expect(moveFailure(404, 'not_found')).toBe('fixed')
    expect(moveFailure(409, 'student_clash')).toBe('refused')
    expect(moveFailure(409, 'slot_taken')).toBe('gone')
    expect(moveFailure(404, 'slot_not_found')).toBe('gone')
    expect(moveFailure(500, 'http_error')).toBe('failed')
    expect(moveFailure(400, 'invalid')).toBe('failed')
  })
})

describe('refreshAfter', () => {
  it('reloads after a refusal for how things stand, or a lost answer', () => {
    expect(refreshAfter(new ApiError(409, 'refund_open', ''))).toBe(true)
    expect(refreshAfter(new ApiError(403, 'coach_marks_off', ''))).toBe(true)
    expect(refreshAfter(new ApiError(404, 'not_found', ''))).toBe(true)
    expect(refreshAfter(new ApiError(0, 'result_unknown', ''))).toBe(true)
  })

  it('does not reload after a bad request or a server error', () => {
    expect(refreshAfter(new ApiError(400, 'invalid', ''))).toBe(false)
    expect(refreshAfter(new ApiError(500, 'http_error', ''))).toBe(false)
    expect(refreshAfter(new Error('x'))).toBe(false)
  })
})
