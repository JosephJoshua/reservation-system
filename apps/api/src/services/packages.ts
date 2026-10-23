import { packagePrice, suggestedPackageRefund } from '@rs/shared'
import { and, eq, gt, inArray, sql } from 'drizzle-orm'
import { immediate } from '../db/client'
import {
  bookings,
  lessonTypes,
  orders,
  packageLedger,
  packageProducts,
  packages,
  refunds,
  students,
} from '../db/schema'
import type { Deps } from '../deps'
import { ApiError, notFound } from '../errors'
import type { PaymentParams } from '../pay/gateway'
import { newOutRefundNo, newOutTradeNo } from './ids'
import { closeOrder, createPackageFromOrder, startPayment } from './orders'
import { refundedSoFar, submitRefund } from './refunds'
import { getSettings } from './settings'

/** Starts a WeChat Pay purchase of a package product. */
export async function purchasePackage(
  deps: Deps,
  studentId: number,
  productId: number,
): Promise<{ orderId: number; payment: PaymentParams }> {
  const now = deps.now()
  const orderId = immediate(deps.db, (tx) => {
    const settings = getSettings(tx)
    if (!settings.payment.packagesEnabled) throw new ApiError(409, 'packages_off', '暂不出售课时包')
    const product = tx.select().from(packageProducts).where(eq(packageProducts.id, productId)).get()
    if (!product?.onSale) throw notFound('课时包')
    const lessonType = tx
      .select()
      .from(lessonTypes)
      .where(eq(lessonTypes.id, product.lessonTypeId))
      .get()
    const student = tx.select().from(students).where(eq(students.id, studentId)).get()
    if (!lessonType?.active || !student || (lessonType.adminOnly && !student.tester)) {
      throw notFound('课时包')
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
    return tx
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
        expiresAt: new Date(now.getTime() + settings.payment.timeoutMinutes * 60_000),
      })
      .returning({ id: orders.id })
      .get().id
  })
  const student = deps.db
    .select({ openid: students.openid })
    .from(students)
    .where(eq(students.id, studentId))
    .get()
  try {
    return { orderId, payment: await startPayment(deps, orderId, student?.openid ?? '') }
  } catch (e) {
    await closeOrder(deps, orderId, 'expired').catch(() => {})
    throw e
  }
}

/** Per-class price used to value lessons already taken from a package. */
function perClassPrice(deps: Deps, lessonTypeId: number) {
  return (
    deps.db
      .select({ price: lessonTypes.price })
      .from(lessonTypes)
      .where(eq(lessonTypes.id, lessonTypeId))
      .get()?.price ?? 0
  )
}

/** A student asks for the unused part of a package back. The admin decides the amount. */
export function requestPackageRefund(deps: Deps, studentId: number, packageId: number) {
  const now = deps.now()
  return immediate(deps.db, (tx) => {
    const pkg = tx.select().from(packages).where(eq(packages.id, packageId)).get()
    if (!pkg || pkg.studentId !== studentId) throw notFound('课时包')
    if (pkg.status !== 'active') throw new ApiError(409, 'package_not_active', '该课时包已申请退款')
    if (pkg.expiresAt <= now) throw new ApiError(409, 'package_expired', '课时包已过期')
    if (pkg.lessonsRemaining <= 0) throw new ApiError(409, 'package_empty', '课时包已用完')
    const upcoming = tx
      .select({ id: bookings.id })
      .from(bookings)
      .where(
        and(
          eq(bookings.packageId, pkg.id),
          eq(bookings.status, 'confirmed'),
          gt(bookings.startsAt, now),
        ),
      )
      .get()
    if (upcoming) throw new ApiError(409, 'package_in_use', '请先取消使用该课时包的预约')
    const order = tx.select().from(orders).where(eq(orders.id, pkg.orderId)).get()
    if (!order) throw notFound('订单')
    const amount = suggestedPackageRefund({
      pricePaid: pkg.pricePaid,
      alreadyRefunded: refundedSoFar(tx, order.id),
      lessonsPurchased: pkg.lessonsPurchased,
      lessonsRemaining: pkg.lessonsRemaining,
      perClassPrice: perClassPrice(deps, pkg.lessonTypeId),
    })
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
  immediate(deps.db, (tx) => {
    const refund = tx.select().from(refunds).where(eq(refunds.id, refundId)).get()
    if (!refund?.packageId) throw notFound('退款申请')
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
    // Offline payments are paid back at the front desk, so the refund is done once approved.
    tx.update(refunds)
      .set({
        amount,
        status: order.provider === 'offline' ? 'succeeded' : 'pending',
        updatedAt: now,
      })
      .where(eq(refunds.id, refund.id))
      .run()
  })
  await submitRefund(deps, refundId)
}

export function rejectPackageRefund(deps: Deps, refundId: number, note: string) {
  immediate(deps.db, (tx) => {
    const refund = tx.select().from(refunds).where(eq(refunds.id, refundId)).get()
    if (!refund?.packageId) throw notFound('退款申请')
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
  })
}

/** Admin adds lessons to a package, for make-up lessons or goodwill. */
export function grantLessons(deps: Deps, packageId: number, lessons: number, note: string) {
  immediate(deps.db, (tx) => {
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
    const pkg = tx.select().from(packages).where(eq(packages.id, packageId)).get()
    if (pkg?.status !== 'active')
      throw new ApiError(409, 'package_not_active', '只能延长使用中的课时包')
    const base = Math.max(pkg.expiresAt.getTime(), deps.now().getTime())
    tx.update(packages)
      .set({ expiresAt: new Date(base + days * 86_400_000) })
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
  },
) {
  const now = deps.now()
  return immediate(deps.db, (tx) => {
    const student = tx
      .select({ id: students.id })
      .from(students)
      .where(eq(students.id, input.studentId))
      .get()
    if (!student) throw notFound('学员')
    const product = tx
      .select()
      .from(packageProducts)
      .where(eq(packageProducts.id, input.productId))
      .get()
    if (!product) throw notFound('课时包')
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
        paidAt: now,
        note: input.note,
      })
      .returning({ id: orders.id })
      .get()
    return createPackageFromOrder(tx, order.id, now, 'admin')
  })
}
