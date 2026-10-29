// Run `pnpm db:generate` after changing tables. Money is integer fen; instants are UTC ms.
import {
  type BookingTerms,
  type Grip,
  type InvoiceTitle,
  LINK_KINDS,
  type RuleOverrides,
  type StaffRole,
  type StudentLevel,
  studentNoticeKinds,
} from '@rs/shared'
import { sql } from 'drizzle-orm'
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

const id = () => integer('id').primaryKey({ autoIncrement: true })
const instant = (name: string) => integer(name, { mode: 'timestamp_ms' })
const createdAt = () => instant('created_at').notNull().default(sql`(unixepoch() * 1000)`)

export const settings = sqliteTable('settings', {
  id: integer('id').primaryKey(),
  data: text('data', { mode: 'json' }).notNull(),
  updatedAt: instant('updated_at').notNull(),
})

export const students = sqliteTable(
  'students',
  {
    id: id(),
    // A student the front desk added before they used the mini program holds a `desk:` placeholder
    // until they enter the desk's bind code; see services/student-link.ts.
    openid: text('openid').notNull().unique(),
    name: text('name').notNull().default(''),
    phone: text('phone').notNull().default(''),
    // Testers also see admin-only lesson types, for real-money test payments.
    tester: integer('tester', { mode: 'boolean' }).notNull().default(false),
    // The POLICY_VERSION the student last agreed to, and when.
    policyVersion: text('policy_version'),
    policyAgreedAt: instant('policy_agreed_at'),
    // The invoice title used last, to fill the next request. Cleared when the account is deleted.
    invoiceTitle: text('invoice_title', { mode: 'json' }).$type<InvoiceTitle>(),
    // A front-desk student's one-time code for linking their WeChat. Kept after use, so a repeated
    // request from the same student succeeds again.
    bindCode: text('bind_code').unique(),
    bindCodeExpiresAt: instant('bind_code_expires_at'),
    // A deleted account keeps its row for the orders and bookings that point at it, with the
    // name and phone cleared and the openid replaced, so the same WeChat user starts afresh.
    deletedAt: instant('deleted_at'),
    createdAt: createdAt(),
  },
  // The desk looks students up by phone and flags two with the same one.
  (t) => [index('students_phone').on(t.phone)],
)

/**
 * 学员档案, kept by staff for coaches. Never sent to the student. Deleted with the account.
 * A student without a row has an empty profile.
 */
export const studentProfiles = sqliteTable('student_profiles', {
  studentId: integer('student_id')
    .primaryKey()
    .references(() => students.id),
  level: text('level').$type<StudentLevel>(),
  grip: text('grip').$type<Grip>(),
  tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().default([]),
  note: text('note').notNull().default(''),
  updatedAt: instant('updated_at').notNull(),
  // Who saved it last: a coach from a lesson page or staff in the admin. Both null on older rows.
  updatedByCoach: integer('updated_by_coach').references(() => coaches.id),
  updatedByStaff: integer('updated_by_staff').references(() => staff.id),
})

/** Front-desk and management logins for the admin app. `roles` decides what each may do. */
export const staff = sqliteTable('staff', {
  id: id(),
  name: text('name').notNull(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  // Logins from before roles existed had full access, so they start as 管理员.
  roles: text('roles', { mode: 'json' }).$type<StaffRole[]>().notNull().default(['admin']),
  // Deactivated staff cannot log in; they stay for the action log.
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: createdAt(),
})

export const sessions = sqliteTable('sessions', {
  // The SHA-256 of the bearer token (hashToken), never the token itself.
  tokenHash: text('token_hash').primaryKey(),
  role: text('role', { enum: ['student', 'admin', 'coach'] }).notNull(),
  studentId: integer('student_id').references(() => students.id),
  coachId: integer('coach_id').references(() => coaches.id),
  staffId: integer('staff_id').references(() => staff.id),
  expiresAt: instant('expires_at').notNull(),
})

/** A coach category, such as 主教练, sets the coaches' price for each lesson type. */
export const coachCategories = sqliteTable('coach_categories', {
  id: id(),
  name: text('name').notNull(),
  sort: integer('sort').notNull().default(0),
  createdAt: createdAt(),
})

/** A category's price for a lesson type. Without one, the lesson type's own price applies. */
export const categoryPrices = sqliteTable(
  'category_prices',
  {
    categoryId: integer('category_id')
      .notNull()
      .references(() => coachCategories.id),
    lessonTypeId: integer('lesson_type_id')
      .notNull()
      .references(() => lessonTypes.id),
    price: integer('price').notNull(),
  },
  (t) => [primaryKey({ columns: [t.categoryId, t.lessonTypeId] })],
)

/** What the venue pays a coach in a category for teaching one lesson of a lesson type. */
export const categoryPayRates = sqliteTable(
  'category_pay_rates',
  {
    categoryId: integer('category_id')
      .notNull()
      .references(() => coachCategories.id),
    lessonTypeId: integer('lesson_type_id')
      .notNull()
      .references(() => lessonTypes.id),
    rate: integer('rate').notNull(),
  },
  (t) => [primaryKey({ columns: [t.categoryId, t.lessonTypeId] })],
)

export const coaches = sqliteTable('coaches', {
  id: id(),
  name: text('name').notNull(),
  categoryId: integer('category_id').references(() => coachCategories.id),
  title: text('title').notNull().default(''),
  tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().default([]),
  // Sanitized HTML from the admin's editor, shown on the student's coach page.
  profile: text('profile').notNull().default(''),
  avatarUrl: text('avatar_url').notNull().default(''),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  sort: integer('sort').notNull().default(0),
  // The coach's WeChat identity in the mini program, set when they enter a bind code.
  openid: text('openid').unique(),
  bindCode: text('bind_code').unique(),
  bindCodeExpiresAt: instant('bind_code_expires_at'),
  createdAt: createdAt(),
})

/**
 * Weekly hours a coach takes private lessons in (排班). Each row applies to venue dates from
 * `fromDate` until `toDate` (exclusive, null for no end), so a change can start on a later date
 * and past days keep the hours they had.
 */
export const coachHours = sqliteTable(
  'coach_hours',
  {
    id: id(),
    coachId: integer('coach_id')
      .notNull()
      .references(() => coaches.id),
    weekday: integer('weekday').notNull(),
    startMinute: integer('start_minute').notNull(),
    endMinute: integer('end_minute').notNull(),
    fromDate: text('from_date').notNull(),
    toDate: text('to_date'),
  },
  (t) => [index('coach_hours_coach').on(t.coachId)],
)

/**
 * Dated changes to the weekly hours: 请假 (`off`) and 加班 (`extra`) for one coach, or 闭馆 for
 * the whole venue when coachId is null (always `off`).
 */
export const scheduleExceptions = sqliteTable(
  'schedule_exceptions',
  {
    id: id(),
    coachId: integer('coach_id').references(() => coaches.id),
    kind: text('kind', { enum: ['off', 'extra'] }).notNull(),
    startsAt: instant('starts_at').notNull(),
    endsAt: instant('ends_at').notNull(),
    note: text('note').notNull().default(''),
    // Who added it: the coach in the mini program, or a staff login.
    byStaffId: integer('by_staff_id').references(() => staff.id),
    createdAt: createdAt(),
  },
  (t) => [index('schedule_exceptions_coach_time').on(t.coachId, t.endsAt)],
)

export const lessonTypes = sqliteTable('lesson_types', {
  id: id(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  durationMinutes: integer('duration_minutes').notNull(),
  price: integer('price').notNull(),
  isTrial: integer('is_trial', { mode: 'boolean' }).notNull().default(false),
  // More than 1 makes it a group class (小班课), taught in sessions the admin schedules.
  capacity: integer('capacity').notNull().default(1),
  // A group session with fewer confirmed students at the free-cancel deadline is cancelled.
  minStudents: integer('min_students'),
  // A group session uses one table per this many students; null puts the whole class on one.
  studentsPerTable: integer('students_per_table'),
  // Admin-only lesson types are hidden from students, for real-money test payments.
  adminOnly: integer('admin_only', { mode: 'boolean' }).notNull().default(false),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  salePercent: integer('sale_percent'),
  saleStartsAt: instant('sale_starts_at'),
  saleEndsAt: instant('sale_ends_at'),
  sort: integer('sort').notNull().default(0),
  // Its own booking rules; a rule left out follows the venue's.
  rules: text('rules', { mode: 'json' }).$type<RuleOverrides>().notNull().default({}),
  createdAt: createdAt(),
})

/** Which lesson types a coach teaches. The price comes from the coach's category. */
export const coachLessonTypes = sqliteTable(
  'coach_lesson_types',
  {
    coachId: integer('coach_id')
      .notNull()
      .references(() => coaches.id),
    lessonTypeId: integer('lesson_type_id')
      .notNull()
      .references(() => lessonTypes.id),
  },
  (t) => [primaryKey({ columns: [t.coachId, t.lessonTypeId] })],
)

/**
 * When a lesson takes place. A private lesson's row is made when it is first booked, at a time
 * the coach's 排班 offers, and kept with its bookings; a group session (小班课) is put on the
 * timetable by the venue and takes several students.
 */
export const slots = sqliteTable(
  'slots',
  {
    id: id(),
    coachId: integer('coach_id')
      .notNull()
      .references(() => coaches.id),
    startsAt: instant('starts_at').notNull(),
    endsAt: instant('ends_at').notNull(),
    // A closed group session takes no new bookings; existing bookings stay.
    open: integer('open', { mode: 'boolean' }).notNull().default(true),
    // Set for a group session (小班课): the one lesson type it teaches, to `capacity` students.
    // Private slots leave it null and take one booking.
    lessonTypeId: integer('lesson_type_id').references(() => lessonTypes.id),
    capacity: integer('capacity').notNull().default(1),
    // A session the venue called off as a whole, and why.
    cancelledAt: instant('cancelled_at'),
    cancelReason: text('cancel_reason'),
    // When the minimum headcount was checked, so it is checked once.
    minCheckedAt: instant('min_checked_at'),
    // When the coach was told the session has students, and that it was called off.
    coachToldBookedAt: instant('coach_told_booked_at'),
    coachToldCancelledAt: instant('coach_told_cancelled_at'),
    createdAt: createdAt(),
  },
  (t) => [index('slots_coach_time').on(t.coachId, t.startsAt), index('slots_time').on(t.startsAt)],
)

export const bookingStatuses = ['pending_payment', 'confirmed', 'cancelled', 'expired'] as const

export const bookings = sqliteTable(
  'bookings',
  {
    id: id(),
    slotId: integer('slot_id')
      .notNull()
      .references(() => slots.id),
    studentId: integer('student_id')
      .notNull()
      .references(() => students.id),
    lessonTypeId: integer('lesson_type_id')
      .notNull()
      .references(() => lessonTypes.id),
    // Denormalized from the slot so overlap checks need no join.
    startsAt: instant('starts_at').notNull(),
    endsAt: instant('ends_at').notNull(),
    status: text('status', { enum: bookingStatuses }).notNull(),
    // Which of the slot's seats it holds: always 1 in a private slot.
    seat: integer('seat').notNull().default(1),
    paidWith: text('paid_with', { enum: ['order', 'package'] }).notNull(),
    price: integer('price').notNull(),
    packageId: integer('package_id').references(() => packages.id),
    cancelledAt: instant('cancelled_at'),
    cancelledBy: text('cancelled_by', { enum: ['student', 'venue'] }),
    cancelReason: text('cancel_reason'),
    late: integer('late', { mode: 'boolean' }).notNull().default(false),
    // The cancel and move rules it was booked under; null for bookings made before they were kept.
    terms: text('terms', { mode: 'json' }).$type<BookingTerms>(),
    attendance: text('attendance', { enum: ['attended', 'no_show'] }),
    attendanceAt: instant('attendance_at'),
    attendanceBy: text('attendance_by', { enum: ['student', 'coach', 'staff'] }),
    // The front desk login that marked it, when attendanceBy is staff.
    attendanceStaffId: integer('attendance_staff_id').references(() => staff.id),
    // Private to the coach and the venue.
    coachNote: text('coach_note').notNull().default(''),
    // When the coach was told about the booking and its cancellation, or decided not to be.
    coachToldBookedAt: instant('coach_told_booked_at'),
    coachToldCancelledAt: instant('coach_told_cancelled_at'),
    // Set when the front desk booked the lesson for the student.
    bookedByStaffId: integer('booked_by_staff_id').references(() => staff.id),
    // The coach and time the coach was last told about, so a moved lesson is announced to them.
    coachToldCoachId: integer('coach_told_coach_id'),
    coachToldStartsAt: instant('coach_told_starts_at'),
    coachToldEndsAt: instant('coach_told_ends_at'),
    createdAt: createdAt(),
  },
  (t) => [
    // The database itself refuses two live bookings for one seat, whatever the code does, and a
    // second seat for the same student.
    uniqueIndex('bookings_one_live_per_seat')
      .on(t.slotId, t.seat)
      .where(sql`status in ('pending_payment', 'confirmed')`),
    uniqueIndex('bookings_one_live_per_student')
      .on(t.slotId, t.studentId)
      .where(sql`status in ('pending_payment', 'confirmed')`),
    index('bookings_student_time').on(t.studentId, t.startsAt),
    // Lists and reports over a stretch of time, a slot's lessons and a package's lessons.
    index('bookings_time').on(t.startsAt),
    index('bookings_slot').on(t.slotId),
    index('bookings_package').on(t.packageId),
  ],
)

/** Each time a lesson moved to another slot, for the move allowance and the lesson's history. */
export const bookingMoves = sqliteTable(
  'booking_moves',
  {
    id: id(),
    bookingId: integer('booking_id')
      .notNull()
      .references(() => bookings.id),
    by: text('by', { enum: ['student', 'coach', 'venue'] }).notNull(),
    // Times and coaches rather than slots, since a slot left empty may be deleted.
    fromCoachId: integer('from_coach_id').notNull(),
    fromStartsAt: instant('from_starts_at').notNull(),
    fromEndsAt: instant('from_ends_at').notNull(),
    toCoachId: integer('to_coach_id').notNull(),
    toStartsAt: instant('to_starts_at').notNull(),
    toEndsAt: instant('to_ends_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('booking_moves_booking').on(t.bookingId)],
)

/**
 * The coach's 课后点评 on a lesson the student came to, one per booking. Unlike the coach's note it
 * is written for the student. Photos are file names in the uploads folder, all starting with
 * `fb<bookingId>-`, so the files of one lesson can be found and removed together.
 */
export const lessonFeedback = sqliteTable(
  'lesson_feedback',
  {
    id: id(),
    bookingId: integer('booking_id')
      .notNull()
      .references(() => bookings.id),
    text: text('text').notNull(),
    photos: text('photos', { mode: 'json' }).$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: instant('updated_at').notNull(),
    // Taken down by the venue: the student no longer sees it.
    hiddenAt: instant('hidden_at'),
    hiddenByStaffId: integer('hidden_by_staff_id').references(() => staff.id),
    // Deleted by the coach while hidden: kept empty, so it cannot be written again around the venue.
    deletedAt: instant('deleted_at'),
  },
  (t) => [uniqueIndex('lesson_feedback_booking').on(t.bookingId)],
)

/**
 * Subscription messages to students, sent by the sweeper. booked, cancelled and reminder rows
 * come from booking state and appear at most once per booking; other kinds are queued by the
 * code that causes them. doneAt is set once the message went out, was refused or was dropped.
 */
export const studentNotices = sqliteTable(
  'student_notices',
  {
    id: id(),
    bookingId: integer('booking_id')
      .notNull()
      .references(() => bookings.id),
    kind: text('kind', { enum: studentNoticeKinds }).notNull(),
    // Values fixed when the notice was queued, such as the old time of a moved lesson.
    data: text('data', { mode: 'json' }).$type<Record<string, string>>().notNull().default({}),
    createdAt: createdAt(),
    // After a failed send, when to try again.
    retryAt: instant('retry_at'),
    doneAt: instant('done_at'),
    result: text('result', { enum: ['sent', 'refused', 'skipped'] }),
  },
  (t) => [
    uniqueIndex('student_notices_once')
      .on(t.bookingId, t.kind)
      .where(sql`kind in ('booked', 'cancelled', 'reminder')`),
    index('student_notices_booking').on(t.bookingId, t.kind),
    index('student_notices_pending').on(t.doneAt),
  ],
)

export const packageProducts = sqliteTable('package_products', {
  id: id(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  lessonTypeId: integer('lesson_type_id')
    .notNull()
    .references(() => lessonTypes.id),
  // Empty means every coach who teaches the lesson type.
  coachIds: text('coach_ids', { mode: 'json' }).$type<number[]>().notNull().default([]),
  lessonCount: integer('lesson_count').notNull(),
  price: integer('price').notNull(),
  validityDays: integer('validity_days').notNull(),
  onSale: integer('on_sale', { mode: 'boolean' }).notNull().default(true),
  salePrice: integer('sale_price'),
  saleStartsAt: instant('sale_starts_at'),
  saleEndsAt: instant('sale_ends_at'),
  sort: integer('sort').notNull().default(0),
  createdAt: createdAt(),
})

export const packages = sqliteTable(
  'packages',
  {
    id: id(),
    studentId: integer('student_id')
      .notNull()
      .references(() => students.id),
    productId: integer('product_id')
      .notNull()
      .references(() => packageProducts.id),
    // Snapshots, so later product edits never change what a student bought.
    name: text('name').notNull(),
    lessonTypeId: integer('lesson_type_id')
      .notNull()
      .references(() => lessonTypes.id),
    coachIds: text('coach_ids', { mode: 'json' }).$type<number[]>().notNull(),
    lessonsPurchased: integer('lessons_purchased').notNull(),
    lessonsRemaining: integer('lessons_remaining').notNull(),
    pricePaid: integer('price_paid').notNull(),
    expiresAt: instant('expires_at').notNull(),
    status: text('status', { enum: ['active', 'refund_requested', 'refunded'] }).notNull(),
    orderId: integer('order_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('packages_student').on(t.studentId)],
)

/**
 * Messages to students about a package running out: 7 days before it expires with lessons left,
 * and once its last lesson is booked. Sent by the sweeper, like student_notices.
 */
export const packageNotices = sqliteTable(
  'package_notices',
  {
    id: id(),
    packageId: integer('package_id')
      .notNull()
      .references(() => packages.id),
    kind: text('kind', { enum: ['expiring', 'used_up'] }).notNull(),
    // The expiry it tells; an extended package is reminded of its new date.
    expiresAt: instant('expires_at').notNull(),
    createdAt: createdAt(),
    retryAt: instant('retry_at'),
    doneAt: instant('done_at'),
    result: text('result', { enum: ['sent', 'refused', 'skipped'] }),
  },
  (t) => [
    uniqueIndex('package_notices_expiring')
      .on(t.packageId, t.expiresAt)
      .where(sql`kind = 'expiring'`),
    uniqueIndex('package_notices_used_up').on(t.packageId).where(sql`kind = 'used_up'`),
    index('package_notices_pending').on(t.doneAt),
  ],
)

export const packageLedger = sqliteTable(
  'package_ledger',
  {
    id: id(),
    packageId: integer('package_id')
      .notNull()
      .references(() => packages.id),
    delta: integer('delta').notNull(),
    kind: text('kind', {
      enum: ['purchase', 'use', 'return', 'grant', 'extend', 'refund'],
    }).notNull(),
    bookingId: integer('booking_id'),
    note: text('note').notNull().default(''),
    actor: text('actor', { enum: ['student', 'admin', 'system'] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('package_ledger_package').on(t.packageId),
    index('package_ledger_booking').on(t.bookingId),
  ],
)

export const orders = sqliteTable(
  'orders',
  {
    id: id(),
    outTradeNo: text('out_trade_no').notNull().unique(),
    studentId: integer('student_id')
      .notNull()
      .references(() => students.id),
    kind: text('kind', { enum: ['class', 'trial', 'package'] }).notNull(),
    description: text('description').notNull(),
    amount: integer('amount').notNull(),
    provider: text('provider', { enum: ['wechat', 'offline'] }).notNull(),
    // How an offline payment was taken at the front desk.
    offlineMethod: text('offline_method', { enum: ['cash', 'alipay', 'wechat', 'transfer'] }),
    status: text('status', { enum: ['pending', 'paid', 'closed'] }).notNull(),
    prepayId: text('prepay_id'),
    transactionId: text('transaction_id'),
    bookingId: integer('booking_id'),
    productId: integer('product_id'),
    expiresAt: instant('expires_at'),
    paidAt: instant('paid_at'),
    note: text('note').notNull().default(''),
    createdAt: createdAt(),
  },
  (t) => [
    index('orders_status_expiry').on(t.status, t.expiresAt),
    index('orders_paid').on(t.status, t.paidAt),
    index('orders_booking').on(t.bookingId),
    index('orders_student').on(t.studentId),
  ],
)

export const refundStatuses = [
  'requested', // student asked for a package refund; waits for the admin
  'pending', // approved, not yet accepted by WeChat Pay
  'processing',
  'succeeded',
  'failed',
  'rejected',
] as const

export const refunds = sqliteTable(
  'refunds',
  {
    id: id(),
    outRefundNo: text('out_refund_no').notNull().unique(),
    orderId: integer('order_id')
      .notNull()
      .references(() => orders.id),
    amount: integer('amount').notNull(),
    reason: text('reason').notNull(),
    status: text('status', { enum: refundStatuses }).notNull(),
    bookingId: integer('booking_id'),
    packageId: integer('package_id'),
    providerRefundId: text('provider_refund_id'),
    failure: text('failure'),
    createdAt: createdAt(),
    updatedAt: instant('updated_at').notNull(),
  },
  (t) => [index('refunds_status').on(t.status), index('refunds_order').on(t.orderId)],
)

/**
 * A student's request for a 发票 on a paid order. Staff issue it in the tax system and upload
 * the PDF, or reject it with a reason. An order has at most one request that is not rejected.
 */
export const invoices = sqliteTable(
  'invoices',
  {
    id: id(),
    studentId: integer('student_id')
      .notNull()
      .references(() => students.id),
    orderId: integer('order_id')
      .notNull()
      .references(() => orders.id),
    status: text('status', { enum: ['requested', 'issued', 'rejected'] }).notNull(),
    titleKind: text('title_kind', { enum: ['personal', 'company'] }).notNull(),
    title: text('title').notNull(),
    taxNumber: text('tax_number').notNull().default(''),
    email: text('email').notNull(),
    // The amount paid less refunds when requested; staff check it again when issuing.
    amount: integer('amount').notNull(),
    rejectReason: text('reject_reason'),
    // File name under the uploads folder's invoices/ directory, which is never served as is.
    pdfFile: text('pdf_file'),
    issuedAt: instant('issued_at'),
    handledByStaffId: integer('handled_by_staff_id').references(() => staff.id),
    // The newest refund on the order that staff have accounted for: the last one when it was
    // issued, then the last one when they marked a refund handled. A later refund flags it.
    refundSeenId: integer('refund_seen_id').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('invoices_one_live_per_order')
      .on(t.orderId)
      .where(sql`status in ('requested', 'issued')`),
    index('invoices_status').on(t.status, t.createdAt),
    index('invoices_student').on(t.studentId),
  ],
)

export const banners = sqliteTable('banners', {
  id: id(),
  imageUrl: text('image_url').notNull(),
  title: text('title').notNull().default(''),
  linkKind: text('link_kind', { enum: LINK_KINDS }).notNull().default('none'),
  linkId: integer('link_id'),
  startsAt: instant('starts_at'),
  endsAt: instant('ends_at'),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  sort: integer('sort').notNull().default(0),
  createdAt: createdAt(),
})

/** Responses to requests sent with an Idempotency-Key, so a retried or repeated submit runs once. */
export const idempotencyKeys = sqliteTable(
  'idempotency_keys',
  {
    // Hash of the caller's token, the method, the path and the client's key.
    id: text('id').primaryKey(),
    // A repeat must send the same body; a different one under the same key is refused.
    bodyHash: text('body_hash').notNull(),
    // Null while the first request is still running.
    status: integer('status'),
    body: text('body'),
    contentType: text('content_type'),
    createdAt: instant('created_at').notNull(),
  },
  (t) => [index('idempotency_keys_created').on(t.createdAt)],
)

/**
 * A venue month whose coach pay staff confirmed. Its amounts are then fixed: the pay rules it was
 * confirmed with are kept here, and the lessons it paid are in coachPayEntries.
 */
export const coachPayMonths = sqliteTable('coach_pay_months', {
  // Venue month, YYYY-MM.
  month: text('month').primaryKey(),
  rules: text('rules', { mode: 'json' })
    .$type<{ noShows: boolean; lateCancels: boolean }>()
    .notNull(),
  total: integer('total').notNull(),
  confirmedAt: instant('confirmed_at').notNull(),
  staffId: integer('staff_id')
    .notNull()
    .references(() => staff.id),
})

/**
 * What a confirmed month paid each coach, one row per lesson. A lesson is a booking, or a whole
 * group session (`unit` is b<bookingId> or s<slotId>). A change to a lesson after its month was
 * confirmed is paid in the next month as an adjustment: -1 to take back what was paid, +1 to pay
 * a lesson that now counts.
 */
export const coachPayEntries = sqliteTable(
  'coach_pay_entries',
  {
    id: id(),
    // The confirmed month that paid it.
    month: text('month')
      .notNull()
      .references(() => coachPayMonths.month),
    kind: text('kind', { enum: ['lesson', 'adjustment'] }).notNull(),
    unit: text('unit').notNull(),
    coachId: integer('coach_id')
      .notNull()
      .references(() => coaches.id),
    lessonTypeId: integer('lesson_type_id')
      .notNull()
      .references(() => lessonTypes.id),
    startsAt: instant('starts_at').notNull(),
    rate: integer('rate').notNull(),
    lessons: integer('lessons').notNull(),
    amount: integer('amount').notNull(),
  },
  (t) => [index('coach_pay_entries_month').on(t.month), index('coach_pay_entries_unit').on(t.unit)],
)

/**
 * What staff did with money, bookings, prices and logins. Rows are never changed, except that a
 * WeChat account joining a front-desk student brings its rows over to that student.
 */
export const actionLog = sqliteTable(
  'action_log',
  {
    id: id(),
    staffId: integer('staff_id')
      .notNull()
      .references(() => staff.id),
    action: text('action').notNull(),
    // Short Chinese description, written when the action happens so later edits never change it.
    summary: text('summary').notNull(),
    // Money moved by the action, in fen, when there is any.
    amount: integer('amount'),
    // The student it concerns. Their name is looked up when read, never copied into the summary,
    // so a deleted account leaves no personal data here.
    studentId: integer('student_id').references(() => students.id),
    targetKind: text('target_kind'),
    targetId: integer('target_id'),
    createdAt: createdAt(),
  },
  (t) => [
    index('action_log_time').on(t.createdAt),
    index('action_log_staff').on(t.staffId),
    index('action_log_student').on(t.studentId),
  ],
)
