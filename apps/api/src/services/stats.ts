import {
  addVenueDays,
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
import {
  and,
  asc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notExists,
  or,
  sql,
} from 'drizzle-orm'
import { alias, type SQLiteColumn } from 'drizzle-orm/sqlite-core'
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

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
// The venue's clock ahead of UTC, so SQL can find venue days and hours.
const VENUE_OFFSET_MS = -venueInstant('1970-01-01', 0).getTime()
// Written into the SQL rather than bound: a bound number is a REAL, which would make the division
// below fractional instead of whole days and hours.
const OFFSET_SQL = sql.raw(String(VENUE_OFFSET_MS))
const DAY_SQL = sql.raw(String(DAY))
const HOUR_SQL = sql.raw(String(HOUR))

/** The venue day an instant column falls on, as days since 1970-01-01. */
const venueDay = (column: SQLiteColumn) => sql<number>`(${column} + ${OFFSET_SQL}) / ${DAY_SQL}`
/** The first instant of a venue day from venueDay. */
const dayStart = (day: number) => new Date(Number(day) * DAY - VENUE_OFFSET_MS)

/** How long after a package runs out a new one still counts as a renewal. */
export const RENEW_DAYS = 30

/** Adds to one step of a per-step series. */
function add(series: number[], i: number, value: number) {
  if (i >= 0) series[i] = (series[i] ?? 0) + value
}

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

/**
 * Students whose first lesson ever started from `from` up to `to`, with when it started. A
 * student's first lesson is the earliest that ended; a student with an earlier one is left out.
 */
function firstLessons(deps: Deps, now: Date, from: Date, to: Date) {
  const earlier = alias(bookings, 'earlier')
  const rows = deps.db
    .select({ studentId: bookings.studentId, first: sql<number>`min(${bookings.startsAt})` })
    .from(bookings)
    .where(
      and(
        eq(bookings.status, 'confirmed'),
        lte(bookings.endsAt, now),
        gte(bookings.startsAt, from),
        lt(bookings.startsAt, to),
        notExists(
          deps.db
            .select({ one: sql`1` })
            .from(earlier)
            .where(
              and(
                eq(earlier.studentId, bookings.studentId),
                eq(earlier.status, 'confirmed'),
                lt(earlier.startsAt, from),
                lte(earlier.endsAt, now),
              ),
            ),
        ),
      ),
    )
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
  const first = firstLessons(deps, now, lastStart, now)

  const unmarked = db
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      and(
        eq(bookings.status, 'confirmed'),
        isNull(bookings.attendance),
        lte(bookings.endsAt, now),
        gte(bookings.startsAt, venueInstant(addVenueDays(today, -UNMARKED_DAYS), 0)),
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
  const granted = new Map(
    deps.db
      .select({ packageId: packageLedger.packageId, n: sql<number>`sum(${packageLedger.delta})` })
      .from(packageLedger)
      .where(eq(packageLedger.kind, 'grant'))
      .groupBy(packageLedger.packageId)
      .all()
      .map((r) => [r.packageId, Number(r.n)]),
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
  if (from > today) throw new ApiError(400, 'invalid_query', '开始日期不能晚于今天')
  if (from > to) throw new ApiError(400, 'invalid_query', '开始日期需早于结束日期')
  if (daysBetween(from, to) > STATS_MAX_DAYS) {
    throw new ApiError(400, 'invalid_query', `最多统计 ${STATS_MAX_DAYS} 天`)
  }

  const buckets = statsBuckets(from, to)
  const zeros = () => buckets.map(() => 0)
  // Each step's first instant, to place a time by number rather than by formatting its date.
  const edges = buckets.map((b) => venueInstant(b.from, 0).getTime())
  const last = buckets.at(-1)
  const stop = last ? venueInstant(last.to, 0).getTime() : 0
  const at = (d: Date) => {
    const t = d.getTime()
    if (t >= stop) return -1
    let lo = 0
    let hi = edges.length - 1
    let found = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if ((edges[mid] as number) <= t) {
        found = mid
        lo = mid + 1
      } else hi = mid - 1
    }
    return found
  }
  const start = venueInstant(from, 0)
  const end = new Date(Math.min(venueInstant(to, 24 * 60).getTime(), now.getTime()))

  // Money in and out.
  const paid = zeros()
  const refunded = zeros()
  // Summed per venue day in SQL: a year holds too many payments to bring over one by one.
  const paidRange = and(
    eq(orders.status, 'paid'),
    gte(orders.paidAt, start),
    lt(orders.paidAt, end),
  )
  for (const r of db
    .select({ day: venueDay(orders.paidAt), amount: sql<number>`sum(${orders.amount})` })
    .from(orders)
    .where(paidRange)
    .groupBy(sql`1`)
    .all()) {
    add(paid, at(dayStart(r.day)), Number(r.amount))
  }
  for (const r of db
    .select({ day: venueDay(refunds.updatedAt), amount: sql<number>`sum(${refunds.amount})` })
    .from(refunds)
    .where(
      and(
        eq(refunds.status, 'succeeded'),
        gte(refunds.updatedAt, start),
        lt(refunds.updatedAt, end),
      ),
    )
    .groupBy(sql`1`)
    .all()) {
    add(refunded, at(dayStart(r.day)), Number(r.amount))
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
  // Matched by joining the range's lessons in SQL, as a year holds more lessons than a query
  // can list.
  const lessonInRange = and(gte(bookings.startsAt, start), lt(bookings.startsAt, end))
  const returned = new Set(
    db
      .select({ bookingId: packageLedger.bookingId })
      .from(packageLedger)
      .innerJoin(bookings, eq(bookings.id, packageLedger.bookingId))
      .where(and(eq(packageLedger.kind, 'return'), lessonInRange))
      .all()
      .map((r) => r.bookingId),
  )
  const back = new Map<number, number>()
  for (const r of db
    .select({ orderId: refunds.orderId, amount: refunds.amount })
    .from(refunds)
    .innerJoin(orders, eq(orders.id, refunds.orderId))
    .innerJoin(bookings, eq(bookings.id, orders.bookingId))
    .where(and(inArray(refunds.status, ['pending', 'processing', 'succeeded']), lessonInRange))
    .all()) {
    back.set(r.orderId, (back.get(r.orderId) ?? 0) + r.amount)
  }
  const kept = new Map<number, number>()
  for (const o of db
    .select({ id: orders.id, bookingId: orders.bookingId, amount: orders.amount })
    .from(orders)
    .innerJoin(bookings, eq(bookings.id, orders.bookingId))
    .where(and(eq(orders.status, 'paid'), lessonInRange))
    .all()) {
    if (o.bookingId !== null) kept.set(o.bookingId, o.amount - (back.get(o.id) ?? 0))
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
  const first = firstLessons(deps, now, start, end)
  const isNew = (studentId: number, from: Date, to: Date) => {
    const d = first.get(studentId)
    return !!d && d >= from && d < to
  }
  const studentsNew = zeros()
  const studentsReturning = zeros()
  const seen = buckets.map(() => new Set<number>())
  for (const l of taken) seen[at(l.startsAt)]?.add(l.studentId)
  seen.forEach((ids, i) => {
    const b = buckets[i] as (typeof buckets)[number]
    const bFrom = venueInstant(b.from, 0)
    const bTo = venueInstant(b.to, 0)
    for (const id of ids) {
      if (isNew(id, bFrom, bTo)) add(studentsNew, i, 1)
      else add(studentsReturning, i, 1)
    }
  })
  const rangeIds = new Set(taken.map((l) => l.studentId))
  const totalNew = [...rangeIds].filter((id) => isNew(id, start, end)).length

  // Coach hours and the busy times, from lessons on offer that have ended. Counted in SQL by
  // coach, venue weekday and hour, as a year holds too many lessons to bring over one by one.
  const seatsTaken = db
    .select({ slotId: bookings.slotId, n: sql<number>`count(*)`.as('n') })
    .from(bookings)
    .where(
      and(
        eq(bookings.status, 'confirmed'),
        gte(bookings.startsAt, start),
        lt(bookings.startsAt, end),
        lte(bookings.endsAt, now),
      ),
    )
    .groupBy(bookings.slotId)
    .as('seats_taken')
  const local = sql`(${slots.startsAt} + ${OFFSET_SQL})`
  const slotGroups = db
    .select({
      coachId: slots.coachId,
      lessonTypeId: slots.lessonTypeId,
      // 0 is Monday: 1970-01-01, day 0, was a Thursday.
      weekday: sql<number>`(${local} / ${DAY_SQL} + 3) % 7`,
      hour: sql<number>`(${local} / ${HOUR_SQL}) % 24`,
      booked: sql<number>`${seatsTaken.n} is not null`,
      lessons: sql<number>`count(*)`,
      minutes: sql<number>`sum((${slots.endsAt} - ${slots.startsAt}) / 60000.0)`,
      seats: sql<number>`sum(${slots.capacity})`,
      taken: sql<number>`coalesce(sum(${seatsTaken.n}), 0)`,
    })
    .from(slots)
    .leftJoin(seatsTaken, eq(seatsTaken.slotId, slots.id))
    .where(
      and(
        gte(slots.startsAt, start),
        lt(slots.startsAt, end),
        lte(slots.endsAt, now),
        isNull(slots.cancelledAt),
        // A closed lesson with no one in it was not on offer.
        or(eq(slots.open, true), isNotNull(seatsTaken.n)),
      ),
    )
    .groupBy(sql`1, 2, 3, 4, 5`)
    .all()
    .map((g) => ({
      ...g,
      weekday: Number(g.weekday),
      hour: Number(g.hour),
      booked: !!g.booked,
      lessons: Number(g.lessons),
      minutes: Number(g.minutes),
      seats: Number(g.seats),
      taken: Number(g.taken),
    }))

  const coachRows = db
    .select({ id: coaches.id, name: coaches.name, active: coaches.active })
    .from(coaches)
    .orderBy(coaches.sort, coaches.id)
    .all()
  const coachStats = coachRows
    .map((c) => {
      const mine = slotGroups.filter((g) => g.coachId === c.id)
      return {
        id: c.id,
        name: c.name,
        active: c.active,
        offeredMinutes: mine.reduce((sum, g) => sum + g.minutes, 0),
        bookedMinutes: mine.filter((g) => g.booked).reduce((sum, g) => sum + g.minutes, 0),
      }
    })
    .filter((c) => c.active || c.offeredMinutes > 0)
    .map(({ active: _, ...c }) => c)

  const cells = new Map<string, StatsReport['heatmap'][number]>()
  for (const g of slotGroups) {
    const key = `${g.weekday}:${g.hour}`
    let cell = cells.get(key)
    if (!cell) {
      cell = { weekday: g.weekday, hour: g.hour, offered: 0, booked: 0 }
      cells.set(key, cell)
    }
    cell.offered += g.lessons
    if (g.booked) cell.booked += g.lessons
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
  for (const s of slotGroups) {
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
    g.sessions += s.lessons
    g.seats += s.seats
    g.booked += s.taken
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
  const sales = db
    .select({
      productId: orders.productId,
      count: sql<number>`count(*)`,
      amount: sql<number>`sum(${orders.amount})`,
    })
    .from(orders)
    .where(and(paidRange, eq(orders.kind, 'package'), isNotNull(orders.productId)))
    .groupBy(orders.productId)
    .all()
    .map((r) => ({
      productId: r.productId as number,
      name: productNames.get(r.productId as number) ?? '',
      count: Number(r.count),
      amount: Number(r.amount),
    }))

  // Prepaid lessons not yet taken at the end of each step: what each package held then, less the
  // lessons from it that had taken place. Booked lessons still count until their time. Only
  // packages alive at some point in the range matter, here and for the renewals below.
  const alive = db
    .select({ id: packages.id })
    .from(packages)
    .where(and(lt(packages.createdAt, end), gt(packages.expiresAt, start)))
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
    .where(inArray(packageLedger.packageId, alive))
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
      and(
        eq(bookings.paidWith, 'package'),
        inArray(bookings.status, ['confirmed', 'cancelled']),
        inArray(bookings.packageId, alive),
      ),
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
  // Walks each package's grants and lessons once, in time order, across the steps.
  const ends = buckets.map((b) => Math.min(venueInstant(b.to, 0).getTime(), now.getTime()))
  const held = ends.map(() => 0)
  for (const p of allPackages) {
    const value = values.get(p.id) ?? 0
    if (value === 0) continue
    const entries = ledger.get(p.id) ?? []
    const refundedAt = entries.find((l) => l.kind === 'refund')?.at.getTime() ?? Infinity
    const grants = entries.filter((l) => l.kind === 'grant')
    const used = (takenFrom.get(p.id) ?? []).map((d) => d.getTime()).sort((a, b) => a - b)
    let g = 0
    let granted = 0
    let u = 0
    ends.forEach((t, i) => {
      while (g < grants.length && (grants[g] as (typeof grants)[number]).at.getTime() < t) {
        granted += (grants[g] as (typeof grants)[number]).delta
        g++
      }
      while (u < used.length && (used[u] as number) <= t) u++
      if (p.createdAt.getTime() >= t || p.expiresAt.getTime() <= t || refundedAt < t) return
      const left = p.lessonsPurchased + granted - u
      if (left > 0) held[i] = (held[i] ?? 0) + left * value
    })
  }
  const liability = held.map(Math.round)

  // Packages that ran out in the range: used up when their last lesson was booked, or expired
  // with lessons left. Refunded packages are left out. A package bought from when the old one was
  // bought until RENEW_DAYS after it ran out counts as a renewal.
  let ended = 0
  let renewed = 0
  const boughtBy = new Map<number, Date[]>()
  for (const p of allPackages) {
    if (p.status === 'refunded') continue
    let list = boughtBy.get(p.studentId)
    if (!list) {
      list = []
      boughtBy.set(p.studentId, list)
    }
    list.push(p.createdAt)
  }
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
    if ((boughtBy.get(p.studentId) ?? []).some((at) => at > p.createdAt && at.getTime() <= until)) {
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
      sales: sales.sort((a, b) => b.amount - a.amount || a.productId - b.productId),
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
  // Per student in SQL: the latest lesson that started and whether one is still to come. The
  // students are picked by a subquery, as a busy venue has more than a query can list.
  const holders = db
    .select({ id: packages.studentId })
    .from(packages)
    .where(and(eq(packages.status, 'active'), gt(packages.lessonsRemaining, 0)))
  for (const b of db
    .select({
      studentId: bookings.studentId,
      last: sql<
        number | null
      >`max(case when ${bookings.status} = 'confirmed' and ${bookings.startsAt} <= ${now.getTime()} then ${bookings.startsAt} end)`,
      upcoming: sql<number>`max(${bookings.startsAt} > ${now.getTime()})`,
    })
    .from(bookings)
    .where(
      and(
        inArray(bookings.studentId, holders),
        inArray(bookings.status, ['confirmed', 'pending_payment']),
      ),
    )
    .groupBy(bookings.studentId)
    .all()) {
    if (b.upcoming) booked.add(b.studentId)
    if (b.last !== null) last.set(b.studentId, new Date(Number(b.last)))
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
      .where(inArray(students.id, holders))
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
