import { describe, expect, it } from 'vitest'
import type { RefundDto } from '../miniprogram/lib/shared'
import { refundBack, refundStatus } from '../miniprogram/utils/labels'

const refund = (r: Partial<RefundDto>): RefundDto => ({
  amount: 8000,
  status: 'pending',
  settledHow: null,
  abnormal: false,
  ...r,
})

describe('refund wording', () => {
  it('says how WeChat Pay refunds stand, row and sentence alike', () => {
    const cases: [Partial<RefundDto>, string, string][] = [
      [{ status: 'pending' }, '退款中', '款项将原路退回'],
      [{ status: 'processing' }, '退款中', '款项将原路退回'],
      [{ status: 'processing', abnormal: true }, '退款处理中', '退款处理中'],
      [{ status: 'failed' }, '退款处理中', '退款处理中'],
      [{ status: 'succeeded' }, '已退款', '款项已原路退回'],
      [{ status: 'succeeded', settledHow: 'platform' }, '已退款', '款项已原路退回'],
      [{ status: 'succeeded', settledHow: 'offline' }, '已退还', '款项已退还'],
    ]
    for (const [r, row, sentence] of cases) {
      expect([refundStatus(refund(r), false), refundBack(refund(r), false)]).toEqual([
        row,
        sentence,
      ])
    }
  })

  it('says money paid at the front desk is handed back there', () => {
    expect(refundStatus(refund({ status: 'pending' }), true)).toBe('待到店退还')
    expect(refundBack(refund({ status: 'pending' }), true)).toBe('款项将到店退还')
    expect(refundStatus(refund({ status: 'succeeded' }), true)).toBe('已退款')
    expect(refundBack(refund({ status: 'succeeded' }), true)).toBe('款项已到店退还')
  })

  it('keeps the review states of a package refund request', () => {
    expect(refundStatus(refund({ status: 'requested' }), false)).toBe('待审核')
    expect(refundStatus(refund({ status: 'rejected' }), false)).toBe('未通过')
  })
})
