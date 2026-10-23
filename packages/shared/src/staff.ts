/** What the action log records, with the name the admin app shows for each. */
export const staffActionLabels = {
  'booking.create': '代约',
  'booking.cancel': '场馆取消',
  'booking.attendance': '修改签到',
  'package.sell': '线下售课时包',
  'package.grant': '赠送课时',
  'package.extend': '延长有效期',
  'refund.approve': '同意退款',
  'refund.reject': '拒绝退款',
  'refund.retry': '重试退款',
  'price.lesson_type': '课程价格',
  'price.product': '课时包价格',
  'price.coach': '教练价格',
  'settings.update': '修改设置',
  'student.update': '修改学员',
  'staff.create': '新增员工',
  'staff.update': '修改员工',
  'staff.password': '修改密码',
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
  active: boolean
  createdAt: string
}
