import type { BookingStatus, Disruption, PackageStatus, RefundStatus } from '../lib/shared'

export const REFUND_STATUS: Record<RefundStatus, string> = {
  requested: '待审核',
  pending: '退款中',
  processing: '退款中',
  succeeded: '已退款',
  // Failed refunds are retried by the venue, so the student still sees them as in progress.
  failed: '退款中',
  rejected: '未通过',
}

/** A refund's status for the student. Money paid at the front desk is handed back there. */
export function refundStatus(status: RefundStatus, paidOffline: boolean): string {
  return paidOffline && REFUND_STATUS[status] === '退款中' ? '待到店退还' : REFUND_STATUS[status]
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
