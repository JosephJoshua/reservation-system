// Response shapes of the student API. Instants are ISO strings; money is fen.
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
  title: string
  bio: string
  avatarUrl: string
  lessons: { lessonTypeId: number; price: PriceTag }[]
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
  policies: { booking: string; agreement: string }
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
  packageName: string | null
  orderId: number | null
  /** Unpaid bookings: when the hold ends. */
  payBy: string | null
  cancelDeadline: string
  canCancel: boolean
  cancelledBy: 'student' | 'venue' | null
  late: boolean
  refund: { amount: number; status: RefundStatus } | null
}

export type PackageStatus = 'active' | 'expired' | 'used_up' | 'refund_requested' | 'refunded'

export interface PackageDto {
  id: number
  name: string
  lessonTypeId: number
  lessonTypeName: string
  coachIds: number[]
  lessonsPurchased: number
  lessonsRemaining: number
  expiresAt: string
  status: PackageStatus
  pricePaid: number
  refund: { amount: number; status: RefundStatus } | null
}

export interface PaymentParamsDto {
  timeStamp: string
  nonceStr: string
  package: string
  signType: 'RSA'
  paySign: string
  fake?: true
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

export interface ApiErrorBody {
  error: { code: string; message: string }
}
