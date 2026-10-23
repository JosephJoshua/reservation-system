import type { BookingDto, PackageDto, RefundStatus } from '@rs/shared'

export interface Coach {
  id: number
  name: string
  title: string
  bio: string
  avatarUrl: string
  active: boolean
  sort: number
  lessons: { lessonTypeId: number; price: number | null }[]
  /** Whether a WeChat user is linked; the coach mode of the mini program needs one. */
  bound: boolean
  bindCode: string | null
  bindCodeExpiresAt: string | null
}

export interface LessonType {
  id: number
  name: string
  description: string
  durationMinutes: number
  price: number
  isTrial: boolean
  adminOnly: boolean
  active: boolean
  salePercent: number | null
  saleStartsAt: string | null
  saleEndsAt: string | null
  sort: number
}

export interface PackageProduct {
  id: number
  name: string
  description: string
  lessonTypeId: number
  coachIds: number[]
  lessonCount: number
  price: number
  validityDays: number
  onSale: boolean
  salePrice: number | null
  saleStartsAt: string | null
  saleEndsAt: string | null
  sort: number
}

export interface Person {
  id: number
  name: string
  phone: string
}

export interface Slot {
  id: number
  coachId: number
  startsAt: string
  endsAt: string
  open: boolean
  /** `hours` slots come from the coach's weekly hours and come back if deleted. */
  source: 'manual' | 'hours'
  booking: { id: number; status: string; student: Person | null } | null
}

export type AdminBooking = BookingDto & { student: Person | null; coachNote: string }

export interface StudentDetail extends Person {
  tester: boolean
  createdAt: string
  packages: PackageDto[]
  bookings: BookingDto[]
}

export interface StudentRow extends Person {
  tester: boolean
  createdAt: string
}

export interface Order {
  id: number
  outTradeNo: string
  kind: 'class' | 'trial' | 'package'
  description: string
  amount: number
  provider: 'wechat' | 'offline'
  offlineMethod: 'cash' | 'alipay' | 'wechat' | 'transfer' | null
  status: 'pending' | 'paid' | 'closed'
  transactionId: string | null
  paidAt: string | null
  createdAt: string
  note: string
  student: Person
  refunded: number
}

export interface Refund {
  id: number
  outRefundNo: string
  amount: number
  reason: string
  status: RefundStatus
  failure: string | null
  createdAt: string
  updatedAt: string
  order: {
    id: number
    amount: number
    provider: 'wechat' | 'offline'
    kind: string
    description: string
  }
  student: Person
  package: PackageDto | null
}

export interface Banner {
  id: number
  imageUrl: string
  title: string
  linkKind: 'none' | 'package' | 'lesson_type'
  linkId: number | null
  startsAt: string | null
  endsAt: string | null
  active: boolean
  sort: number
}

export interface LedgerEntry {
  id: number
  delta: number
  kind: 'purchase' | 'use' | 'return' | 'grant' | 'extend' | 'refund'
  note: string
  actor: 'student' | 'admin' | 'system'
  createdAt: string
}
