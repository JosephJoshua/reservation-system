// Response shapes of the student API. Instants are ISO strings; money is fen.
import type { Attendance, AttendanceBy } from './availability'
import type { OrderInvoiceDto } from './invoices'
import type { LinkKind, LinkTarget } from './links'
import type { PriceTag } from './pricing'
import type { BookingTerms, Disruption } from './rules'
import type { BookingRules } from './settings'

export interface LessonTypeDto {
  id: number
  name: string
  description: string
  durationMinutes: number
  isTrial: boolean
  /** Students per session: 1 for a private lesson, more for a group class. */
  capacity: number
  /** A group session short of this many at the free-cancel deadline is called off. */
  minStudents: number | null
  /** Lowest price across the coaches who teach it. */
  fromPrice: PriceTag | null
  /** Its booking rules: its own where it sets them, the venue's otherwise. */
  rules: BookingRules
}

export interface CoachDto {
  id: number
  name: string
  /** Category name such as 主教练, or empty. */
  category: string
  title: string
  tags: string[]
  avatarUrl: string
  lessons: { lessonTypeId: number; price: PriceTag }[]
}

export interface CoachDetailDto extends CoachDto {
  /** Sanitized HTML. Images point at /api/uploads/. */
  profile: string
}

export interface PackageProductDto {
  id: number
  name: string
  description: string
  lessonTypeId: number
  coachIds: number[]
  lessonCount: number
  validityDays: number
  price: PriceTag
}

export interface CatalogDto {
  lessonTypes: LessonTypeDto[]
  coaches: CoachDto[]
  packageProducts: PackageProductDto[]
  payment: { trialEnabled: boolean; perClassEnabled: boolean; packagesEnabled: boolean }
  /** `agreement` falls back to the built-in text; `version` is what a consent agrees to. */
  policies: { booking: string; agreement: string; privacy: string; version: string }
}

export interface BannerDto {
  id: number
  imageUrl: string
  title: string
  linkKind: LinkKind
  linkId: number | null
}

export interface HomeDto {
  venue: {
    name: string
    address: string
    phone: string
    latitude: number | null
    longitude: number | null
    openingHours: string
  }
  notice: string | null
  /** Where a tap on the notice goes; a target students can no longer open comes as none. */
  noticeLink: LinkTarget
  banners: BannerDto[]
}

/** A group session, or a private lesson time (id null) a coach's 排班 offers. */
export interface SlotDto {
  /** The session's id; null for a private lesson time, booked by coach and start instead. */
  id: number | null
  coachId: number
  startsAt: string
  endsAt: string
  available: boolean
  /** The class a group session teaches; null for a private slot. */
  lessonTypeId: number | null
  /** Seats in the slot: 1 for a private lesson, more for a group session. */
  capacity: number
  /** Seats nobody holds yet. */
  seatsLeft: number
}

export type BookingStatus = 'pending_payment' | 'confirmed' | 'completed' | 'cancelled' | 'expired'
export type RefundStatus =
  | 'requested'
  | 'pending'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'rejected'

/**
 * How staff settled a WeChat Pay refund outside the system: 商户平台处理 (the same refund, put
 * right on the merchant platform) or 线下另付 (the money handed back another way, in cash or by
 * transfer).
 */
export const REFUND_SETTLE_WAYS = { platform: '商户平台处理', offline: '线下另付' } as const
export type RefundSettleWay = keyof typeof REFUND_SETTLE_WAYS

/**
 * The failure note on a refund staff paid back 线下另付 that WeChat Pay then reports done too.
 * Any other failure note on a settled refund is why WeChat Pay failed before it was settled.
 */
export const REFUND_PAID_TWICE = '微信支付也报告退款成功，如已线下另付请核对是否重复'

export interface BookingDto {
  id: number
  /** The lesson it is a seat in, which a move changes. */
  slotId: number
  status: BookingStatus
  startsAt: string
  endsAt: string
  coach: { id: number; name: string }
  lessonType: { id: number; name: string; isTrial: boolean }
  /** Seats in its slot: more than 1 for a group class. */
  capacity: number
  paidWith: 'order' | 'package'
  price: number
  /** A payment WeChat Pay took that could not confirm the booking; staff sort it out. */
  paymentIssue: 'open' | 'handled' | null
  /** Paid at the front desk, so any refund is handed back there. */
  paidOffline: boolean
  packageName: string | null
  orderId: number | null
  /** Unpaid bookings: when the hold ends. */
  payBy: string | null
  cancelDeadline: string
  /**
   * The venue or coach moved it after its usual free-cancel deadline, so it stays free to cancel
   * or move until it starts.
   */
  movedLate: boolean
  /**
   * Why the venue cannot give the lesson as booked (闭馆, the coach's 请假, an inactive coach):
   * free to cancel until it starts, and not to be come to or checked in until it ends. Also set
   * on an unpaid hold that lapsed while its lesson is still ahead.
   */
  disruption: Disruption | null
  /**
   * An expired booking whose payment landed but could not confirm it, and was refunded: why, as
   * recorded then (时段已被预约, 该课已取消, or a disruption's text). Null otherwise.
   */
  expiredWhy: string | null
  canCancel: boolean
  /** The student can move it to another time now. */
  canMove: boolean
  /** Moves the student has left on this booking. */
  movesLeft: number
  /** The cancel and move rules it was booked under. */
  terms: BookingTerms
  /** Its lesson type's booking window now, which a move to another time must fall in. */
  window: Pick<BookingRules, 'advanceDays' | 'minNoticeMinutes'>
  /** Start of the lesson's first time, when it was moved. */
  movedFrom: string | null
  cancelledBy: 'student' | 'venue' | null
  /** Why the venue or coach cancelled it, written for the student; empty when not given. */
  cancelReason: string
  late: boolean
  refund: { amount: number; status: RefundStatus } | null
  /** Marked by the coach or the venue, or by the student scanning the venue's 签到码. */
  attendance: Attendance | null
  /** The student can scan the venue's 签到码 for this lesson now. */
  canCheckIn: boolean
  /** Invoicing of the lesson's paid order; null when nothing was paid. */
  invoice: OrderInvoiceDto | null
  /** The coach wrote a 课后点评 the student can see. */
  hasFeedback: boolean
  /** That 课后点评, on a single booking only. */
  feedback: FeedbackDto | null
}

/** Photos are paths on the API server, like other uploads. */
export interface FeedbackDto {
  text: string
  photos: string[]
  updatedAt: string
}

/** One lesson in the student's 学习记录. */
export interface FeedbackItemDto extends FeedbackDto {
  bookingId: number
  startsAt: string
  endsAt: string
  coachName: string
  lessonTypeName: string
}

/** Feedback as the admin's 课后点评 page lists it. */
export interface AdminFeedbackDto extends FeedbackDto {
  id: number
  bookingId: number
  slotId: number
  startsAt: string
  coach: { id: number; name: string }
  lessonTypeName: string
  student: { id: number; name: string; phone: string }
  createdAt: string
  hidden: boolean
  /** Hidden by the venue, then deleted by the coach: kept empty so it cannot be written again. */
  deleted: boolean
  /** The student sees it: not hidden, and the lesson is still marked as attended. */
  visible: boolean
}

export type PackageStatus = 'active' | 'expired' | 'used_up' | 'refund_requested' | 'refunded'

export interface PackageDto {
  id: number
  name: string
  lessonTypeId: number
  lessonTypeName: string
  coachIds: number[]
  lessonsPurchased: number
  /** Extra lessons the venue added for free. */
  lessonsGranted: number
  lessonsRemaining: number
  expiresAt: string
  status: PackageStatus
  pricePaid: number
  /** Bought at the front desk, so any refund is handed back there. */
  paidOffline: boolean
  refund: { amount: number; status: RefundStatus } | null
  /** Invoicing of the purchase; null when nothing was paid. */
  invoice: OrderInvoiceDto | null
}

export interface PaymentParamsDto {
  timeStamp: string
  nonceStr: string
  package: string
  signType: 'RSA'
  paySign: string
  fake?: true
}

/** What booking a slot would cost, so the confirm page shows exactly what the API will do. */
export interface BookingQuoteDto {
  price: PriceTag
  /** The package that will pay, unless the student chooses WeChat Pay. */
  package: { id: number; name: string; lessonsRemaining: number } | null
  perClassEnabled: boolean
}

/** Coaches a student may move a booking to: the same coach, or one at the same price. */
export interface MoveOptionsDto {
  coachIds: number[]
}

export interface CreateBookingResponse {
  bookingId: number
  status: 'pending_payment' | 'confirmed'
  orderId: number | null
  payment: PaymentParamsDto | null
  /** The student already held this slot: this is that booking, not a new one. */
  existing: boolean
}

export interface OrderStatusDto {
  id: number
  status: 'pending' | 'paid' | 'closed'
  kind: 'class' | 'trial' | 'package'
  amount: number
  bookingId: number | null
  bookingStatus: BookingStatus | null
}

export interface StudentDto {
  id: number
  name: string
  phone: string
}

export const studentNoticeKinds = ['booked', 'cancelled', 'reminder', 'moved', 'feedback'] as const
export type StudentNoticeKind = (typeof studentNoticeKinds)[number]

/** GET /me: the student, and whether the same WeChat user is a bound coach. */
export interface MeDto extends StudentDto {
  isCoach: boolean
  /**
   * Subscription message template IDs that are set up, for the pages that ask for them. `package`
   * is the one for packages about to expire or used up.
   */
  noticeTemplates: Partial<Record<StudentNoticeKind | 'package', string>>
  /** Whether the student agreed to the current user agreement and privacy policy. */
  agreedPolicies: boolean
}

/** GET /me/deletion: why the account cannot be deleted yet; empty when it can. */
export interface AccountDeletionDto {
  blockers: string[]
}

export interface ApiErrorBody {
  error: { code: string; message: string }
}

/** One lesson the student checked in to by scanning the venue's 签到码. */
export interface CheckInLessonDto {
  bookingId: number
  startsAt: string
  endsAt: string
  coachName: string
  lessonTypeName: string
  /** Already checked in before this scan. */
  already: boolean
}

/** One student's lesson today on the front desk's 签到 list. */
export interface FrontDeskLessonDto {
  bookingId: number
  slotId: number
  startsAt: string
  endsAt: string
  coach: { id: number; name: string }
  lessonTypeName: string
  /** Seats in the slot: more than 1 for a group class. */
  capacity: number
  student: { id: number; name: string; phone: string }
  attendance: Attendance | null
  attendanceAt: string | null
  /** Who marked it, with the login's name when the front desk did; null on marks from before this was kept. */
  markedBy: { kind: AttendanceBy; name: string | null } | null
  canArrive: boolean
  canMarkAbsent: boolean
}
