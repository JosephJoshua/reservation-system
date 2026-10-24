// Response shapes of the student API. Instants are ISO strings; money is fen.
import type { Attendance } from './availability'
import type { OrderInvoiceDto } from './invoices'
import type { PriceTag } from './pricing'
import type { LateCancelRule } from './settings'

export interface LessonTypeDto {
  id: number
  name: string
  description: string
  durationMinutes: number
  isTrial: boolean
  /** Lowest price across the coaches who teach it. */
  fromPrice: PriceTag | null
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
  booking: {
    advanceDays: number
    minNoticeMinutes: number
    cancelDeadlineHours: number
    lateCancel: LateCancelRule
  }
  /** `agreement` falls back to the built-in text; `version` is what a consent agrees to. */
  policies: { booking: string; agreement: string; privacy: string; version: string }
}

export interface BannerDto {
  id: number
  imageUrl: string
  title: string
  linkKind: 'none' | 'package' | 'lesson_type'
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
  banners: BannerDto[]
}

export interface SlotDto {
  id: number
  coachId: number
  startsAt: string
  endsAt: string
  available: boolean
}

export type BookingStatus = 'pending_payment' | 'confirmed' | 'completed' | 'cancelled' | 'expired'
export type RefundStatus =
  | 'requested'
  | 'pending'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'rejected'

export interface BookingDto {
  id: number
  status: BookingStatus
  startsAt: string
  endsAt: string
  coach: { id: number; name: string }
  lessonType: { id: number; name: string; isTrial: boolean }
  paidWith: 'order' | 'package'
  price: number
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
  canCancel: boolean
  /** The student can move it to another time now. */
  canMove: boolean
  /** Moves the student has left on this booking. */
  movesLeft: number
  /** Start of the lesson's first time, when it was moved. */
  movedFrom: string | null
  cancelledBy: 'student' | 'venue' | null
  late: boolean
  refund: { amount: number; status: RefundStatus } | null
  /** Marked by the coach or the venue once the lesson has started. */
  attendance: Attendance | null
  /** Invoicing of the lesson's paid order; null when nothing was paid. */
  invoice: OrderInvoiceDto | null
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
  /** Subscription message template IDs that are set up, for the pages that ask for them. */
  noticeTemplates: Partial<Record<StudentNoticeKind, string>>
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
