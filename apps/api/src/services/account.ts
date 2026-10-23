import { POLICY_VERSION } from '@rs/shared'
import { and, eq, gt, inArray } from 'drizzle-orm'
import { immediate, type Q } from '../db/client'
import { bookings, orders, packages, refunds, sessions, students } from '../db/schema'
import type { Deps } from '../deps'
import { ApiError } from '../errors'
import { newToken } from './ids'

export const accountDeleted = () => new ApiError(409, 'account_deleted', '该学员已注销')

/** Refuses an admin change to a package whose owner deleted their account. */
export function refuseDeletedOwner(tx: Q, packageId: number) {
  const owner = tx
    .select({ deletedAt: students.deletedAt })
    .from(packages)
    .innerJoin(students, eq(students.id, packages.studentId))
    .where(eq(packages.id, packageId))
    .get()
  if (owner?.deletedAt) throw accountDeleted()
}

export function hasAgreedPolicies(student: { policyVersion: string | null }) {
  return student.policyVersion === POLICY_VERSION
}

/** Refuses a request that needs the student's consent to the current policies. */
export function requireConsent(db: Q, studentId: number) {
  const s = db
    .select({ policyVersion: students.policyVersion })
    .from(students)
    .where(eq(students.id, studentId))
    .get()
  if (!s || !hasAgreedPolicies(s)) {
    throw new ApiError(403, 'consent_required', '请先阅读并同意用户协议和隐私政策')
  }
}

export function agreePolicies(deps: Deps, studentId: number, version: string) {
  // The student read an older text than the one now in force.
  if (version !== POLICY_VERSION) {
    throw new ApiError(409, 'policy_changed', '条款已更新，请重新阅读')
  }
  deps.db
    .update(students)
    .set({ policyVersion: version, policyAgreedAt: deps.now() })
    .where(eq(students.id, studentId))
    .run()
}

/**
 * Why the account cannot be deleted yet. Each one is money or a lesson the venue still owes
 * the student, or a payment in flight, which deletion would leave without anyone to settle it.
 */
export function deletionBlockers(tx: Q, studentId: number, now: Date): string[] {
  const blockers: string[] = []
  const liveBooking = tx
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      and(
        eq(bookings.studentId, studentId),
        inArray(bookings.status, ['pending_payment', 'confirmed']),
        gt(bookings.endsAt, now),
      ),
    )
    .get()
  if (liveBooking) blockers.push('还有未上的课程，请先取消')
  const pkgs = tx.select().from(packages).where(eq(packages.studentId, studentId)).all()
  if (pkgs.some((p) => p.status === 'active' && p.lessonsRemaining > 0 && p.expiresAt > now)) {
    blockers.push('课时包还有剩余课时，请先用完或申请退款')
  }
  const orderIds = tx
    .select({ id: orders.id, status: orders.status })
    .from(orders)
    .where(eq(orders.studentId, studentId))
    .all()
  if (orderIds.some((o) => o.status === 'pending')) blockers.push('有未完成的支付，请稍后再试')
  const openRefund =
    orderIds.length > 0 &&
    tx
      .select({ id: refunds.id })
      .from(refunds)
      .where(
        and(
          inArray(
            refunds.orderId,
            orderIds.map((o) => o.id),
          ),
          // Includes package refunds awaiting review. A failed refund still owes the student
          // money until the admin settles it.
          inArray(refunds.status, ['requested', 'pending', 'processing', 'failed']),
        ),
      )
      .get()
  if (openRefund) blockers.push('有退款正在处理，请完成后再注销')
  return blockers
}

/**
 * Deletes the student's account: their name, phone, WeChat identity and the coach's notes on
 * them go, while bookings, orders and refunds stay for the accounts, pointing at an empty row.
 */
export function deleteAccount(deps: Deps, studentId: number) {
  const now = deps.now()
  immediate(deps.db, (tx) => {
    const student = tx.select().from(students).where(eq(students.id, studentId)).get()
    if (!student || student.deletedAt) throw new ApiError(401, 'unauthorized', '请重新登录')
    const blockers = deletionBlockers(tx, studentId, now)
    if (blockers.length) throw new ApiError(409, 'account_in_use', blockers[0] as string)
    tx.update(students)
      .set({
        // Unique and never a real openid, so the next login by this WeChat user is a new account.
        openid: `deleted:${student.id}:${newToken()}`,
        name: '',
        phone: '',
        tester: false,
        policyVersion: null,
        policyAgreedAt: null,
        deletedAt: now,
      })
      .where(eq(students.id, studentId))
      .run()
    tx.update(bookings).set({ coachNote: '' }).where(eq(bookings.studentId, studentId)).run()
    tx.delete(sessions).where(eq(sessions.studentId, studentId)).run()
  })
}
