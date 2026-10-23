import { venueInstant } from '@rs/shared'
import { and, eq, gt, gte, inArray, lt, sql } from 'drizzle-orm'
import { bookings, coaches, orders, packages, refunds, slots } from '../db/schema'
import type { Deps } from '../deps'
import { ApiError } from '../errors'
import { grantedLessons } from './views'

/** Venue month YYYY-MM to its start and the next month's start. */
function monthRange(month: string) {
  const [y, m] = month.split('-').map(Number)
  if (!y || !m || m < 1 || m > 12) throw new ApiError(400, 'invalid_query', '月份无效')
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
  return { from: venueInstant(`${month}-01`, 0), to: venueInstant(`${next}-01`, 0) }
}

export interface MonthlyReport {
  month: string
  /** Per coach, lessons that started in the month. */
  coaches: {
    id: number
    name: string
    /** Confirmed lessons that have ended. */
    taught: number
    minutes: number
    attended: number
    noShow: number
    unmarked: number
    /** Lessons the venue or the coach cancelled. */
    venueCancelled: number
    /** Student cancels after the deadline. */
    lateCancelled: number
  }[]
  /** Money that moved in the month, in fen. */
  revenue: {
    wechat: number
    offline: number
    byKind: { class: number; trial: number; package: number }
    refunded: number
    net: number
  }
  /** Prepaid lessons not yet taken, as of now. */
  packagesOutstanding: { lessons: number; value: number }
}

export function monthlyReport(deps: Deps, month: string): MonthlyReport {
  const { db } = deps
  const { from, to } = monthRange(month)
  const now = deps.now()

  const lessonRows = db
    .select({
      coachId: slots.coachId,
      status: bookings.status,
      startsAt: bookings.startsAt,
      endsAt: bookings.endsAt,
      attendance: bookings.attendance,
      cancelledBy: bookings.cancelledBy,
      late: bookings.late,
    })
    .from(bookings)
    .innerJoin(slots, eq(slots.id, bookings.slotId))
    .where(
      and(
        gte(bookings.startsAt, from),
        lt(bookings.startsAt, to),
        inArray(bookings.status, ['confirmed', 'cancelled']),
      ),
    )
    .all()
  const coachRows = db
    .select({ id: coaches.id, name: coaches.name, active: coaches.active })
    .from(coaches)
    .orderBy(coaches.sort, coaches.id)
    .all()
  const perCoach = coachRows
    .map((coach) => {
      const mine = lessonRows.filter((l) => l.coachId === coach.id)
      const taught = mine.filter((l) => l.status === 'confirmed' && l.endsAt <= now)
      return {
        id: coach.id,
        name: coach.name,
        active: coach.active,
        taught: taught.length,
        minutes: taught.reduce(
          (sum, l) => sum + (l.endsAt.getTime() - l.startsAt.getTime()) / 60_000,
          0,
        ),
        attended: taught.filter((l) => l.attendance === 'attended').length,
        noShow: taught.filter((l) => l.attendance === 'no_show').length,
        unmarked: taught.filter((l) => l.attendance === null).length,
        venueCancelled: mine.filter((l) => l.status === 'cancelled' && l.cancelledBy === 'venue')
          .length,
        lateCancelled: mine.filter(
          (l) => l.status === 'cancelled' && l.cancelledBy === 'student' && l.late,
        ).length,
      }
    })
    // Former coaches show up only in months they taught.
    .filter((c) => c.active || c.taught + c.venueCancelled + c.lateCancelled > 0)
    .map(({ active: _, ...c }) => c)

  const paid = db
    .select({ provider: orders.provider, kind: orders.kind, amount: orders.amount })
    .from(orders)
    .where(and(eq(orders.status, 'paid'), gte(orders.paidAt, from), lt(orders.paidAt, to)))
    .all()
  const sum = (rows: { amount: number }[]) => rows.reduce((s, r) => s + r.amount, 0)
  // Refunds carry no completion time of their own; the last update is when they succeeded.
  const refunded =
    db
      .select({ total: sql<number>`coalesce(sum(${refunds.amount}), 0)` })
      .from(refunds)
      .where(
        and(
          eq(refunds.status, 'succeeded'),
          gte(refunds.updatedAt, from),
          lt(refunds.updatedAt, to),
        ),
      )
      .get()?.total ?? 0
  const gross = sum(paid)

  const open = db
    .select()
    .from(packages)
    .where(
      and(
        eq(packages.status, 'active'),
        gt(packages.expiresAt, now),
        gt(packages.lessonsRemaining, 0),
      ),
    )
    .all()
  const granted = grantedLessons(
    db,
    open.map((p) => p.id),
  )
  const outstanding = open.reduce(
    (acc, p) => {
      const total = p.lessonsPurchased + (granted.get(p.id) ?? 0)
      acc.lessons += p.lessonsRemaining
      acc.value += total > 0 ? Math.round((p.pricePaid * p.lessonsRemaining) / total) : 0
      return acc
    },
    { lessons: 0, value: 0 },
  )

  return {
    month,
    coaches: perCoach,
    revenue: {
      wechat: sum(paid.filter((p) => p.provider === 'wechat')),
      offline: sum(paid.filter((p) => p.provider === 'offline')),
      byKind: {
        class: sum(paid.filter((p) => p.kind === 'class')),
        trial: sum(paid.filter((p) => p.kind === 'trial')),
        package: sum(paid.filter((p) => p.kind === 'package')),
      },
      refunded: Number(refunded),
      net: gross - Number(refunded),
    },
    packagesOutstanding: outstanding,
  }
}
