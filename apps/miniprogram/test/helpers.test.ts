import { describe, expect, it } from 'vitest'
import { ApiError, refreshAfter } from '../miniprogram/utils/api'
import { lateBookingText, needsAgreement } from '../miniprogram/utils/data'
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

describe('needsAgreement', () => {
  it('tells a refusal for want of consent from other errors', () => {
    expect(needsAgreement(new ApiError(409, 'policy_changed', ''))).toBe(true)
    expect(needsAgreement(new ApiError(403, 'consent_required', ''))).toBe(true)
    expect(needsAgreement(new ApiError(403, 'coach_marks_off', ''))).toBe(false)
    expect(needsAgreement(new Error('policy_changed'))).toBe(false)
  })
})

describe('refreshAfter', () => {
  it('reloads after a refusal for how things stand', () => {
    expect(refreshAfter(new ApiError(409, 'refund_open', ''))).toBe(true)
    expect(refreshAfter(new ApiError(403, 'coach_marks_off', ''))).toBe(true)
    expect(refreshAfter(new ApiError(404, 'not_found', ''))).toBe(true)
  })

  it('does not reload after a lost answer, a bad request or a server error', () => {
    expect(refreshAfter(new ApiError(0, 'result_unknown', ''))).toBe(false)
    expect(refreshAfter(new ApiError(0, 'network', ''))).toBe(false)
    expect(refreshAfter(new ApiError(400, 'invalid', ''))).toBe(false)
    expect(refreshAfter(new ApiError(500, 'http_error', ''))).toBe(false)
    expect(refreshAfter(new Error('x'))).toBe(false)
  })
})

describe('lateBookingText', () => {
  const start = '2026-10-30T10:00:00Z'
  const at = (iso: string) => Date.parse(iso)
  it('says what a cancel would lose when booked inside the free-cancel window', () => {
    const late = at('2026-10-30T08:00:00Z')
    expect(lateBookingText(start, 24, { kind: 'forfeit' }, late, 'wechat')).toBe(
      '距开课已不足 24 小时，预约后再取消不退费用。',
    )
    expect(lateBookingText(start, 24, { kind: 'partial', percent: 50 }, late, 'wechat')).toBe(
      '距开课已不足 24 小时，预约后再取消只退还 50% 的费用。',
    )
    // A package lesson comes back only at 100%, so a partial rule loses the lesson.
    expect(lateBookingText(start, 24, { kind: 'partial', percent: 50 }, late, 'package')).toBe(
      '距开课已不足 24 小时，预约后再取消不退课时。',
    )
  })
  it('says nothing when it is not late yet, or a late cancel still refunds in full', () => {
    expect(
      lateBookingText(start, 24, { kind: 'forfeit' }, at('2026-10-29T09:00:00Z'), 'wechat'),
    ).toBe('')
    expect(
      lateBookingText(
        start,
        24,
        { kind: 'partial', percent: 100 },
        at('2026-10-30T08:00:00Z'),
        'wechat',
      ),
    ).toBe('')
    expect(
      lateBookingText(start, 0, { kind: 'forfeit' }, at('2026-10-30T08:00:00Z'), 'wechat'),
    ).toBe('')
  })
})
