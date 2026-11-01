import {
  type BookingDto,
  type BookingStatus,
  cancelDeadline,
  freeCancelDeadline,
  type PackageDto,
  type PackageStatus,
  type RefundDto,
  studentMoveError,
} from '@rs/shared'
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm'
import type { Q } from '../db/client'
import {
  bookings,
  coaches,
  lessonTypes,
  orders,
  packageLedger,
  packages,
  refunds,
  slots,
} from '../db/schema'
import { studentCanCheckIn } from './attendance'
import { disruptions } from './disruption'
import { visibleFeedback, withVisibleFeedback } from './feedback'
import { orderInvoices } from './invoices'
import { movedFromIso, moveSummaries } from './move-history'
import { autoRefundWhy } from './refunds'
import { getSettings, ruleBook } from './settings'

type BookingRow = typeof bookings.$inferSelect
type PackageRow = typeof packages.$inferSelect

export function bookingStatus(b: Pick<BookingRow, 'status' | 'endsAt'>, now: Date): BookingStatus {
  return b.status === 'confirmed' && b.endsAt <= now ? 'completed' : b.status
}

export function packageStatus(p: PackageRow, now: Date): PackageStatus {
  if (p.status !== 'active') return p.status
  if (p.expiresAt <= now) return 'expired'
  if (p.lessonsRemaining <= 0) return 'used_up'
  return 'active'
}

/** A refund as the student sees it: how much, how far, and how staff paid it back if they did. */
function refundView(r: typeof refunds.$inferSelect): RefundDto {
  return {
    amount: r.amount,
    status: r.status,
    settledHow: r.settledHow,
    abnormal: r.abnormal,
    ...(r.status === 'rejected' && r.failure ? { rejectReason: r.failure } : {}),
  }
}

/** Latest refund per key, preferring one that is not rejected. */
function latestRefunds<K extends 'bookingId' | 'packageId'>(tx: Q, key: K, ids: number[]) {
  const map = new Map<number, typeof refunds.$inferSelect>()
  if (ids.length === 0) return map
  const rows = tx.select().from(refunds).where(inArray(refunds[key], ids)).orderBy(refunds.id).all()
  for (const r of rows) {
    const id = r[key]
    if (id === null) continue
    // A rejected request does not hide an earlier refund that actually happened.
    if (r.status !== 'rejected' || (map.get(id)?.status ?? 'rejected') === 'rejected')
      map.set(id, r)
  }
  return map
}

export function bookingViews(
  tx: Q,
  rows: BookingRow[],
  now: Date,
  /** Carries the feedback itself, for one booking's page; lists only say whether there is one. */
  withFeedback = false,
): BookingDto[] {
  const ids = rows.map((r) => r.id)
  const { selfCheckIn } = getSettings(tx).attendance
  const rulesBook = ruleBook(tx)
  const slotCoach = new Map<number, { id: number; name: string }>()
  const capacity = new Map<number, number>()
  if (ids.length) {
    const coachRows = tx
      .select({
        bookingId: bookings.id,
        id: coaches.id,
        name: coaches.name,
        capacity: slots.capacity,
      })
      .from(bookings)
      .innerJoin(slots, eq(slots.id, bookings.slotId))
      .innerJoin(coaches, eq(coaches.id, slots.coachId))
      .where(inArray(bookings.id, ids))
      .all()
    for (const row of coachRows) {
      slotCoach.set(row.bookingId, { id: row.id, name: row.name })
      capacity.set(row.bookingId, row.capacity)
    }
  }
  const types = new Map(
    tx
      .select()
      .from(lessonTypes)
      .all()
      .map((t) => [t.id, { id: t.id, name: t.name, isTrial: t.isTrial }]),
  )
  const pkgNames = new Map<number, string>()
  const pkgIds = rows.flatMap((r) => (r.packageId ? [r.packageId] : []))
  if (pkgIds.length) {
    for (const p of tx
      .select({ id: packages.id, name: packages.name })
      .from(packages)
      .where(inArray(packages.id, pkgIds))
      .all()) {
      pkgNames.set(p.id, p.name)
    }
  }
  const orderByBooking = new Map(
    ids.length
      ? tx
          .select()
          .from(orders)
          .where(inArray(orders.bookingId, ids))
          .all()
          .map((o) => [o.bookingId ?? 0, o])
      : [],
  )
  const refundByBooking = latestRefunds(tx, 'bookingId', ids)
  const invoiceByOrder = orderInvoices(tx, [...orderByBooking.values()])
  const moves = moveSummaries(tx, ids)
  // Lessons still ahead can be cancelled, so those are checked; a booked one until it ends too,
  // so a student running late is not sent to it. An unpaid hold that lapsed is checked while its
  // lesson is ahead: what stands in its way now, which a refunded one says from its refund.
  const disrupted = disruptions(
    tx,
    rows.filter((b) =>
      b.status === 'confirmed'
        ? b.endsAt > now
        : (b.status === 'pending_payment' || b.status === 'expired') && b.startsAt > now,
    ),
  )
  const feedback = withFeedback ? visibleFeedback(tx, ids) : null
  const hasFeedback = feedback ? new Set(feedback.keys()) : withVisibleFeedback(tx, ids)
  return rows.map((b) => {
    const status = bookingStatus(b, now)
    const order = orderByBooking.get(b.id)
    const refund = refundByBooking.get(b.id)
    const moved = moves.get(b.id)
    const movesUsed = moved?.studentMoves ?? 0
    const rules = rulesBook.termsOf(b)
    const type = rulesBook.of(b.lessonTypeId)
    const disruption = disrupted.get(b.id) ?? null
    // Free to cancel until the start, still shown as such once it has started; nothing to
    // cancel for a lapsed hold.
    const deadline = freeCancelDeadline(
      b.startsAt,
      rules,
      moved?.lastMove,
      status === 'expired' ? null : disruption,
    )
    const expiredWhy = status === 'expired' && refund ? autoRefundWhy(refund.reason) : null
    return {
      id: b.id,
      slotId: b.slotId,
      status,
      startsAt: b.startsAt.toISOString(),
      endsAt: b.endsAt.toISOString(),
      coach: slotCoach.get(b.id) ?? { id: 0, name: '' },
      lessonType: types.get(b.lessonTypeId) ?? { id: b.lessonTypeId, name: '', isTrial: false },
      capacity: capacity.get(b.id) ?? 1,
      paidWith: b.paidWith,
      price: b.price,
      paidOffline: order?.provider === 'offline',
      packageName: b.packageId ? (pkgNames.get(b.packageId) ?? null) : null,
      orderId: order?.id ?? null,
      paymentIssue: order?.anomaly ? (order.anomalyHandledAt ? 'handled' : 'open') : null,
      payBy: status === 'pending_payment' ? (order?.expiresAt?.toISOString() ?? null) : null,
      cancelDeadline: deadline.toISOString(),
      movedLate:
        freeCancelDeadline(b.startsAt, rules, moved?.lastMove).getTime() !==
        cancelDeadline(b.startsAt, rules).getTime(),
      disruption: expiredWhy ? null : disruption,
      expiredWhy,
      canCancel: (status === 'confirmed' || status === 'pending_payment') && b.startsAt > now,
      canMove: studentMoveError({ status: b.status, deadline, now, movesUsed, rules }) === null,
      movesLeft: Math.max(0, rules.studentMoves - movesUsed),
      terms: rules,
      window: { advanceDays: type.advanceDays, minNoticeMinutes: type.minNoticeMinutes },
      movedFrom: movedFromIso(moved, b.startsAt),
      cancelledBy: b.cancelledBy,
      cancelReason: b.cancelledBy === 'venue' ? (b.cancelReason ?? '') : '',
      late: b.late,
      refund: refund ? refundView(refund) : null,
      attendance: b.attendance,
      canCheckIn: !disruption && studentCanCheckIn(b, now, selfCheckIn),
      invoice: order ? (invoiceByOrder.get(order.id) ?? null) : null,
      hasFeedback: hasFeedback.has(b.id),
      feedback: feedback?.get(b.id) ?? null,
    }
  })
}

/** Lessons the admin granted to each package, on top of what was bought. */
export function grantedLessons(tx: Q, ids: number[]): Map<number, number> {
  if (ids.length === 0) return new Map()
  const rows = tx
    .select({ packageId: packageLedger.packageId, n: sql<number>`sum(${packageLedger.delta})` })
    .from(packageLedger)
    .where(and(inArray(packageLedger.packageId, ids), eq(packageLedger.kind, 'grant')))
    .groupBy(packageLedger.packageId)
    .all()
  return new Map(rows.map((r) => [r.packageId, Number(r.n)]))
}

export function packageViews(tx: Q, rows: PackageRow[], now: Date): PackageDto[] {
  const types = new Map(
    tx
      .select({ id: lessonTypes.id, name: lessonTypes.name })
      .from(lessonTypes)
      .all()
      .map((t) => [t.id, t.name]),
  )
  const ids = rows.map((r) => r.id)
  const refundByPackage = latestRefunds(tx, 'packageId', ids)
  const granted = grantedLessons(tx, ids)
  const packageOrders = rows.length
    ? tx
        .select()
        .from(orders)
        .where(
          inArray(
            orders.id,
            rows.map((p) => p.orderId),
          ),
        )
        .all()
    : []
  const invoiceByOrder = orderInvoices(tx, packageOrders)
  const offline = new Set(packageOrders.filter((o) => o.provider === 'offline').map((o) => o.id))
  // As refundablePackage counts them: a lesson in progress still holds the package.
  const inUse = new Set(
    ids.length
      ? tx
          .select({ packageId: bookings.packageId })
          .from(bookings)
          .where(
            and(
              inArray(bookings.packageId, ids),
              eq(bookings.status, 'confirmed'),
              gt(bookings.endsAt, now),
            ),
          )
          .all()
          .map((b) => b.packageId)
      : [],
  )
  return rows.map((p) => {
    const refund = refundByPackage.get(p.id)
    return {
      id: p.id,
      name: p.name,
      lessonTypeId: p.lessonTypeId,
      lessonTypeName: types.get(p.lessonTypeId) ?? '',
      coachIds: p.coachIds,
      lessonsPurchased: p.lessonsPurchased,
      lessonsGranted: granted.get(p.id) ?? 0,
      lessonsRemaining: p.lessonsRemaining,
      expiresAt: p.expiresAt.toISOString(),
      status: packageStatus(p, now),
      pricePaid: p.pricePaid,
      paidOffline: offline.has(p.orderId),
      inUse: inUse.has(p.id),
      refund: refund ? refundView(refund) : null,
      invoice: invoiceByOrder.get(p.orderId) ?? null,
    }
  })
}

export function studentPackages(tx: Q, studentId: number, now: Date) {
  return packageViews(
    tx,
    tx
      .select()
      .from(packages)
      .where(eq(packages.studentId, studentId))
      .orderBy(desc(packages.id))
      .all(),
    now,
  )
}
