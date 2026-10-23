// Run `pnpm db:generate` after changing tables. Money is integer fen; instants are UTC ms.
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

export const students = sqliteTable('students', {
  id: id(),
  openid: text('openid').notNull().unique(),
  name: text('name').notNull().default(''),
  phone: text('phone').notNull().default(''),
  // Testers also see admin-only lesson types, for real-money test payments.
  tester: integer('tester', { mode: 'boolean' }).notNull().default(false),
  createdAt: createdAt(),
})

export const sessions = sqliteTable('sessions', {
  token: text('token').primaryKey(),
  role: text('role', { enum: ['student', 'admin'] }).notNull(),
  studentId: integer('student_id').references(() => students.id),
  expiresAt: instant('expires_at').notNull(),
})

export const coaches = sqliteTable('coaches', {
  id: id(),
  name: text('name').notNull(),
  title: text('title').notNull().default(''),
  bio: text('bio').notNull().default(''),
  avatarUrl: text('avatar_url').notNull().default(''),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  sort: integer('sort').notNull().default(0),
  createdAt: createdAt(),
})

export const lessonTypes = sqliteTable('lesson_types', {
  id: id(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  durationMinutes: integer('duration_minutes').notNull(),
  price: integer('price').notNull(),
  isTrial: integer('is_trial', { mode: 'boolean' }).notNull().default(false),
  // Admin-only lesson types are hidden from students, for real-money test payments.
  adminOnly: integer('admin_only', { mode: 'boolean' }).notNull().default(false),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  salePercent: integer('sale_percent'),
  saleStartsAt: instant('sale_starts_at'),
  saleEndsAt: instant('sale_ends_at'),
  sort: integer('sort').notNull().default(0),
  createdAt: createdAt(),
})

/** Which lesson types a coach teaches, with an optional price of their own. */
export const coachLessonTypes = sqliteTable(
  'coach_lesson_types',
  {
    coachId: integer('coach_id')
      .notNull()
      .references(() => coaches.id),
    lessonTypeId: integer('lesson_type_id')
      .notNull()
      .references(() => lessonTypes.id),
    price: integer('price'),
  },
  (t) => [primaryKey({ columns: [t.coachId, t.lessonTypeId] })],
)

export const slots = sqliteTable(
  'slots',
  {
    id: id(),
    coachId: integer('coach_id')
      .notNull()
      .references(() => coaches.id),
    startsAt: instant('starts_at').notNull(),
    endsAt: instant('ends_at').notNull(),
    // Closed slots take no new bookings; existing bookings stay.
    open: integer('open', { mode: 'boolean' }).notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index('slots_coach_time').on(t.coachId, t.startsAt)],
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
    paidWith: text('paid_with', { enum: ['order', 'package'] }).notNull(),
    price: integer('price').notNull(),
    packageId: integer('package_id').references(() => packages.id),
    cancelledAt: instant('cancelled_at'),
    cancelledBy: text('cancelled_by', { enum: ['student', 'venue'] }),
    cancelReason: text('cancel_reason'),
    late: integer('late', { mode: 'boolean' }).notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    // The database itself refuses a second live booking for one slot, whatever the code does.
    uniqueIndex('bookings_one_live_per_slot')
      .on(t.slotId)
      .where(sql`status in ('pending_payment', 'confirmed')`),
    index('bookings_student_time').on(t.studentId, t.startsAt),
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

export const packageLedger = sqliteTable('package_ledger', {
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
})

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
  (t) => [index('orders_status_expiry').on(t.status, t.expiresAt)],
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
  (t) => [index('refunds_status').on(t.status)],
)

export const banners = sqliteTable('banners', {
  id: id(),
  imageUrl: text('image_url').notNull(),
  title: text('title').notNull().default(''),
  linkKind: text('link_kind', { enum: ['none', 'package', 'lesson_type'] })
    .notNull()
    .default('none'),
  linkId: integer('link_id'),
  startsAt: instant('starts_at'),
  endsAt: instant('ends_at'),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  sort: integer('sort').notNull().default(0),
  createdAt: createdAt(),
})
