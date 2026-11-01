import { describe, expect, it } from 'vitest'
import { cancelDoneMessage, sessionCancelDoneMessage } from './labels'

describe('cancel messages', () => {
  it('tells the desk what is left to do after a booking cancel', () => {
    expect(cancelDoneMessage({ refunded: 8000, offline: false, refundFailed: false })).toBe(
      '已取消，¥80 将原路退回',
    )
    expect(cancelDoneMessage({ refunded: 8000, offline: true })).toBe('已取消，请当面退还学员 ¥80')
    expect(cancelDoneMessage({ refunded: 8000, offline: false, refundFailed: true })).toBe(
      '已取消，¥80 退款未成功，需财务在退款页处理',
    )
    expect(cancelDoneMessage({ refunded: null, lessonReturned: true })).toBe('已取消，课时已退回')
    expect(cancelDoneMessage(undefined)).toBe('已取消')
  })

  it('adds up a whole session', () => {
    expect(
      sessionCancelDoneMessage({ refunded: 16000, offline: 8000, failed: 0, lessonsReturned: 2 }),
    ).toBe('已取消整节，¥160 将原路退回，请当面退还 ¥80，退回课时 2 节')
    expect(sessionCancelDoneMessage({ refunded: 0, offline: 0, failed: 8000 })).toBe(
      '已取消整节，¥80 退款未成功，需财务在退款页处理',
    )
    expect(sessionCancelDoneMessage({ cancelled: 0 })).toBe('已取消整节')
  })
})
