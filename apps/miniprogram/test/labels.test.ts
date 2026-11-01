import { describe, expect, it } from 'vitest'
import type { BookingDto, RefundDto } from '../miniprogram/lib/shared'
import { edgeWait } from '../miniprogram/utils/edge'
import {
  lessonTag,
  packageTag,
  refundBack,
  refundStatus,
  settled,
} from '../miniprogram/utils/labels'

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
    expect(refundStatus(refund({ status: 'succeeded' }), true)).toBe('已到店退还')
    expect(refundBack(refund({ status: 'succeeded' }), true)).toBe('款项已到店退还')
  })

  it('keeps the review states of a package refund request', () => {
    expect(refundStatus(refund({ status: 'requested' }), false)).toBe('待审核')
    expect(refundStatus(refund({ status: 'rejected' }), false)).toBe('未通过')
  })
})

describe('package tag', () => {
  const refunded = (r: Partial<RefundDto> | null, paidOffline = false) => ({
    status: 'refunded' as const,
    refund: r && refund(r),
    paidOffline,
  })

  it('says 已退款 only once the money is back', () => {
    expect(packageTag(refunded({ status: 'succeeded' }))).toEqual({ text: '已退款', settled: true })
    expect(packageTag(refunded({ status: 'succeeded', settledHow: 'offline' }))).toEqual({
      text: '已退还',
      settled: true,
    })
    expect(packageTag(refunded({ status: 'succeeded' }, true))).toEqual({
      text: '已到店退还',
      settled: true,
    })
  })

  it('says where an approved refund stands while it is under way', () => {
    const cases: [Partial<RefundDto>, boolean, string][] = [
      [{ status: 'pending' }, false, '退款中'],
      [{ status: 'processing' }, false, '退款中'],
      [{ status: 'processing', abnormal: true }, false, '退款处理中'],
      [{ status: 'failed' }, false, '退款处理中'],
      [{ status: 'pending' }, true, '待到店退还'],
    ]
    for (const [r, paidOffline, text] of cases) {
      expect(packageTag(refunded(r, paidOffline))).toEqual({ text, settled: false })
    }
  })

  it('keeps the package status otherwise', () => {
    expect(packageTag(refunded(null)).text).toBe('已退款')
    expect(
      packageTag({
        status: 'refund_requested',
        refund: refund({ status: 'requested' }),
        paidOffline: false,
      }).text,
    ).toBe('退款审核中')
    expect(
      packageTag({ status: 'active', refund: refund({ status: 'rejected' }), paidOffline: false })
        .text,
    ).toBe('使用中')
  })
})

describe('lesson tag', () => {
  const now = Date.parse('2026-10-29T02:00:00Z')
  const booking = (b: Partial<BookingDto>) =>
    ({
      status: 'pending_payment',
      payBy: null,
      attendance: null,
      disruption: null,
      ...b,
    }) as BookingDto

  it('reads an unpaid hold as 已失效 from its payment time on, before the sweep', () => {
    expect(lessonTag(booking({ payBy: '2026-10-29T02:01:00Z' }), now)).toEqual({
      status: '待支付',
      tone: 'warning',
    })
    expect(lessonTag(booking({ payBy: '2026-10-29T02:00:00Z' }), now)).toEqual({
      status: '已失效',
      tone: 'default',
    })
    // A lapsed hold the venue can no longer give is still just lapsed.
    expect(
      lessonTag(booking({ payBy: '2026-10-29T01:00:00Z', disruption: 'closed' }), now).status,
    ).toBe('已失效')
    expect(
      lessonTag(booking({ payBy: '2026-10-29T03:00:00Z', disruption: 'closed' }), now).status,
    ).toBe('场馆闭馆')
  })

  it('keeps booked lessons as they are', () => {
    expect(lessonTag(booking({ status: 'confirmed' }), now).status).toBe('已预约')
    expect(lessonTag(booking({ status: 'confirmed', attendance: 'attended' }), now).status).toBe(
      '已签到',
    )
  })
})

describe('settled', () => {
  const lesson = {
    status: 'confirmed',
    startsAt: '2026-10-29T02:00:00Z',
    endsAt: '2026-10-29T03:00:00Z',
    cancelDeadline: '2026-10-28T02:00:00Z',
    canCancel: true,
    canMove: true,
  } as BookingDto
  const at = (iso: string) => settled(lesson, Date.parse(iso))
  it('reads a booked lesson as the server would once it starts and ends', () => {
    expect(at('2026-10-28T02:00:00Z')).toBe(lesson)
    expect(at('2026-10-28T02:00:01Z')).toMatchObject({ canCancel: true, canMove: false })
    expect(at('2026-10-29T02:00:00Z')).toMatchObject({
      status: 'confirmed',
      canCancel: false,
      canMove: false,
    })
    expect(at('2026-10-29T03:00:00Z')).toMatchObject({
      status: 'completed',
      canCancel: false,
      canMove: false,
    })
  })
})

describe('lesson tag over time', () => {
  const lesson = {
    status: 'confirmed',
    startsAt: '2026-10-29T02:00:00Z',
    endsAt: '2026-10-29T03:00:00Z',
    attendance: null,
    disruption: null,
  } as BookingDto
  it('says 进行中 while a booked lesson is on, and 已完成 once it ends', () => {
    const tag = (iso: string) => lessonTag(lesson, Date.parse(iso)).status
    expect([
      tag('2026-10-29T01:59:00Z'),
      tag('2026-10-29T02:00:00Z'),
      tag('2026-10-29T03:00:00Z'),
    ]).toEqual(['已预约', '进行中', '已完成'])
  })
})

describe('edgeWait', () => {
  it('waits until just after the next instant still ahead', () => {
    expect(edgeWait([5_000, 2_000, 1_000], 1_500)).toBe(1_500)
    expect(edgeWait([1_000], 1_000)).toBeNull()
    expect(edgeWait([], 0)).toBeNull()
  })
  it('caps a long wait', () => {
    expect(edgeWait([30 * 3_600_000], 0)).toBe(6 * 3_600_000)
  })
})
