import {
  bucketOf,
  DORMANT_DAYS,
  type DormantStudent,
  daysBetween,
  STATS_MAX_DAYS,
  type StatsReport,
  statsBuckets,
  statsGrain,
  UNMARKED_DAYS,
  venueDateKey,
  venueInstant,
  venueParts,
} from '@rs/shared'
import { and, asc, eq, gte, inArray, isNull, lt, lte, sql } from 'drizzle-orm'
import {
  bookings,
  coaches,
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
import { ApiError } from '../errors'
import { onePerSession } from './coach-pay'
import { grantedLessons } from './views'

const DAY = 24 * 60 * 60 * 1000

/** How long after a package runs out a new one still counts as a renewal. */
export const RENEW_DAYS = 30

function addDays(dateKey: string, days: number) {
  return venueDateKey(new Date(venueInstant(dateKey, 12 * 60).getTime() + days * DAY))
}
/** Adds to one step of a per-step series. */
function add(series: number[], i: number, value: number) {
  if (i >= 0) series[i] = (series[i] ?? 0) + value
}

const minutesOf = (s: { startsAt: Date; endsAt: Date }) =>
  (s.endsAt.getTime() - s.startsAt.getTime()) / 60_000

/** Payments less the refunds that went through, in fen, from `from` up to `to`. */
function netRevenue(deps: Deps, from: Date, to: Date) {
  const paid = deps.db
    .select({ amount: orders.amount })
    .from(orders)
    .where(and(eq(orders.status, 'paid'), gte(orders.paidAt, from), lt(orders.paidAt, to)))
    .all()
  // Refunds carry no completion time of their own; the last update is when they succeeded.
  const refunded = deps.db
    .select({ amount: refunds.amount })
    .from(refunds)
    .where(
      and(eq(refunds.status, 'succeeded'), gte(refunds.updatedAt, from), lt(refunds.updatedAt, to)),
    )
    .all()
  const sum = (rows: { amount: number }[]) => rows.reduce((s, r) => s + r.amount, 0)
  return sum(paid) - sum(refunded)
}

/** When each student took their first lesson: the start of their earliest lesson that ended. */
function firstLessons(deps: Deps, now: Date) {
  const rows = deps.db
    .select({ studentId: bookings.studentId, first: sql<number>`min(${bookings.startsAt})` })
    .from(bookings)
    .where(and(eq(bookings.status, 'confirmed'), lte(bookings.endsAt, now)))
    .groupBy(bookings.studentId)
    .all()
  return new Map(rows.map((r) => [r.studentId, new Date(Number(r.first))]))
}

/** Students whose first lesson started from `from` up to `to`. */
const newStudents = (first: Map<number, Date>, from: Date, to: Date) =>
  [...first.values()].filter((d) => d >= from && d < to).length

export interface TodaySession {
  slotId: number
  startsAt: Date
  endsAt: Date
  coach: string
  lessonType: string
  /** Seats for a group session, null for a private lesson. */
  capacity: number | null
  students: {
    bookingId: number
    student: { id: number; name: string; phone: string }
    attendance: 'attended' | 'no_show' | null
  }[]
}

/** What the admin home page shows on top of the to-do counts. */
export function dashboard(deps: Deps) {
  const { db } = deps
  const now = deps.now()
  const today = venueDateKey(now)
  const dayStart = venueInstant(today, 0)

  const rows = db
    .select({
      bookingId: bookings.id,
      slotId: bookings.slotId,
      startsAt: bookings.startsAt,
      endsAt: bookings.endsAt,
      attendance: bookings.attendance,
      coach: coaches.name,
      coachSort: coaches.sort,
      lessonType: lessonTypes.name,
      group: slots.lessonTypeId,
      capacity: slots.capacity,
      studentId: students.id,
      name: students.name,
      phone: students.phone,
    })
    .from(bookings)
    .innerJoin(slots, eq(slots.id, bookings.slotId))
    .innerJoin(coaches, eq(coaches.id, slots.coachId))
    .innerJoin(lessonTypes, eq(lessonTypes.id, bookings.lessonTypeId))
    .innerJoin(students, eq(students.id, bookings.studentId))
    .where(
      and(
        eq(bookings.status, 'confirmed'),
        gte(bookings.startsAt, dayStart),
        lt(bookings.startsAt, venueInstant(today, 24 * 60)),
      ),
    )
    .orderBy(asc(bookings.startsAt), asc(coaches.sort), asc(coaches.id), asc(bookings.seat))
    .all()
  const sessions = new Map<number, TodaySession>()
  for (const r of rows) {
    let s = sessions.get(r.slotId)
    if (!s) {
      s = {
        slotId: r.slotId,
        startsAt: r.startsAt,
        endsAt: r.endsAt,
        coach: r.coach,
        lessonType: r.lessonType,
        capacity: r.group === null ? null : r.capacity,
        students: [],
      }
      sessions.set(r.slotId, s)
    }
    s.students.push({
      bookingId: r.bookingId,
      student: { id: r.studentId, name: r.name, phone: r.phone },
      attendance: r.attendance,
    })
  }

  // This month so far, against the same stretch of last month.
  const { year, month } = venueParts(now)
  const monthKey = `${year}-${String(month).padStart(2, '0')}-01`
  const lastKey =
    month === 1 ? `${year - 1}-12-01` : `${year}-${String(month - 1).padStart(2, '0')}-01`
  const monthStart = venueInstant(monthKey, 0)
  const lastStart = venueInstant(lastKey, 0)
  const lastEnd = new Date(
    Math.min(lastStart.getTime() + (now.getTime() - monthStart.getTime()), monthStart.getTime()),
  )
  const first = firstLessons(deps, now)

  const unmarked = db
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      and(
        eq(bookings.status, 'confirmed'),
        isNull(bookings.attendance),
        lte(bookings.endsAt, now),
        gte(bookings.startsAt, venueInstant(addDays(today, -UNMARKED_DAYS), 0)),
      ),
    )
    .all().length

  return {
    date: today,
    sessions: [...sessions.values()],
    /** Lessons that ended, from UNMARKED_DAYS venue days ago, with no attendance marked. */
    unmarked,
    revenue: {
      today: netRevenue(deps, dayStart, now),
      month: netRevenue(deps, monthStart, now),
      lastMonth: netRevenue(deps, lastStart, lastEnd),
    },
    newStudents: {
      month: newStudents(first, monthStart, now),
      lastMonth: newStudents(first, lastStart, lastEnd),
    },
  }
}

/** The value of one lesson from each package: what was paid over the lessons it holds. */
function lessonValues(deps: Deps) {
  const rows = deps.db.select().from(packages).all()
  const granted = grantedLessons(
    deps.db,
    rows.map((p) => p.id),
  )
  const values = new Map<number, number>()
  for (const p of rows) {
    const total = p.lessonsPurchased + (granted.get(p.id) ?? 0)
    values.set(p.id, total > 0 ? p.pricePaid / total : 0)
  }
  return { values, rows }
}

export function statsReport(deps: Deps, from: string, requestedTo: string): StatsReport {
  const { db } = deps
  const now = deps.now()
  const today = venueDateKey(now)
  // Nothing has happened after today yet.
  const to = requestedTo > today ? today : requestedTo
  try {
    venueInstant(from, 0)
    venueInstant(requestedTo, 0)
  } catch {
    throw new ApiError(400, 'invalid_query', '日期无效')
  }
  if (from > to) throw new ApiError(400, 'invalid_query', '开始日期需早于结束日期')
  if (daysBetween(from, to) > STATS_MAX_DAYS) {
    throw new ApiError(400, 'invalid_query', `最多统计 ${STATS_MAX_DAYS} 天`)
  }

  const buckets = statsBuckets(from, to)
  const zeros = () => buckets.map(() => 0)
  const at = (d: Date) => bucketOf(buckets, venueDateKey(d))
  const start = venueInstant(from, 0)
  const end = new Date(Math.min(venueInstant(to, 24 * 60).getTime(), now.getTime()))

  // Money in and out.
  const paid = zeros()
  const refunded = zeros()
  const paidOrders = db
    .select()
    .from(orders)
    .where(and(eq(orders.status, 'paid'), gte(orders.paidAt, start), lt(orders.paidAt, end)))
    .all()
  for (const o of paidOrders) if (o.paidAt) add(paid, at(o.paidAt), o.amount)
  for (const r of db
    .select({ amount: refunds.amount, at: refunds.updatedAt })
    .from(refunds)
    .where(
      and(
        eq(refunds.status, 'succeeded'),
        gte(refunds.updatedAt, start),
        lt(refunds.updatedAt, end),
      ),
    )
    .all()) {
    add(refunded, at(r.at), r.amount)
  }

  // Lessons that took place in the range, and late cancels, which are taken too.
  const lessonRows = db
    .select({
      id: bookings.id,
      slotId: bookings.slotId,
      sessionOf: slots.lessonTypeId,
      studentId: bookings.studentId,
      status: bookings.status,
      startsAt: bookings.startsAt,
      endsAt: bookings.endsAt,
      attendance: bookings.attendance,
      cancelledBy: bookings.cancelledBy,
      late: bookings.late,
      paidWith: bookings.paidWith,
      packageId: bookings.packageId,
    })
    .from(bookings)
    .innerJoin(slots, eq(slots.id, bookings.slotId))
    .where(
      and(
        gte(bookings.startsAt, start),
        lt(bookings.startsAt, end),
        lte(bookings.endsAt, now),
        inArray(bookings.status, ['confirmed', 'cancelled']),
      ),
    )
    .all()
  const taken = lessonRows.filter((l) => l.status === 'confirmed')
  const forfeited = lessonRows.filter(
    (l) => l.status === 'cancelled' && l.cancelledBy === 'student' && l.late,
  )

  const lessons = zeros()
  for (const l of onePerSession(taken)) add(lessons, at(l.startsAt), 1)

  // 课消: a package lesson is worth its share of the package price, a paid lesson what was kept
  // of its payment. A late cancel that gave the lesson back is worth nothing.
  const { values, rows: allPackages } = lessonValues(deps)
  const consumedIds = [...taken, ...forfeited].map((l) => l.id)
  const returned = new Set(
    consumedIds.length
      ? db
          .select({ bookingId: packageLedger.bookingId })
          .from(packageLedger)
          .where(
            and(eq(packageLedger.kind, 'return'), inArray(packageLedger.bookingId, consumedIds)),
          )
          .all()
          .map((r) => r.bookingId)
      : [],
  )
  const kept = new Map<number, number>()
  if (consumedIds.length) {
    const lessonOrders = db
      .select({ id: orders.id, bookingId: orders.bookingId, amount: orders.amount })
      .from(orders)
      .where(and(eq(orders.status, 'paid'), inArray(orders.bookingId, consumedIds)))
      .all()
    const back = new Map<number, number>()
    if (lessonOrders.length) {
      for (const r of db
        .select({ orderId: refunds.orderId, amount: refunds.amount })
        .from(refunds)
        .where(
          and(
            inArray(
              refunds.orderId,
              lessonOrders.map((o) => o.id),
            ),
            inArray(refunds.status, ['pending', 'processing', 'succeeded']),
          ),
        )
        .all()) {
        back.set(r.orderId, (back.get(r.orderId) ?? 0) + r.amount)
      }
    }
    for (const o of lessonOrders) {
      if (o.bookingId !== null) kept.set(o.bookingId, o.amount - (back.get(o.id) ?? 0))
    }
  }
  const consumed = zeros()
  for (const l of [...taken, ...forfeited]) {
    if (returned.has(l.id)) continue
    const value =
      l.paidWith === 'package' && l.packageId !== null
        ? (values.get(l.packageId) ?? 0)
        : (kept.get(l.id) ?? 0)
    add(consumed, at(l.startsAt), value)
  }

  const attendance = {
    attended: taken.filter((l) => l.attendance === 'attended').length,
    noShow: taken.filter((l) => l.attendance === 'no_show').length,
    unmarked: taken.filter((l) => l.attendance === null).length,
  }

  // New and returning students, by their first lesson ever.
  const first = firstLessons(deps, now)
  const isNew = (studentId: number, from: Date, to: Date) => {
    const d = first.get(studentId)
    return !!d && d >= from && d < to
  }
  const studentsNew = zeros()
  const studentsReturning = zeros()
  buckets.forEach((b, i) => {
    const bFrom = venueInstant(b.from, 0)
    const bTo = venueInstant(b.to, 0)
    const ids = new Set(taken.filter((l) => at(l.startsAt) === i).map((l) => l.studentId))
    for (const id of ids) {
      if (isNew(id, bFrom, bTo)) add(studentsNew, i, 1)
      else add(studentsReturning, i, 1)
    }
  })
  const rangeIds = new Set(taken.map((l) => l.studentId))
  const totalNew = [...rangeIds].filter((id) => isNew(id, start, end)).length

  // Coach hours and the busy times, from lessons on offer that have ended.
  const slotRows = db
    .select({
      id: slots.id,
      coachId: slots.coachId,
      startsAt: slots.startsAt,
      endsAt: slots.endsAt,
      open: slots.open,
      lessonTypeId: slots.lessonTypeId,
      capacity: slots.capacity,
    })
    .from(slots)
    .where(
      and(
        gte(slots.startsAt, start),
        lt(slots.startsAt, end),
        lte(slots.endsAt, now),
        isNull(slots.cancelledAt),
      ),
    )
    .all()
  const seatsTaken = new Map<number, number>()
  for (const l of taken) seatsTaken.set(l.slotId, (seatsTaken.get(l.slotId) ?? 0) + 1)
  // A closed lesson with no one in it was not on offer.
  const offered = slotRows.filter((s) => s.open || seatsTaken.has(s.id))

  const coachRows = db
    .select({ id: coaches.id, name: coaches.name, active: coaches.active })
    .from(coaches)
    .orderBy(coaches.sort, coaches.id)
    .all()
  const coachStats = coachRows
    .map((c) => {
      const mine = offered.filter((s) => s.coachId === c.id)
      return {
        id: c.id,
        name: c.name,
        active: c.active,
        offeredMinutes: mine.reduce((sum, s) => sum + minutesOf(s), 0),
        bookedMinutes: mine
          .filter((s) => seatsTaken.has(s.id))
          .reduce((sum, s) => sum + minutesOf(s), 0),
      }
    })
    .filter((c) => c.active || c.offeredMinutes > 0)
    .map(({ active: _, ...c }) => c)

  const cells = new Map<string, StatsReport['heatmap'][number]>()
  for (const s of offered) {
    const p = venueParts(s.startsAt)
    const weekday = (p.weekday + 6) % 7
    const key = `${weekday}:${p.hours}`
    let cell = cells.get(key)
    if (!cell) {
      cell = { weekday, hour: p.hours, offered: 0, booked: 0 }
      cells.set(key, cell)
    }
    cell.offered++
    if (seatsTaken.has(s.id)) cell.booked++
  }
  const heatmap = [...cells.values()].sort((a, b) => a.weekday - b.weekday || a.hour - b.hour)

  // Group classes: seats on offer and seats taken, per lesson type.
  const typeNames = new Map(
    db
      .select({ id: lessonTypes.id, name: lessonTypes.name, sort: lessonTypes.sort })
      .from(lessonTypes)
      .orderBy(lessonTypes.sort, lessonTypes.id)
      .all()
      .map((t) => [t.id, t.name]),
  )
  const groupStats = new Map<number, StatsReport['groups'][number]>()
  for (const s of offered) {
    if (s.lessonTypeId === null) continue
    let g = groupStats.get(s.lessonTypeId)
    if (!g) {
      g = {
        lessonTypeId: s.lessonTypeId,
        name: typeNames.get(s.lessonTypeId) ?? '',
        sessions: 0,
        seats: 0,
        booked: 0,
      }
      groupStats.set(s.lessonTypeId, g)
    }
    g.sessions++
    g.seats += s.capacity
    g.booked += seatsTaken.get(s.id) ?? 0
  }
  const typeOrder = [...typeNames.keys()]
  const groups = [...groupStats.values()].sort(
    (a, b) => typeOrder.indexOf(a.lessonTypeId) - typeOrder.indexOf(b.lessonTypeId),
  )

  // Package sales, by product.
  const productNames = new Map(
    db
      .select({ id: packageProducts.id, name: packageProducts.name })
      .from(packageProducts)
      .all()
      .map((p) => [p.id, p.name]),
  )
  const sales = new Map<number, StatsReport['packages']['sales'][number]>()
  for (const o of paidOrders) {
    if (o.kind !== 'package' || o.productId === null) continue
    let s = sales.get(o.productId)
    if (!s) {
      s = { productId: o.productId, name: productNames.get(o.productId) ?? '', count: 0, amount: 0 }
      sales.set(o.productId, s)
    }
    s.count++
    s.amount += o.amount
  }

  // Prepaid lessons not yet taken at the end of each step: what each package held then, less the
  // lessons from it that had taken place. Booked lessons still count until their time.
  const ledger = new Map<
    number,
    { kind: string; delta: number; at: Date; bookingId: number | null }[]
  >()
  for (const l of db
    .select({
      packageId: packageLedger.packageId,
      kind: packageLedger.kind,
      delta: packageLedger.delta,
      at: packageLedger.createdAt,
      bookingId: packageLedger.bookingId,
    })
    .from(packageLedger)
    .orderBy(asc(packageLedger.createdAt), asc(packageLedger.id))
    .all()) {
    let list = ledger.get(l.packageId)
    if (!list) {
      list = []
      ledger.set(l.packageId, list)
    }
    list.push(l)
  }
  const givenBack = new Set(
    [...ledger.values()].flatMap((list) =>
      list.filter((l) => l.kind === 'return').map((l) => l.bookingId),
    ),
  )
  const takenFrom = new Map<number, Date[]>()
  for (const b of db
    .select({
      id: bookings.id,
      packageId: bookings.packageId,
      status: bookings.status,
      cancelledBy: bookings.cancelledBy,
      late: bookings.late,
      endsAt: bookings.endsAt,
    })
    .from(bookings)
    .where(
      and(eq(bookings.paidWith, 'package'), inArray(bookings.status, ['confirmed', 'cancelled'])),
    )
    .all()) {
    if (b.packageId === null || givenBack.has(b.id)) continue
    if (b.status === 'cancelled' && !(b.cancelledBy === 'student' && b.late)) continue
    let list = takenFrom.get(b.packageId)
    if (!list) {
      list = []
      takenFrom.set(b.packageId, list)
    }
    list.push(b.endsAt)
  }
  const liability = buckets.map((b) => {
    const t = new Date(Math.min(venueInstant(b.to, 0).getTime(), now.getTime()))
    let value = 0
    for (const p of allPackages) {
      if (p.createdAt >= t || p.expiresAt <= t) continue
      const entries = (ledger.get(p.id) ?? []).filter((l) => l.at < t)
      if (entries.some((l) => l.kind === 'refund')) continue
      const held =
        p.lessonsPurchased +
        entries.filter((l) => l.kind === 'grant').reduce((sum, l) => sum + l.delta, 0) -
        (takenFrom.get(p.id) ?? []).filter((at) => at <= t).length
      if (held > 0) value += held * (values.get(p.id) ?? 0)
    }
    return Math.round(value)
  })

  // Packages that ran out in the range: used up when their last lesson was booked, or expired
  // with lessons left. Refunded packages are left out. A package bought from when the old one was
  // bought until RENEW_DAYS after it ran out counts as a renewal.
  let ended = 0
  let renewed = 0
  for (const p of allPackages) {
    if (p.status === 'refunded') continue
    let endedAt: Date | null = null
    if (p.lessonsRemaining === 0) {
      const uses = (ledger.get(p.id) ?? []).filter((l) => l.kind === 'use')
      endedAt = uses.at(-1)?.at ?? null
    } else if (p.expiresAt <= now) {
      endedAt = p.expiresAt
    }
    if (!endedAt || endedAt < start || endedAt >= end) continue
    ended++
    const until = endedAt.getTime() + RENEW_DAYS * DAY
    if (
      allPackages.some(
        (o) =>
          o.studentId === p.studentId &&
          o.status !== 'refunded' &&
          o.createdAt > p.createdAt &&
          o.createdAt.getTime() <= until,
      )
    ) {
      renewed++
    }
  }

  return {
    from,
    to,
    grain: statsGrain(from, to),
    buckets,
    revenue: { paid, refunded, consumed: consumed.map(Math.round) },
    lessons,
    attendance,
    students: {
      new: studentsNew,
      returning: studentsReturning,
      total: { new: totalNew, returning: rangeIds.size - totalNew },
    },
    renewal: { ended, renewed },
    coaches: coachStats,
    heatmap,
    packages: {
      sales: [...sales.values()].sort((a, b) => b.amount - a.amount),
      liability,
    },
    groups,
  }
}

/** Students with lessons left who have not been in for a while and have nothing booked. */
export function dormantStudents(deps: Deps): DormantStudent[] {
  const { db } = deps
  const now = deps.now()
  const open = db
    .select({
      studentId: packages.studentId,
      left: packages.lessonsRemaining,
      expiresAt: packages.expiresAt,
      boughtAt: packages.createdAt,
    })
    .from(packages)
    .innerJoin(students, eq(students.id, packages.studentId))
    .where(and(eq(packages.status, 'active'), isNull(students.deletedAt)))
    .all()
    .filter((p) => p.left > 0 && p.expiresAt > now)
  const holding = new Map<number, { left: number; expiresAt: Date; boughtAt: Date }>()
  for (const p of open) {
    const h = holding.get(p.studentId)
    if (!h) holding.set(p.studentId, { left: p.left, expiresAt: p.expiresAt, boughtAt: p.boughtAt })
    else {
      h.left += p.left
      if (p.expiresAt < h.expiresAt) h.expiresAt = p.expiresAt
      if (p.boughtAt > h.boughtAt) h.boughtAt = p.boughtAt
    }
  }
  if (holding.size === 0) return []
  const ids = [...holding.keys()]
  const last = new Map<number, Date>()
  const booked = new Set<number>()
  for (const b of db
    .select({ studentId: bookings.studentId, startsAt: bookings.startsAt, status: bookings.status })
    .from(bookings)
    .where(
      and(
        inArray(bookings.studentId, ids),
        inArray(bookings.status, ['confirmed', 'pending_payment']),
      ),
    )
    .all()) {
    if (b.startsAt > now) booked.add(b.studentId)
    else if (b.status === 'confirmed') {
      const seen = last.get(b.studentId)
      if (!seen || b.startsAt > seen) last.set(b.studentId, b.startsAt)
    }
  }
  const since = new Date(now.getTime() - DORMANT_DAYS * DAY)
  const quiet = ids.filter((id) => {
    if (booked.has(id)) return false
    // A package bought lately is a fresh start, even without a lesson yet.
    const l = last.get(id)
    return (!l || l < since) && (holding.get(id)?.boughtAt ?? now) < since
  })
  if (quiet.length === 0) return []
  const people = new Map(
    db
      .select({ id: students.id, name: students.name, phone: students.phone })
      .from(students)
      .where(inArray(students.id, quiet))
      .all()
      .map((s) => [s.id, s]),
  )
  return quiet
    .map((id) => {
      const h = holding.get(id) as { left: number; expiresAt: Date; boughtAt: Date }
      return {
        student: people.get(id) as DormantStudent['student'],
        lessonsLeft: h.left,
        expiresAt: h.expiresAt.toISOString(),
        lastLessonAt: last.get(id)?.toISOString() ?? null,
      }
    })
    .sort(
      (a, b) =>
        (a.lastLessonAt ?? '').localeCompare(b.lastLessonAt ?? '') || a.student.id - b.student.id,
    )
}
