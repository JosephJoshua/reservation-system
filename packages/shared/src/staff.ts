/** How the front desk took an offline payment. */
export const offlineMethodLabels = {
  cash: '现金',
  alipay: '支付宝',
  wechat: '微信收款码',
  transfer: '转账',
} as const

export type OfflineMethod = keyof typeof offlineMethodLabels

export const offlineMethods = Object.keys(offlineMethodLabels) as [
  OfflineMethod,
  ...OfflineMethod[],
]

/** What the action log records, with the name the admin app shows for each. */
export const staffActionLabels = {
  'booking.create': '代约',
  'booking.cancel': '场馆取消',
  'booking.move': '场馆改约',
  'booking.attendance': '修改签到',
  'session.create': '排小班课',
  'session.update': '修改小班课',
  'session.cancel': '取消小班课',
  'feedback.hide': '隐藏点评',
  'feedback.show': '恢复点评',
  'package.sell': '线下售课时包',
  'package.grant': '赠送课时',
  'package.extend': '延长有效期',
  'refund.approve': '同意退款',
  'refund.reject': '拒绝退款',
  'refund.retry': '重试退款',
  'refund.paid_back': '线下退还',
  'price.lesson_type': '课程价格',
  'price.product': '课时包价格',
  'price.coach': '教练价格',
  'price.coach_pay': '课时费',
  'pay.confirm': '确认课时费',
  'pay.unconfirm': '撤销课时费确认',
  'invoice.issue': '开票',
  'invoice.reject': '拒绝开票',
  'invoice.refund_seen': '开票后退款已处理',
  'data.export': '导出数据',
  'settings.update': '修改设置',
  'student.create': '前台建档',
  'student.update': '修改学员',
  'student.delete': '删除学员',
  'staff.create': '新增员工',
  'staff.update': '修改员工',
  'staff.password': '修改密码',
  'staff.roles': '修改角色',
} as const

export type StaffAction = keyof typeof staffActionLabels

export const staffActions = Object.keys(staffActionLabels) as [StaffAction, ...StaffAction[]]

export interface ActionLogEntryDto {
  id: number
  action: StaffAction
  summary: string
  amount: number | null
  targetKind: string | null
  targetId: number | null
  createdAt: string
  staff: { id: number; name: string }
  student: { id: number; name: string; phone: string } | null
}

export interface StaffDto {
  id: number
  name: string
  username: string
  roles: StaffRole[]
  active: boolean
  createdAt: string
}

/**
 * Admin app roles. A login holds one or more; what it may do is the union of their permissions.
 * 管理员 can do everything, including managing staff.
 */
export const staffRoleLabels = {
  admin: '管理员',
  front_desk: '前台',
  finance: '财务',
} as const

export type StaffRole = keyof typeof staffRoleLabels

export const staffRoles = Object.keys(staffRoleLabels) as [StaffRole, ...StaffRole[]]

export const staffRoleHelp: Record<StaffRole, string> = {
  admin: '全部功能，包括员工、设置和价格',
  front_desk: '排课、代约、签到、学员和线下售课时包',
  finance: '订单、退款、发票、报表和导出',
}

/**
 * What a route or button needs. `view` is reading bookings, students and the catalog;
 * `bookings` is 代约, cancelling, moving and 排课; `students` is editing students and selling
 * packages at the desk; `finance` is orders, refunds, invoices, reports and exports; `manage` is
 * settings, prices, the catalog, staff and the action log.
 */
export type StaffPermission = 'view' | 'bookings' | 'attendance' | 'students' | 'finance' | 'manage'

const rolePermissions: Record<StaffRole, readonly StaffPermission[]> = {
  admin: ['view', 'bookings', 'attendance', 'students', 'finance', 'manage'],
  front_desk: ['view', 'bookings', 'attendance', 'students'],
  finance: ['view', 'finance'],
}

export function can(roles: readonly StaffRole[], permission: StaffPermission) {
  return roles.some((r) => rolePermissions[r]?.includes(permission))
}

/** What each admin page needs to appear in the menu, keyed by the page's hash route. */
export const pagePermissions = {
  overview: 'view',
  schedule: 'bookings',
  checkin: 'attendance',
  bookings: 'view',
  students: 'view',
  feedback: 'bookings',
  catalog: 'manage',
  products: 'manage',
  orders: 'finance',
  refunds: 'finance',
  invoices: 'finance',
  reports: 'finance',
  banners: 'manage',
  settings: 'manage',
  staff: 'manage',
  actions: 'manage',
} as const satisfies Record<string, StaffPermission>

/** A page not listed above is for 管理员 only, until it is given a permission there. */
export function canOpenPage(roles: readonly StaffRole[], page: string) {
  const need = (pagePermissions as Record<string, StaffPermission | undefined>)[page]
  return can(roles, need ?? 'manage')
}
