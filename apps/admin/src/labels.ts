import type { BookingStatus, Disruption, PackageStatus, RefundStatus } from '@rs/shared'
import { yuan } from './format'

type Theme = 'default' | 'primary' | 'warning' | 'danger' | 'success'

export const bookingStatusLabel: Record<BookingStatus, [string, Theme]> = {
  pending_payment: ['待支付', 'warning'],
  confirmed: ['已预约', 'primary'],
  completed: ['已完成', 'success'],
  cancelled: ['已取消', 'default'],
  expired: ['已超时', 'default'],
}

/** A lesson the venue could not give as booked, short for 闭馆, 请假 and 停课. */
export const disruptionLabel: Record<Disruption, string> = {
  closed: '场馆闭馆',
  off: '教练请假',
  inactive: '教练停课',
}

export const packageStatusLabel: Record<PackageStatus, [string, Theme]> = {
  active: ['使用中', 'success'],
  expired: ['已过期', 'default'],
  used_up: ['已用完', 'default'],
  refund_requested: ['退款审核中', 'warning'],
  refunded: ['已退款', 'default'],
}

export const refundStatusLabel: Record<RefundStatus, [string, Theme]> = {
  requested: ['待审核', 'warning'],
  pending: ['退款中', 'primary'],
  processing: ['退款中', 'primary'],
  succeeded: ['已退款', 'success'],
  failed: ['退款失败', 'danger'],
  rejected: ['已拒绝', 'default'],
}

/** Why a payment was not applied. */
export const orderAnomalyLabel = {
  amount_mismatch: '实付金额与订单不符，未确认',
  refunded: '付款已在微信支付退回，未确认',
} as const

export const orderStatusLabel = {
  pending: ['待支付', 'warning'],
  paid: ['已支付', 'success'],
  closed: ['已关闭', 'default'],
} as const satisfies Record<string, [string, Theme]>

export { offlineMethodLabels as offlineMethodLabel } from '@rs/shared'

export const ledgerKindLabel = {
  purchase: '购买',
  use: '预约使用',
  return: '取消退回',
  grant: '赠送',
  extend: '延期',
  refund: '退款',
} as const

/** A refund's status, where an offline one waits for the front desk to hand the money back. */
export function refundLabel(status: RefundStatus, offline: boolean): [string, Theme] {
  return offline && status === 'pending' ? ['待线下退还', 'warning'] : refundStatusLabel[status]
}

/**
 * What 取消整节 does to the students booked, for its confirm: those who paid are refunded or get
 * the lesson back, and those still to pay have their hold closed.
 */
export function callOffEffect(statuses: BookingStatus[]) {
  const unpaid = statuses.filter((s) => s === 'pending_payment').length
  const paid = statuses.length - unpaid
  if (!unpaid) return `${paid} 位学员都会收到全额退款或退回课时`
  if (!paid) return `${unpaid} 位学员尚未付款，其预约将关闭`
  return `${paid} 位已付款学员会收到全额退款或退回课时，${unpaid} 位未付款学员的预约将关闭`
}

/** The confirm button for cancelling these bookings: it says 退款 only when someone has paid. */
export function cancelConfirmLabel(statuses: BookingStatus[]) {
  return statuses.some((s) => s !== 'pending_payment') ? '确认取消并退款' : '确认取消'
}

/** What a venue cancel answers: what became of the money, as it stood when it was cancelled. */
export type CancelResult = { refunded: number | null; offline: boolean; lessonReturned: boolean }

/** What a cancelled single booking tells the desk, from what the cancel answered. */
export function cancelDoneMessage(result: unknown) {
  const r = result as Partial<CancelResult> | undefined
  if (r?.refunded != null) {
    return r.offline
      ? `已取消，请当面退还学员 ${yuan(r.refunded)}`
      : `已取消，${yuan(r.refunded)} 将原路退回`
  }
  return r?.lessonReturned ? '已取消，课时已退回' : '已取消'
}

/** 支付方式 as the 订单 and 退款 filters offer it. */
export const providerOptions = [
  { label: '微信支付', value: 'wechat' },
  { label: '前台付款', value: 'offline' },
]
