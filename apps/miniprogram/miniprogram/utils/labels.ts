import type {
  BookingDto,
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

type RefundState = Pick<RefundDto, 'status' | 'settledHow' | 'abnormal' | 'rejectReason'>

/** WeChat Pay could not pay it back (failed, or 退款异常): the venue retries it or pays another way. */
function stuck(refund: RefundState): boolean {
  return refund.status === 'failed' || (refund.status === 'processing' && refund.abnormal)
}

/**
 * A refund's status for the student. Money paid at the front desk is handed back there (待到店退还,
 * then 已到店退还); one staff paid back another way (线下另付) after WeChat Pay could not is 已退还,
 * not 已退款 to where it came from; one WeChat Pay could not pay back is 退款处理中 until staff
 * sort it out. One turned down says why.
 */
export function refundStatus(refund: RefundState, paidOffline: boolean): string {
  const text = REFUND_STATUS[refund.status]
  if (paidOffline && text === '退款中') return '待到店退还'
  if (paidOffline && refund.status === 'succeeded') return '已到店退还'
  if (refund.status === 'succeeded' && refund.settledHow === 'offline') return '已退还'
  if (stuck(refund)) return '退款处理中'
  // Turned down: with the venue's reason, so the student knows why.
  if (refund.status === 'rejected' && refund.rejectReason) return `${text}：${refund.rejectReason}`
  return text
}

/**
 * Where the money of a refund stands, said after why it was refunded, in words that hold for how
 * it is paid back: at the front desk, by WeChat Pay, or by staff another way (线下另付).
 */
export function refundBack(refund: RefundState, paidOffline: boolean): string {
  if (paidOffline) return refund.status === 'succeeded' ? '款项已到店退还' : '款项将到店退还'
  if (refund.status === 'succeeded') {
    return refund.settledHow === 'offline' ? '款项已退还' : '款项已原路退回'
  }
  return stuck(refund) ? '退款处理中' : '款项将原路退回'
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

/**
 * A package's status tag. A refunded one says where its money stands, as its refund row does, so
 * it reads 已退款 (or 已退还, 已到店退还) only once the money is back.
 */
export function packageTag(p: {
  status: PackageStatus
  refund: RefundState | null
  paidOffline: boolean
}): { text: string; settled: boolean } {
  const refund = p.refund
  if (p.status !== 'refunded' || !refund || refund.status === 'rejected') {
    return { text: PACKAGE_STATUS[p.status], settled: true }
  }
  return {
    text: refundStatus(refund, p.paidOffline),
    settled: refund.status === 'succeeded',
  }
}

/**
 * A booking as the server would answer now, for one fetched a while ago: unpaid holds read as
 * expired from payBy on (the server sweeps them a little after), a booked lesson can no longer
 * be moved after its free-cancel deadline, nor cancelled or moved once it starts, and it reads
 * as completed once it ends.
 */
export function settled(b: BookingDto, now: number): BookingDto {
  if (b.status === 'pending_payment' && b.payBy && Date.parse(b.payBy) <= now) {
    return { ...b, status: 'expired', canCancel: false }
  }
  if (b.status === 'confirmed' && Date.parse(b.startsAt) <= now) {
    const ended = Date.parse(b.endsAt) <= now
    return {
      ...b,
      status: ended ? 'completed' : 'confirmed',
      canCancel: false,
      canMove: false,
      canCheckIn: ended ? false : b.canCheckIn,
    }
  }
  if (b.status === 'confirmed' && b.canMove && Date.parse(b.cancelDeadline) < now) {
    return { ...b, canMove: false }
  }
  return b
}

/** A lesson's tag on the 课程 list, with the attendance once it is marked. */
export function lessonTag(
  booking: BookingDto,
  now: number,
): { status: string; tone: 'primary' | 'warning' | 'success' | 'danger' | 'default' } {
  const b = settled(booking, now)
  if (b.attendance === 'attended') {
    return { status: b.status === 'confirmed' ? '已签到' : '已到课', tone: 'success' }
  }
  if (b.attendance === 'no_show') return { status: '缺席', tone: 'danger' }
  // The venue cannot give it as booked: said on the list, so nobody travels to it.
  if (b.disruption && (b.status === 'confirmed' || b.status === 'pending_payment')) {
    return { status: DISRUPTION_TAG[b.disruption], tone: 'warning' }
  }
  // On now, as 预约详情 says.
  if (b.status === 'confirmed' && Date.parse(b.startsAt) <= now) {
    return { status: '进行中', tone: 'primary' }
  }
  return {
    status: BOOKING_STATUS[b.status],
    tone:
      b.status === 'pending_payment' ? 'warning' : b.status === 'confirmed' ? 'primary' : 'default',
  }
}
