import type { BookingStatus, PackageStatus, RefundStatus } from '@rs/shared'

type Theme = 'default' | 'primary' | 'warning' | 'danger' | 'success'

export const bookingStatusLabel: Record<BookingStatus, [string, Theme]> = {
  pending_payment: ['待支付', 'warning'],
  confirmed: ['已预约', 'primary'],
  completed: ['已完成', 'success'],
  cancelled: ['已取消', 'default'],
  expired: ['已超时', 'default'],
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

export const orderStatusLabel = {
  pending: ['待支付', 'warning'],
  paid: ['已支付', 'success'],
  closed: ['已关闭', 'default'],
} as const satisfies Record<string, [string, Theme]>

export const orderKindLabel = { class: '单次课', trial: '体验课', package: '课时包' } as const

export { offlineMethodLabels as offlineMethodLabel } from '@rs/shared'

export const ledgerKindLabel = {
  purchase: '购买',
  use: '预约使用',
  return: '取消退回',
  grant: '赠送',
  extend: '延期',
  refund: '退款',
} as const
