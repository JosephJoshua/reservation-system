import type {
  Attendance,
  BookingDto,
  BookingStatus,
  PackageDto,
  RefundStatus,
  StudentProfileDto,
} from '@rs/shared'

export interface CoachCategory {
  id: number
  name: string
  sort: number
  /** Prices for some lesson types; the rest use the lesson type's own price. */
  prices: { lessonTypeId: number; price: number }[]
  /** What a coach in the category is paid per lesson, for the lesson types that have a rate. */
  payRates: { lessonTypeId: number; rate: number }[]
}

export interface Coach {
  id: number
  name: string
  categoryId: number | null
  title: string
  tags: string[]
  /** HTML from the rich text editor, cleaned by the API. */
  profile: string
  avatarUrl: string
  active: boolean
  sort: number
  lessonTypeIds: number[]
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
  /** Students per session; more than 1 makes it a group class (小班课). */
  capacity: number
  /** A session short of this many at the free-cancel deadline is called off. */
  minStudents: number | null
  /** A group session uses one table per this many students; null is one for the class. */
  studentsPerTable: number | null
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
  /** Set for a group session: the class it teaches, to `capacity` students. */
  lessonTypeId: number | null
  capacity: number
  cancelledAt: string | null
  cancelReason: string | null
  /** Every table is in use at some moment of it, so it cannot take a new lesson. */
  tableFull: boolean
  /** The one lesson in a private slot; null in a group session. */
  booking: SlotBooking | null
  /** Every live booking, the students of a group session. */
  bookings: SlotBooking[]
}

export interface SlotBooking {
  id: number
  status: BookingStatus
  attendance: Attendance | null
  student: Person | null
}

export type AdminBooking = BookingDto & {
  student: Person | null
  coachNote: string
  /** Set when the front desk booked it for the student. */
  bookedBy: { id: number; name: string } | null
}

export interface StudentDetail extends Person {
  tester: boolean
  deletedAt: string | null
  createdAt: string
  profile: StudentProfileDto
  packages: PackageDto[]
  bookings: BookingDto[]
}

export interface StudentRow extends Person {
  tester: boolean
  deletedAt: string | null
  createdAt: string
  /** With the 即将到期 filter: the student's package that expires first with lessons left. */
  expiring?: {
    packageId: number
    name: string
    lessonsRemaining: number
    expiresAt: string
    /** The 7-day expiry message for it: sent, or refused as the student had not allowed it. */
    notice: 'sent' | 'refused' | null
    /** How many more of the student's packages expire soon. */
    more: number
  }
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
  /** A live invoice on the order, which a refund makes wrong. */
  invoiceStatus: 'requested' | 'issued' | null
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

export type {
  ActionLogEntryDto as ActionLogEntry,
  AdminInvoiceDto as AdminInvoice,
  StaffDto as Staff,
} from '@rs/shared'
