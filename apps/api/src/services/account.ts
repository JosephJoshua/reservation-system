import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { POLICY_VERSION } from '@rs/shared'
import { and, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import { immediate, type Q } from '../db/client'
import {
  bookings,
  idempotencyKeys,
  invoices,
  lessonFeedback,
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

// Each reason in the student's words, and in the words staff see when they delete a front-desk
// student.
const BLOCKERS = {
  lesson: ['还有未上的课程，请先取消', '该学员还有未上的课程，请先取消'],
  package: ['课时包还有剩余课时，请先用完或申请退款', '该学员的课时包还有剩余课时，请先用完或退款'],
  payment: ['有未完成的支付，请稍后再试', '该学员有未完成的支付，请稍后再试'],
  anomaly: [
    '有一笔付款异常待场馆处理，请联系场馆',
    '该学员有付款异常待处理，请在订单页处理后再删除',
  ],
  refund: ['有退款正在处理，请完成后再注销', '该学员有退款正在处理，请处理完再删除'],
  invoice: ['发票申请正在处理，请完成后再注销', '该学员的发票申请正在处理，请处理完再删除'],
} as const

/**
 * Why the account cannot be deleted yet. Each one is money or a lesson the venue still owes
 * the student, or a payment in flight, which deletion would leave without anyone to settle it.
 */
export function deletionBlockers(
  tx: Q,
  studentId: number,
  now: Date,
  who: 'student' | 'staff' = 'student',
): string[] {
  const blockers: string[] = []
  const words = (reason: keyof typeof BLOCKERS) => BLOCKERS[reason][who === 'student' ? 0 : 1]
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
  if (liveBooking) blockers.push(words('lesson'))
  const pkgs = tx.select().from(packages).where(eq(packages.studentId, studentId)).all()
  if (pkgs.some((p) => p.status === 'active' && p.lessonsRemaining > 0 && p.expiresAt > now)) {
    blockers.push(words('package'))
  }
  const orderIds = tx
    .select({
      id: orders.id,
      status: orders.status,
      anomaly: orders.anomaly,
      handledAt: orders.anomalyHandledAt,
    })
    .from(orders)
    .where(eq(orders.studentId, studentId))
    .all()
  if (orderIds.some((o) => o.status === 'pending')) blockers.push(words('payment'))
  // A payment WeChat Pay took that could not be applied: staff may still owe the money back.
  if (orderIds.some((o) => o.anomaly && !o.handledAt)) blockers.push(words('anomaly'))
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
  if (openRefund) blockers.push(words('refund'))
  const openInvoice = tx
    .select({ id: invoices.id })
    .from(invoices)
    .where(and(eq(invoices.studentId, studentId), eq(invoices.status, 'requested')))
    .get()
  if (openInvoice) blockers.push(words('invoice'))
  return blockers
}

/**
 * Deletes the student's account. Their name, phone, WeChat identity, 学员档案, the coach's notes
 * and their lesson feedback with its photos go; bookings, orders, refunds and invoices stay for
 * the accounts, pointing at an empty row.
 */
export function deleteAccount(deps: Deps, studentId: number) {
  const now = deps.now()
  const erased = immediate(deps.db, (tx) => {
    const student = tx.select().from(students).where(eq(students.id, studentId)).get()
    if (!student || student.deletedAt) throw new ApiError(401, 'unauthorized', '请重新登录')
    return eraseStudent(tx, student.id, now)
  })
  removeErasedFiles(deps, erased)
}

/**
 * The deletion itself, for the student's own 注销 and for staff removing a front-desk student who
 * never used the mini program. Refuses while the venue still owes the student anything.
 */
export function eraseStudent(
  tx: Q,
  studentId: number,
  now: Date,
  who: 'student' | 'staff' = 'student',
) {
  const blockers = deletionBlockers(tx, studentId, now, who)
  if (blockers.length) throw new ApiError(409, 'account_in_use', blockers[0] as string)
  // Read before it is cleared below.
  const traces = tracesOf(tx, studentId)
  tx.update(students)
    .set({
      // Unique and never a real openid, so the next login by this WeChat user is a new account.
      openid: `deleted:${studentId}:${newToken()}`,
      name: '',
      phone: '',
      tester: false,
      policyVersion: null,
      policyAgreedAt: null,
      invoiceTitle: null,
      bindCode: null,
      bindCodeExpiresAt: null,
      deletedAt: now,
    })
    .where(eq(students.id, studentId))
    .run()
  tx.update(bookings).set({ coachNote: '' }).where(eq(bookings.studentId, studentId)).run()
  tx.delete(studentProfiles).where(eq(studentProfiles.studentId, studentId)).run()
  tx.delete(sessions).where(eq(sessions.studentId, studentId)).run()
  // Responses kept for repeats of their requests hold their name and phone.
  tx.delete(idempotencyKeys).where(eq(idempotencyKeys.studentId, studentId)).run()
  // Staff's and coaches' answers kept for repeats may show them too (a lesson, a booking, their
  // 档案): those lose their answer. Each keeps its status, so a repeat is still not run again.
  // One still running drops its answer when done (see idempotency.ts), as it cannot be told
  // apart once the name is gone.
  const about = tx
    .select({ id: idempotencyKeys.id, body: idempotencyKeys.body })
    .from(idempotencyKeys)
    .where(and(isNull(idempotencyKeys.studentId), isNotNull(idempotencyKeys.body)))
    .all()
    .filter((r) => traces.some((t) => r.body?.includes(t)))
    .map((r) => r.id)
  if (about.length) {
    tx.update(idempotencyKeys)
      .set({ body: null, contentType: null })
      .where(inArray(idempotencyKeys.id, about))
      .run()
  }
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
    studentId,
    files: personal.flatMap((r) => (r.pdfFile ? [r.pdfFile] : [])),
    lessons: deleteStudentFeedback(tx, studentId),
  }
}

/**
 * Text by which a kept answer shows a student: their name and phone, their 档案, the coach's notes
 * and feedback on their lessons, those lessons' photos, their invoices' email and title, and
 * their id where an answer names it. An answer holding none of these says nothing about them.
 */
function tracesOf(tx: Q, studentId: number) {
  const student = tx.select().from(students).where(eq(students.id, studentId)).get()
  const profile = tx
    .select()
    .from(studentProfiles)
    .where(eq(studentProfiles.studentId, studentId))
    .get()
  const lessons = tx
    .select({ id: bookings.id, note: bookings.coachNote, feedback: lessonFeedback.text })
    .from(bookings)
    .leftJoin(lessonFeedback, eq(lessonFeedback.bookingId, bookings.id))
    .where(eq(bookings.studentId, studentId))
    .all()
  const billed = tx
    .select({ email: invoices.email, title: invoices.title })
    .from(invoices)
    .where(eq(invoices.studentId, studentId))
    .all()
  // JSON escapes some characters, so a text is also looked for as it appears in JSON.
  const texts = [
    student?.name,
    student?.phone,
    profile?.note,
    ...(profile?.tags ?? []),
    ...lessons.flatMap((l) => [l.note, l.feedback]),
    ...billed.flatMap((b) => [b.email, b.title]),
  ].flatMap((t) => (t ? [t, JSON.stringify(t).slice(1, -1)] : []))
  return [
    ...new Set([
      ...texts,
      ...lessons.map((l) => `fb${l.id}-`),
      `"studentId":${studentId},`,
      `"studentId":${studentId}}`,
    ]),
  ]
}

/** Removes the files of an erased student once the deletion has committed. */
export function removeErasedFiles(deps: Deps, erased: ReturnType<typeof eraseStudent>) {
  // In the app's log, outside the database, so a deletion undone by a restore can be found and
  // done again (deploy/README.md).
  deps.log('account erased', { studentId: erased.studentId })
  // The account is gone either way; a file left behind is logged rather than failing the request.
  removePhotosOf(deps, erased.lessons)
  for (const file of erased.files) {
    try {
      rmSync(join(invoicesDir(deps), file), { force: true })
    } catch (e) {
      deps.log('invoice file not removed', { file, error: String(e) })
    }
  }
}
