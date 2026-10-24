import {
  type BookingDto,
  type BookingStatus,
  cancelDeadline,
  freeCancelDeadline,
  type PackageDto,
  type PackageStatus,
  studentMoveError,
  type VenueSettings,
} from '@rs/shared'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
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
import { orderInvoices } from './invoices'
import { movedFromIso, moveSummaries } from './move-history'

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
  rules: VenueSettings['booking'],
  now: Date,
): BookingDto[] {
  const ids = rows.map((r) => r.id)
  const slotCoach = new Map<number, { id: number; name: string }>()
  if (ids.length) {
    const coachRows = tx
      .select({ bookingId: bookings.id, id: coaches.id, name: coaches.name })
      .from(bookings)
      .innerJoin(slots, eq(slots.id, bookings.slotId))
      .innerJoin(coaches, eq(coaches.id, slots.coachId))
      .where(inArray(bookings.id, ids))
      .all()
    for (const row of coachRows) slotCoach.set(row.bookingId, { id: row.id, name: row.name })
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
  return rows.map((b) => {
    const status = bookingStatus(b, now)
    const order = orderByBooking.get(b.id)
    const refund = refundByBooking.get(b.id)
    const moved = moves.get(b.id)
    const movesUsed = moved?.studentMoves ?? 0
    const deadline = freeCancelDeadline(b.startsAt, rules, moved?.lastMove)
    return {
      id: b.id,
      status,
      startsAt: b.startsAt.toISOString(),
      endsAt: b.endsAt.toISOString(),
      coach: slotCoach.get(b.id) ?? { id: 0, name: '' },
      lessonType: types.get(b.lessonTypeId) ?? { id: b.lessonTypeId, name: '', isTrial: false },
      paidWith: b.paidWith,
      price: b.price,
      packageName: b.packageId ? (pkgNames.get(b.packageId) ?? null) : null,
      orderId: order?.id ?? null,
      payBy: status === 'pending_payment' ? (order?.expiresAt?.toISOString() ?? null) : null,
      cancelDeadline: deadline.toISOString(),
      movedLate: deadline.getTime() !== cancelDeadline(b.startsAt, rules).getTime(),
      canCancel: (status === 'confirmed' || status === 'pending_payment') && b.startsAt > now,
      canMove: studentMoveError({ status: b.status, deadline, now, movesUsed, rules }) === null,
      movesLeft: Math.max(0, rules.studentMoves - movesUsed),
      movedFrom: movedFromIso(moved, b.startsAt),
      cancelledBy: b.cancelledBy,
      late: b.late,
      refund: refund ? { amount: refund.amount, status: refund.status } : null,
      attendance: b.attendance,
      invoice: order ? (invoiceByOrder.get(order.id) ?? null) : null,
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
  const invoiceByOrder = orderInvoices(
    tx,
    rows.length
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
      refund: refund ? { amount: refund.amount, status: refund.status } : null,
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
