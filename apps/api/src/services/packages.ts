import {
  formatYuan,
  type PackageTerms,
  packagePrice,
  samePackageTerms,
  suggestedPackageRefund,
  validityEnd,
} from '@rs/shared'
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm'
import { immediate, type Q } from '../db/client'
import {
  bookings,
  categoryPrices,
  coaches,
  coachLessonTypes,
  lessonTypes,
  orders,
  packageLedger,
  packageProducts,
  packages,
  refunds,
  slots,
  students,
} from '../db/schema'
import type { Deps } from '../deps'
import { ApiError, notFound } from '../errors'
import type { PaymentParams } from '../pay/gateway'
import { accountDeleted, refuseDeletedOwner } from './account'
import { newOutRefundNo, newOutTradeNo } from './ids'
import { closeRefundedRequests } from './invoices'
import { createPackageFromOrder, startPaymentOrRelease } from './orders'
import { refundedSoFar, submitRefund } from './refunds'
import { getSettings } from './settings'
import { grantedLessons } from './views'

// An open order is reused only while there is still time to pay it.
const REUSE_MARGIN_MS = 2 * 60_000

type ProductRow = typeof packageProducts.$inferSelect

/** What a package bought from this product now grants, kept on its order. */
function termsOf(product: ProductRow): PackageTerms & { name: string } {
  return {
    name: product.name,
    lessonTypeId: product.lessonTypeId,
    coachIds: product.coachIds,
    lessonCount: product.lessonCount,
    validityDays: product.validityDays,
  }
}

/** Refuses a sale when the product no longer grants what the buyer was shown. */
function assertTerms(product: ProductRow, expected: PackageTerms | undefined) {
  if (expected && !samePackageTerms(expected, product)) {
    throw new ApiError(409, 'package_changed', '课时包内容已变动，请重新确认')
  }
}

/**
 * Starts a WeChat Pay purchase of a package product. `payment` is null when a repeat finds the
 * open order already paid.
 */
export async function purchasePackage(
  deps: Deps,
  studentId: number,
  productId: number,
  /** The price the student was shown, in fen; a different price now refuses the purchase. */
  expectedPrice?: number,
  /** What the student was shown the package grants; anything else now refuses the purchase. */
  expectedTerms?: PackageTerms,
): Promise<{ orderId: number; payment: PaymentParams | null }> {
  const now = deps.now()
  const { id: orderId, repeat } = immediate(deps.db, (tx) => {
    const settings = getSettings(tx)
    if (!settings.payment.packagesEnabled) throw new ApiError(409, 'packages_off', '暂不出售课时包')
    const product = tx.select().from(packageProducts).where(eq(packageProducts.id, productId)).get()
    if (!product?.onSale) throw new ApiError(404, 'not_found', '该课时包已下架')
    const lessonType = tx
      .select()
      .from(lessonTypes)
      .where(eq(lessonTypes.id, product.lessonTypeId))
      .get()
    const student = tx.select().from(students).where(eq(students.id, studentId)).get()
    // Deleted while this request was on its way.
    if (!student || student.deletedAt) throw new ApiError(401, 'unauthorized', '请重新登录')
    if (!lessonType?.active || (lessonType.adminOnly && !student.tester)) {
      throw new ApiError(404, 'not_found', '该课时包已下架')
    }
    // Kept to coaches of whom none still teaches its lesson, it could never be used.
    if (
      product.coachIds.length &&
      !tx
        .select({ id: coaches.id })
        .from(coaches)
        .innerJoin(coachLessonTypes, eq(coachLessonTypes.coachId, coaches.id))
        .where(
          and(
            inArray(coaches.id, product.coachIds),
            eq(coaches.active, true),
            eq(coachLessonTypes.lessonTypeId, product.lessonTypeId),
          ),
        )
        .get()
    ) {
      throw new ApiError(404, 'not_found', '该课时包已下架')
    }
    const price = packagePrice(
      {
        price: product.price,
        salePrice: product.salePrice,
        startsAt: product.saleStartsAt,
        endsAt: product.saleEndsAt,
      },
      now,
    )
    // Changed by the venue, or a sale ended, since the student saw the price.
    if (expectedPrice !== undefined && expectedPrice !== price.price) {
      throw new ApiError(409, 'price_changed', '价格已变动')
    }
    assertTerms(product, expectedTerms)
    const terms = termsOf(product)
    // A repeated tap or a retry continues the order already open for this product, so the
    // student never ends up with two cashier sessions for one purchase.
    const open = tx
      .select({ id: orders.id, terms: orders.packageTerms })
      .from(orders)
      .where(
        and(
          eq(orders.studentId, studentId),
          eq(orders.productId, product.id),
          eq(orders.status, 'pending'),
          eq(orders.amount, price.price),
          gt(orders.expiresAt, new Date(now.getTime() + REUSE_MARGIN_MS)),
        ),
      )
      .all()
      .find((o) => !o.terms || samePackageTerms(o.terms, terms))
    if (open) return { id: open.id, repeat: true }
    const created = tx
      .insert(orders)
      .values({
        outTradeNo: newOutTradeNo(now),
        studentId,
        kind: 'package',
        description: product.name,
        amount: price.price,
        provider: 'wechat',
        status: 'pending',
        productId: product.id,
        packageTerms: terms,
        expiresAt: new Date(now.getTime() + settings.payment.timeoutMinutes * 60_000),
      })
      .returning({ id: orders.id })
      .get().id
    return { id: created, repeat: false }
  })
  const payment = await startPaymentOrRelease(deps, orderId, studentId, { release: !repeat })
  return { orderId, payment }
}

/**
 * Single-class price of each lesson taken from a package, oldest first: the coach's category
 * price for the lesson type if set, else the list price. Taken means attended or forfeited by a late cancel;
 * lessons returned to the package do not count.
 */
function usedLessonPrices(tx: Q, pkg: { id: number; lessonTypeId: number }, listPrice: number) {
  const returned = new Set(
    tx
      .select({ bookingId: packageLedger.bookingId })
      .from(packageLedger)
      .where(and(eq(packageLedger.packageId, pkg.id), eq(packageLedger.kind, 'return')))
      .all()
      .map((r) => r.bookingId),
  )
  return tx
    .select({ id: bookings.id, categoryPrice: categoryPrices.price })
    .from(bookings)
    .innerJoin(slots, eq(slots.id, bookings.slotId))
    .innerJoin(coaches, eq(coaches.id, slots.coachId))
    .leftJoin(
      categoryPrices,
      and(
        eq(categoryPrices.categoryId, coaches.categoryId),
        eq(categoryPrices.lessonTypeId, pkg.lessonTypeId),
      ),
    )
    .where(
      and(eq(bookings.packageId, pkg.id), inArray(bookings.status, ['confirmed', 'cancelled'])),
    )
    .orderBy(asc(bookings.startsAt), asc(bookings.id))
    .all()
    .filter((b) => !returned.has(b.id))
    .map((b) => b.categoryPrice ?? listPrice)
}

type PackageRow = typeof packages.$inferSelect

/**
 * Checks that a package has lessons left that can be refunded, and the amount suggested for
 * them: what was paid less the lessons taken at the single-class price.
 */
function refundablePackage(tx: Q, pkg: PackageRow, now: Date, inUse: string) {
  if (pkg.expiresAt <= now) throw new ApiError(409, 'package_expired', '课时包已过期')
  if (pkg.lessonsRemaining <= 0) throw new ApiError(409, 'package_empty', '课时包已用完')
  const upcoming = tx
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      and(
        eq(bookings.packageId, pkg.id),
        eq(bookings.status, 'confirmed'),
        // A lesson in progress still counts: the venue may yet cancel it and return the lesson.
        gt(bookings.endsAt, now),
      ),
    )
    .get()
  if (upcoming) throw new ApiError(409, 'package_in_use', inUse)
  const order = tx.select().from(orders).where(eq(orders.id, pkg.orderId)).get()
  if (!order) throw notFound('订单')
  const listPrice =
    tx
      .select({ price: lessonTypes.price })
      .from(lessonTypes)
      .where(eq(lessonTypes.id, pkg.lessonTypeId))
      .get()?.price ?? 0
  const left = order.amount - refundedSoFar(tx, order.id)
  const amount = suggestedPackageRefund({
    pricePaid: pkg.pricePaid,
    alreadyRefunded: refundedSoFar(tx, order.id),
    lessonsPurchased: pkg.lessonsPurchased,
    lessonsGranted: grantedLessons(tx, [pkg.id]).get(pkg.id) ?? 0,
    lessonsRemaining: pkg.lessonsRemaining,
    usedLessonPrices: usedLessonPrices(tx, pkg, listPrice),
    listPrice,
  })
  return { order, amount, left }
}

/** A student asks for the unused part of a package back. The admin decides the amount. */
export function requestPackageRefund(deps: Deps, studentId: number, packageId: number) {
  const now = deps.now()
  return immediate(deps.db, (tx) => {
    const pkg = tx.select().from(packages).where(eq(packages.id, packageId)).get()
    if (!pkg || pkg.studentId !== studentId) throw notFound('课时包')
    if (pkg.status === 'refund_requested') {
      // A repeated request returns the one already waiting for the admin.
      const waiting = tx
        .select({ id: refunds.id })
        .from(refunds)
        .where(and(eq(refunds.packageId, pkg.id), eq(refunds.status, 'requested')))
        .get()
      if (waiting) return waiting.id
    }
    if (pkg.status !== 'active') throw new ApiError(409, 'package_not_active', '该课时包已申请退款')
    const { order, amount } = refundablePackage(tx, pkg, now, '请先取消使用该课时包的预约')
    tx.update(packages).set({ status: 'refund_requested' }).where(eq(packages.id, pkg.id)).run()
    // A zero suggestion still goes to the admin, who may decide to refund something anyway.
    return tx
      .insert(refunds)
      .values({
        outRefundNo: newOutRefundNo(now),
        orderId: order.id,
        amount,
        reason: '课时包退款',
        status: 'requested',
        packageId: pkg.id,
        updatedAt: now,
      })
      .returning({ id: refunds.id })
      .get().id
  })
}

/** Approves a package refund request with the amount the admin settled on, and closes the package. */
export async function approvePackageRefund(deps: Deps, refundId: number, amount: number) {
  const now = deps.now()
  const approvedNow = immediate(deps.db, (tx) => {
    const refund = tx.select().from(refunds).where(eq(refunds.id, refundId)).get()
    if (!refund?.packageId) throw notFound('退款申请')
    // A repeated approval of the same amount is a no-op; anything else was decided already.
    const approved = ['pending', 'processing', 'succeeded', 'failed'].includes(refund.status)
    if (approved && refund.amount === amount) return false
    if (refund.status !== 'requested')
      throw new ApiError(409, 'refund_not_requested', '该申请已处理')
    const order = tx.select().from(orders).where(eq(orders.id, refund.orderId)).get()
    const pkg = tx.select().from(packages).where(eq(packages.id, refund.packageId)).get()
    if (!order || !pkg) throw notFound('课时包')
    if (amount < 1 || amount > order.amount - refundedSoFar(tx, order.id)) {
      throw new ApiError(409, 'refund_too_large', '退款金额超过可退金额')
    }
    tx.update(packages)
      .set({ status: 'refunded', lessonsRemaining: 0 })
      .where(eq(packages.id, pkg.id))
      .run()
    tx.insert(packageLedger)
      .values({ packageId: pkg.id, delta: -pkg.lessonsRemaining, kind: 'refund', actor: 'admin' })
      .run()
    // Offline payments stay pending until staff mark them paid back at the front desk.
    tx.update(refunds)
      .set({ amount, status: 'pending', updatedAt: now })
      .where(eq(refunds.id, refund.id))
      .run()
    return true
  })
  // A repeated approval leaves sending the refund to the first one (or the sweeper).
  if (approvedNow) await submitRefund(deps, refundId)
  return approvedNow
}

/**
 * Rejects a package refund request. Returns false for a repeat of a rejection already made with
 * the same reason; one made with another reason (a stale page) is refused with that reason, as
 * the student sees it.
 */
export function rejectPackageRefund(deps: Deps, refundId: number, note: string) {
  return immediate(deps.db, (tx) => {
    const refund = tx.select().from(refunds).where(eq(refunds.id, refundId)).get()
    if (!refund?.packageId) throw notFound('退款申请')
    if (refund.status === 'rejected') {
      if (refund.failure === note) return false
      throw new ApiError(409, 'refund_rejected', `该申请已拒绝：${refund.failure ?? ''}`)
    }
    if (refund.status !== 'requested')
      throw new ApiError(409, 'refund_not_requested', '该申请已处理')
    tx.update(refunds)
      .set({ status: 'rejected', failure: note, updatedAt: deps.now() })
      .where(eq(refunds.id, refund.id))
      .run()
    tx.update(packages)
      .set({ status: 'active' })
      .where(and(eq(packages.id, refund.packageId), eq(packages.status, 'refund_requested')))
      .run()
    return true
  })
}

// The refund staff make themselves for a package sold at the front desk.
const DESK_REFUND_REASON = '前台退课时包'

/** A package sold at the front desk that staff can refund themselves, with the amounts. */
function deskRefundable(tx: Q, packageId: number, now: Date) {
  refuseDeletedOwner(tx, packageId)
  const pkg = tx.select().from(packages).where(eq(packages.id, packageId)).get()
  if (!pkg) throw notFound('课时包')
  const order = tx
    .select({ provider: orders.provider })
    .from(orders)
    .where(eq(orders.id, pkg.orderId))
    .get()
  // One bought in the mini program goes back through WeChat Pay, from the student's request.
  if (order?.provider !== 'offline') {
    throw new ApiError(409, 'package_not_offline', '微信支付购买的课时包，请学员在小程序申请退款')
  }
  if (pkg.status === 'refund_requested') {
    throw new ApiError(409, 'package_not_active', '学员已申请退款，请在退款页处理')
  }
  if (pkg.status !== 'active') throw new ApiError(409, 'package_not_active', '该课时包已退款')
  return { pkg, ...refundablePackage(tx, pkg, now, '请先取消使用该课时包的预约') }
}

/** What refunding a front-desk package would hand back: the suggestion, and at most. */
export function deskRefundQuote(deps: Deps, packageId: number) {
  const { amount, left, pkg } = deskRefundable(deps.db, packageId, deps.now())
  return { suggested: Math.min(amount, left), max: left, lessonsRemaining: pkg.lessonsRemaining }
}

/**
 * Staff refund the unused lessons of a package sold at the front desk and hand the money back
 * there at once: the package ends, and the refund is recorded as paid back, as an offline refund
 * marked 已退还 is. `check` sees the package as staff saw it. A genuine retry of the same submit
 * is answered by its Idempotency-Key; any other submit after the refund is refused, since the
 * money may have been handed back twice.
 */
export function refundDeskPackage(
  deps: Deps,
  packageId: number,
  amount: number,
  check: (current: PackageRow) => void,
): { refundId: number } {
  const now = deps.now()
  return immediate(deps.db, (tx) => {
    const done = tx
      .select({ id: refunds.id })
      .from(refunds)
      .where(
        and(
          eq(refunds.packageId, packageId),
          eq(refunds.reason, DESK_REFUND_REASON),
          eq(refunds.status, 'succeeded'),
        ),
      )
      .get()
    if (done) {
      throw new ApiError(
        409,
        'package_refunded_elsewhere',
        '该课时包已由其他人退款，请核对是否重复退还',
      )
    }
    const { pkg, order, left } = deskRefundable(tx, packageId, now)
    check(pkg)
    if (amount < 1 || amount > left) {
      throw new ApiError(409, 'refund_too_large', '退款金额超过可退金额')
    }
    tx.update(packages)
      .set({ status: 'refunded', lessonsRemaining: 0 })
      .where(eq(packages.id, pkg.id))
      .run()
    tx.insert(packageLedger)
      .values({ packageId: pkg.id, delta: -pkg.lessonsRemaining, kind: 'refund', actor: 'admin' })
      .run()
    const refundId = tx
      .insert(refunds)
      .values({
        outRefundNo: newOutRefundNo(now),
        orderId: order.id,
        amount,
        reason: DESK_REFUND_REASON,
        status: 'succeeded',
        packageId: pkg.id,
        updatedAt: now,
      })
      .returning({ id: refunds.id })
      .get().id
    closeRefundedRequests(tx, order.id)
    return { refundId }
  })
}

/** Admin adds lessons to a package, for make-up lessons or goodwill. */
export function grantLessons(deps: Deps, packageId: number, lessons: number, note: string) {
  immediate(deps.db, (tx) => {
    refuseDeletedOwner(tx, packageId)
    const changed = tx
      .update(packages)
      .set({ lessonsRemaining: sql`${packages.lessonsRemaining} + ${lessons}` })
      .where(and(eq(packages.id, packageId), inArray(packages.status, ['active'])))
      .run()
    if (changed.changes !== 1)
      throw new ApiError(409, 'package_not_active', '只能给使用中的课时包加课时')
    tx.insert(packageLedger)
      .values({ packageId, delta: lessons, kind: 'grant', note, actor: 'admin' })
      .run()
  })
}

export function extendPackage(deps: Deps, packageId: number, days: number, note: string) {
  immediate(deps.db, (tx) => {
    refuseDeletedOwner(tx, packageId)
    const pkg = tx.select().from(packages).where(eq(packages.id, packageId)).get()
    if (pkg?.status !== 'active')
      throw new ApiError(409, 'package_not_active', '只能延长使用中的课时包')
    // Like a purchase, validity runs to the end of a venue day: counted from the current expiry
    // while it is still ahead, otherwise from today.
    const now = deps.now()
    const from = pkg.expiresAt > now ? new Date(pkg.expiresAt.getTime() - 1) : now
    tx.update(packages)
      .set({ expiresAt: validityEnd(from, days) })
      .where(eq(packages.id, packageId))
      .run()
    tx.insert(packageLedger)
      .values({
        packageId,
        delta: 0,
        kind: 'extend',
        note: `延长 ${days} 天${note ? `：${note}` : ''}`,
        actor: 'admin',
      })
      .run()
  })
}

/** Records a package sold at the front desk (cash, Alipay code, transfer). */
export function sellPackageOffline(
  deps: Deps,
  input: {
    studentId: number
    productId: number
    amount: number
    method: 'cash' | 'alipay' | 'wechat' | 'transfer'
    note: string
    /** Set for staff who may not change prices: the product must be on sale, at its price. */
    listedPriceOnly?: boolean
    /** What staff were shown the package grants; anything else now refuses the sale. */
    expectedTerms?: PackageTerms
  },
) {
  const now = deps.now()
  return immediate(deps.db, (tx) => {
    const student = tx
      .select({ id: students.id, deletedAt: students.deletedAt })
      .from(students)
      .where(eq(students.id, input.studentId))
      .get()
    if (!student) throw notFound('学员')
    if (student.deletedAt) throw accountDeleted()
    const product = tx
      .select()
      .from(packageProducts)
      .where(eq(packageProducts.id, input.productId))
      .get()
    if (!product) throw notFound('课时包')
    assertTerms(product, input.expectedTerms)
    if (input.listedPriceOnly) {
      if (!product.onSale) throw new ApiError(409, 'product_off_sale', '该课时包已下架')
      const listed = packagePrice(
        {
          price: product.price,
          salePrice: product.salePrice,
          startsAt: product.saleStartsAt,
          endsAt: product.saleEndsAt,
        },
        now,
      ).price
      if (input.amount !== listed) throw listedPriceOnly(listed)
    }
    const order = tx
      .insert(orders)
      .values({
        outTradeNo: newOutTradeNo(now),
        studentId: student.id,
        kind: 'package',
        description: product.name,
        amount: input.amount,
        provider: 'offline',
        offlineMethod: input.method,
        status: 'paid',
        productId: product.id,
        packageTerms: termsOf(product),
        paidAt: now,
        note: input.note,
      })
      .returning({ id: orders.id })
      .get()
    return createPackageFromOrder(tx, order.id, now, 'admin')
  })
}

/** Refused when staff without price rights enter an amount other than the listed price. */
export function listedPriceOnly(listed: number) {
  return new ApiError(
    409,
    'listed_price_only',
    `请按标价 ¥${formatYuan(listed)} 收款，改价请联系管理员`,
  )
}
