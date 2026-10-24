import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { POLICY_VERSION } from '@rs/shared'
import { and, eq, gt, inArray, sql } from 'drizzle-orm'
import { immediate, type Q } from '../db/client'
import {
  bookings,
  invoices,
  orders,
  packages,
  refunds,
  sessions,
  studentProfiles,
  students,
} from '../db/schema'
import type { Deps } from '../deps'
import { ApiError } from '../errors'
import { deleteStudentFeedback, removePhotosOf } from './feedback'
import { newToken } from './ids'
import { invoicesDir } from './invoices'

export const accountDeleted = () => new ApiError(409, 'account_deleted', '该学员已注销')

/** What staff and coaches see in place of the name of a student who deleted their account. */
export const DELETED_NAME = '已注销学员'

/** A student's id, name and phone for staff lists. A deleted account's phone is already empty. */
export const personColumns = {
  id: students.id,
  name: sql<string>`case when ${students.deletedAt} is null then ${students.name} else ${DELETED_NAME} end`,
  phone: students.phone,
}

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
  const openInvoice = tx
    .select({ id: invoices.id })
    .from(invoices)
    .where(and(eq(invoices.studentId, studentId), eq(invoices.status, 'requested')))
    .get()
  if (openInvoice) blockers.push('发票申请正在处理，请完成后再注销')
  return blockers
}

/**
 * Deletes the student's account. Their name, phone, WeChat identity, 学员档案, the coach's notes
 * and their lesson feedback with its photos go; bookings, orders, refunds and invoices stay for
 * the accounts, pointing at an empty row.
 */
export function deleteAccount(deps: Deps, studentId: number) {
  const now = deps.now()
  const { files, lessons } = immediate(deps.db, (tx) => {
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
        invoiceTitle: null,
        deletedAt: now,
      })
      .where(eq(students.id, studentId))
      .run()
    tx.update(bookings).set({ coachNote: '' }).where(eq(bookings.studentId, studentId)).run()
    tx.delete(studentProfiles).where(eq(studentProfiles.studentId, studentId)).run()
    tx.delete(sessions).where(eq(sessions.studentId, studentId)).run()
    // Invoices stay for the accounts, without the email. One made out to the student by name
    // loses the name and its PDF; a company's title is not personal data.
    const personal = tx
      .select({ pdfFile: invoices.pdfFile })
      .from(invoices)
      .where(and(eq(invoices.studentId, studentId), eq(invoices.titleKind, 'personal')))
      .all()
    tx.update(invoices).set({ email: '' }).where(eq(invoices.studentId, studentId)).run()
    tx.update(invoices)
      .set({ title: '', pdfFile: null })
      .where(and(eq(invoices.studentId, studentId), eq(invoices.titleKind, 'personal')))
      .run()
    return {
      files: personal.flatMap((r) => (r.pdfFile ? [r.pdfFile] : [])),
      lessons: deleteStudentFeedback(tx, studentId),
    }
  })
  // The account is gone either way; a file left behind is logged rather than failing the request.
  removePhotosOf(deps, lessons)
  for (const file of files) {
    try {
      rmSync(join(invoicesDir(deps), file), { force: true })
    } catch (e) {
      deps.log('invoice file not removed', { file, error: String(e) })
    }
  }
}
