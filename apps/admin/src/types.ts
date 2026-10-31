import type {
  Attendance,
  BookingDto,
  BookingStatus,
  Disruption,
  FeedbackItemDto,
  LinkKind,
  PackageDto,
  RefundSettleWay,
  RefundStatus,
  RuleOverrides,
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
  /** Its own booking rules; a rule left out follows the venue's. */
  rules: RuleOverrides
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
  /** Whether a group session takes new students. */
  open: boolean
  /** Set for a group session: the class it teaches, to `capacity` students. */
  lessonTypeId: number | null
  capacity: number
  cancelledAt: string | null
  cancelReason: string | null
  /** Every table is in use at some moment of it, so it cannot take a new lesson. */
  tableFull: boolean
  /** The one lesson in a private lesson row; null in a group session. */
  booking: SlotBooking | null
  /** Every live booking, the students of a group session. */
  bookings: SlotBooking[]
}

/** One lesson for 课程详情: a group session, or the time of a private lesson. */
export type LessonSlot = Omit<Slot, 'booking' | 'bookings'> & {
  coach: { id: number; name: string }
  /** The class of a group session; null for a private lesson, whose booking names it. */
  lessonType: { id: number; name: string } | null
  /** A private lesson moved to another time: where it is now. */
  movedTo: { slotId: number; startsAt: string } | null
  /** Why the venue could not give the lesson as booked (闭馆, 请假, the coach stopped), if so. */
  disruption: Disruption | null
}

export interface SlotBooking {
  id: number
  status: BookingStatus
  lessonTypeId: number
  attendance: Attendance | null
  student: Person | null
}

export type AdminBooking = BookingDto & {
  student: Person | null
  coachNote: string
  /** Set when the front desk booked it for the student. */
  bookedBy: { id: number; name: string } | null
  /**
   * Why the venue could not give the lesson as booked, for staff marking 签到: unlike
   * `disruption`, still set once the lesson ended.
   */
  lessonDisruption: Disruption | null
}

export interface StudentDetail extends Person {
  tester: boolean
  deletedAt: string | null
  createdAt: string
  /** False for a student the front desk added who has not linked their WeChat yet. */
  wechatBound: boolean
  /** Other students with the same phone, told apart by 学员编号. */
  samePhone: { id: number; name: string }[]
  profile: StudentProfileDto
  /** The 课后点评 the student sees, newest first. */
  feedback: FeedbackItemDto[]
  packages: PackageDto[]
  bookings: BookingDto[]
}

export interface StudentRow extends Person {
  tester: boolean
  deletedAt: string | null
  createdAt: string
  wechatBound: boolean
  phoneShared: boolean
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
  /** A payment WeChat Pay reported that could not be applied; see `orderAnomalyLabel`. */
  anomaly: 'amount_mismatch' | 'refunded' | null
  /** What WeChat Pay actually charged, in fen. */
  anomalyAmount: number | null
  anomalyHandledAt: string | null
  anomalyNote: string | null
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
  /** A failed refund staff settled outside the system: how, in their words. */
  settledNote: string | null
  /** With settledNote: put right on the merchant platform, or paid back another way. */
  settledHow: RefundSettleWay | null
  /** WeChat Pay could not send it back (退款异常), for staff to handle. */
  abnormal: boolean
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
  /** The lessons the package had left when the refund closed it, or null before that. */
  lessonsRefunded: number | null
  /** A live invoice on the order, which a refund makes wrong. */
  invoiceStatus: 'requested' | 'issued' | null
}

export interface Banner {
  id: number
  imageUrl: string
  title: string
  linkKind: LinkKind
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
