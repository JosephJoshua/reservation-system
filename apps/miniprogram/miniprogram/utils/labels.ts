import type {
  BookingStatus,
  Disruption,
  PackageStatus,
  RefundDto,
  RefundStatus,
} from '../lib/shared'

export const REFUND_STATUS: Record<RefundStatus, string> = {
  requested: '待审核',
  pending: '退款中',
  processing: '退款中',
  succeeded: '已退款',
  // Failed refunds are retried by the venue, so the student still sees them as in progress.
  failed: '退款中',
  rejected: '未通过',
}

/**
 * A refund's status for the student. Money paid at the front desk is handed back there; one staff
 * paid back another way (线下另付) after WeChat Pay could not is 已退还, not 已退款 to where it came
 * from.
 */
export function refundStatus(
  refund: Pick<RefundDto, 'status' | 'settledHow'>,
  paidOffline: boolean,
): string {
  const text = REFUND_STATUS[refund.status]
  if (paidOffline && text === '退款中') return '待到店退还'
  if (refund.status === 'succeeded' && refund.settledHow === 'offline') return '已退还'
  return text
}

export const BOOKING_STATUS: Record<BookingStatus, string> = {
  pending_payment: '待支付',
  confirmed: '已预约',
  completed: '已完成',
  cancelled: '已取消',
  expired: '已失效',
}

/** A booked lesson's tag when the venue cannot give it as booked, short for 闭馆, 请假 and 停课. */
export const DISRUPTION_TAG: Record<Disruption, string> = {
  closed: '场馆闭馆',
  off: '教练请假',
  inactive: '教练停课',
}

export const PACKAGE_STATUS: Record<PackageStatus, string> = {
  active: '使用中',
  expired: '已过期',
  used_up: '已用完',
  refund_requested: '退款审核中',
  refunded: '已退款',
}
