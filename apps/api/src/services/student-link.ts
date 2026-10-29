import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import { immediate, type Q } from '../db/client'
import {
  actionLog,
  bookings,
  idempotencyKeys,
  invoices,
  orders,
  packageNotices,
  packages,
  sessions,
  studentNotices,
  studentProfiles,
  students,
} from '../db/schema'
import type { Deps } from '../deps'
import { ApiError, notFound } from '../errors'
import { accountDeleted, eraseStudent, removeErasedFiles, requireConsent } from './account'
import { logAction } from './action-log'
import { limitedCheck } from './auth'
import { LIVE } from './bookings'
import { hashToken, newBindCode, newToken, normalizeBindCode } from './ids'

/**
 * Students the front desk adds before they use the mini program. Their row holds a placeholder
 * openid starting with `desk:` until they enter the desk's bind code in the mini program, which
 * moves their records onto the WeChat account they are logged in with. Matching never uses the
 * phone: anyone can type anyone's number, but only the person at the desk gets the code.
 */
const DESK_PREFIX = 'desk:'
// Set by eraseStudent in account.ts.
const DELETED_PREFIX = 'deleted:'
const BIND_CODE_MS = 24 * 3_600_000

export const isDeskOpenid = (openid: string) => openid.startsWith(DESK_PREFIX)

/** The same test in SQL: a live front-desk student who has not linked their WeChat. */
export const unlinkedSql = sql`(${students.openid} like ${`${DESK_PREFIX}%`} and ${students.deletedAt} is null)`

/** The openid to send WeChat messages to, or null for a front-desk or deleted student. */
export const wechatOpenid = (openid: string | null | undefined) =>
  openid && !isDeskOpenid(openid) && !openid.startsWith(DELETED_PREFIX) ? openid : null

/** Live students other than `exceptId` with this phone, for the desk's duplicate warning. */
export function samePhone(tx: Q, phone: string, exceptId?: number) {
  return tx
    .select({ id: students.id, name: students.name })
    .from(students)
    .where(
      and(
        eq(students.phone, phone),
        exceptId ? ne(students.id, exceptId) : undefined,
        isNull(students.deletedAt),
      ),
    )
    .limit(5)
    .all()
}

export function createDeskStudent(
  deps: Deps,
  staffId: number,
  input: { name: string; phone: string; force: boolean },
) {
  const now = deps.now()
  return immediate(deps.db, (tx) => {
    const same = samePhone(tx, input.phone)
    if (same.length && !input.force) {
      const first = same[0] as { id: number; name: string }
      throw new ApiError(409, 'phone_exists', `该手机号已是学员「${first.name || '未填写姓名'}」`)
    }
    const row = tx
      .insert(students)
      .values({ openid: `${DESK_PREFIX}${newToken()}`, name: input.name, phone: input.phone })
      .returning({ id: students.id })
      .get()
    logAction(tx, now, staffId, {
      action: 'student.create',
      summary: '前台建档',
      studentId: row.id,
      target: { kind: 'student', id: row.id },
    })
    return row
  })
}

function deskStudent(tx: Q, id: number) {
  const s = tx.select().from(students).where(eq(students.id, id)).get()
  if (!s) throw notFound('学员')
  if (s.deletedAt) throw accountDeleted()
  if (!isDeskOpenid(s.openid)) throw new ApiError(409, 'already_bound', '该学员已绑定微信')
  return s
}

/** A new one-time code for a front-desk student, replacing any earlier one. */
export function newStudentBindCode(deps: Deps, studentId: number) {
  const code = newBindCode()
  const expiresAt = new Date(deps.now().getTime() + BIND_CODE_MS)
  immediate(deps.db, (tx) => {
    deskStudent(tx, studentId)
    tx.update(students)
      .set({ bindCode: code, bindCodeExpiresAt: expiresAt })
      .where(eq(students.id, studentId))
      .run()
  })
  return { code, expiresAt }
}

/** Staff remove a front-desk student who never used the mini program, at their request. */
export function deleteDeskStudent(deps: Deps, staffId: number, studentId: number) {
  const now = deps.now()
  const erased = immediate(deps.db, (tx) => {
    deskStudent(tx, studentId)
    const erased = eraseStudent(tx, studentId, now, 'staff')
    logAction(tx, now, staffId, {
      action: 'student.delete',
      summary: '删除未绑定微信的学员',
      studentId,
      target: { kind: 'student', id: studentId },
    })
    return erased
  })
  removeErasedFiles(deps, erased)
}

const badCode = () => new ApiError(400, 'bad_bind_code', '绑定码无效或已过期，请到前台重新获取')

/**
 * Links the logged-in student to the front-desk student holding `code`. The desk student keeps
 * their id, so staff looking at them see the change; the WeChat account's own bookings, packages
 * and orders move onto it, its sessions follow, and its now empty row is removed. Entering the
 * same code again from the same WeChat answers the same way.
 */
export function linkDeskStudent(
  deps: Deps,
  token: string,
  code: string,
  { merge = false }: { merge?: boolean } = {},
) {
  const now = deps.now()
  const normalized = normalizeBindCode(code)
  return immediate(deps.db, (tx) => {
    // Read inside the transaction: a request that started before a link committed must see the
    // student its session belongs to now.
    const studentId = tx
      .select({ studentId: sessions.studentId })
      .from(sessions)
      .where(and(eq(sessions.tokenHash, hashToken(token)), eq(sessions.role, 'student')))
      .get()?.studentId
    if (!studentId) throw new ApiError(401, 'unauthorized', '请重新登录')
    const desk = tx.select().from(students).where(eq(students.bindCode, normalized)).get()
    // Already linked to this WeChat: a repeat of the request that did it.
    if (desk && desk.id === studentId) return { studentId }
    requireConsent(tx, studentId)
    limitedCheck(
      deps,
      `bind:${studentId}`,
      () =>
        Boolean(
          desk &&
            !desk.deletedAt &&
            isDeskOpenid(desk.openid) &&
            desk.bindCodeExpiresAt &&
            desk.bindCodeExpiresAt > now,
        ),
      badCode(),
    )
    if (!desk) throw badCode()
    const own = tx.select().from(students).where(eq(students.id, studentId)).get()
    if (!own || own.deletedAt) throw new ApiError(401, 'unauthorized', '请重新登录')
    // Checked before asking, so the student is not asked to confirm a join that cannot happen.
    refuseClashingLessons(tx, own.id, desk.id, now)
    // One WeChat is one student. Records of its own mean someone already uses it, perhaps a
    // parent for themselves: joining the two must be what they want.
    if (!merge && hasRecords(tx, own.id)) {
      throw new ApiError(
        409,
        'confirm_merge',
        '这个微信已有课时包、预约或订单，同步后会和前台记录合并为同一位学员',
      )
    }

    // Records move onto the desk student.
    for (const t of [bookings, packages, orders, invoices, actionLog] as const) {
      tx.update(t).set({ studentId: desk.id }).where(eq(t.studentId, own.id)).run()
    }
    tx.update(actionLog)
      .set({ targetId: desk.id })
      .where(and(eq(actionLog.targetKind, 'student'), eq(actionLog.targetId, own.id)))
      .run()
    retrySkippedNotices(tx, desk.id)
    keepNewerProfile(tx, own.id, desk.id)
    tx.update(sessions).set({ studentId: desk.id }).where(eq(sessions.studentId, own.id)).run()
    // Answers kept for the WeChat account's repeats go with it, so erasing the student drops them.
    tx.update(idempotencyKeys)
      .set({ studentId: desk.id })
      .where(eq(idempotencyKeys.studentId, own.id))
      .run()
    // The openid is unique, so the WeChat account's row is removed before the desk row takes it.
    tx.delete(students).where(eq(students.id, own.id)).run()
    tx.update(students)
      .set({
        openid: own.openid,
        // The desk wrote down the person who comes to class; the WeChat may be a parent's.
        name: desk.name || own.name,
        phone: desk.phone || own.phone,
        tester: own.tester || desk.tester,
        policyVersion: own.policyVersion,
        policyAgreedAt: own.policyAgreedAt,
        invoiceTitle: own.invoiceTitle ?? desk.invoiceTitle,
      })
      .where(eq(students.id, desk.id))
      .run()
    return { studentId: desk.id }
  })
}

/**
 * One student cannot hold two seats of one lesson, which the database refuses, nor be in two
 * lessons at once. Accounts booked like that are left for the desk to sort out before joining.
 */
function refuseClashingLessons(tx: Q, a: number, b: number, now: Date) {
  const live = (id: number) =>
    tx
      .select({ slotId: bookings.slotId, startsAt: bookings.startsAt, endsAt: bookings.endsAt })
      .from(bookings)
      .where(and(eq(bookings.studentId, id), inArray(bookings.status, LIVE)))
      .all()
  const theirs = live(b)
  const clash = live(a).some((x) =>
    theirs.some(
      (y) =>
        x.slotId === y.slotId ||
        (x.endsAt > now && y.endsAt > now && x.startsAt < y.endsAt && y.startsAt < x.endsAt),
    ),
  )
  if (clash) {
    throw new ApiError(409, 'lesson_clash', '两边在同一时间都有预约，请先到前台取消其中一节再绑定')
  }
}

function hasRecords(tx: Q, studentId: number) {
  return [bookings, packages, orders].some((t) =>
    tx.select({ id: t.id }).from(t).where(eq(t.studentId, studentId)).get(),
  )
}

/**
 * Messages that could not go out while the student had no WeChat get another try. The sweepers
 * still drop the ones that are out of date by now.
 */
function retrySkippedNotices(tx: Q, studentId: number) {
  const reset = { doneAt: null, result: null, retryAt: null }
  tx.update(studentNotices)
    .set(reset)
    .where(
      and(
        eq(studentNotices.result, 'skipped'),
        inArray(
          studentNotices.bookingId,
          tx.select({ id: bookings.id }).from(bookings).where(eq(bookings.studentId, studentId)),
        ),
      ),
    )
    .run()
  tx.update(packageNotices)
    .set(reset)
    .where(
      and(
        eq(packageNotices.result, 'skipped'),
        inArray(
          packageNotices.packageId,
          tx.select({ id: packages.id }).from(packages).where(eq(packages.studentId, studentId)),
        ),
      ),
    )
    .run()
}

/** Each account may have a 学员档案; the one saved last stays. */
function keepNewerProfile(tx: Q, from: number, to: number) {
  const theirs = tx.select().from(studentProfiles).where(eq(studentProfiles.studentId, from)).get()
  if (!theirs) return
  const ours = tx.select().from(studentProfiles).where(eq(studentProfiles.studentId, to)).get()
  if (ours && ours.updatedAt >= theirs.updatedAt) {
    tx.delete(studentProfiles).where(eq(studentProfiles.studentId, from)).run()
    return
  }
  if (ours) tx.delete(studentProfiles).where(eq(studentProfiles.studentId, to)).run()
  tx.update(studentProfiles).set({ studentId: to }).where(eq(studentProfiles.studentId, from)).run()
}
