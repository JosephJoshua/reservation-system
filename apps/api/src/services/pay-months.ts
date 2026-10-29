import { type VenueSettings, venueDateKey, venueInstant, versionOf } from '@rs/shared'
import { and, asc, eq, gte, inArray, lt, sql } from 'drizzle-orm'
import type { Q } from '../db/client'
import { bookings, coachPayEntries, coachPayMonths, lessonTypes, slots, staff } from '../db/schema'
import { ApiError } from '../errors'
import { countsForPay, payRateLookup } from './coach-pay'
import { getSettings } from './settings'

type PayRules = VenueSettings['pay']

/** Venue month YYYY-MM, in 2000-2999, to its start and the next month's start. */
export function monthRange(month: string) {
  if (!/^2\d{3}-(0[1-9]|1[0-2])$/.test(month)) throw new ApiError(400, 'invalid_query', '月份无效')
  return { from: monthStart(month), to: monthStart(nextMonth(month)) }
}

const monthStart = (month: string) => venueInstant(`${month}-01`, 0)

export function nextMonth(month: string) {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
}

const monthOf = (d: Date) => venueDateKey(d).slice(0, 7)

/** A lesson taken back (-1) or newly paid (+1) after its month was confirmed. */
export interface PayAdjustment {
  lessonTypeId: number
  name: string
  /** When the lesson was, ISO. */
  startsAt: string
  lessons: number
  rate: number | null
  amount: number
}

export interface CoachPay {
  /** In fen: this month's lessons plus adjustments, for those that have a rate. */
  amount: number
  /** This month's lessons the coach is paid for. */
  lessons: number
  /** Lessons and adjustments whose lesson type has no rate in the coach's category. */
  unrated: number
  lines: {
    lessonTypeId: number
    name: string
    lessons: number
    rate: number | null
    amount: number
  }[]
  adjustments: PayAdjustment[]
}

export interface PayMonthStatus {
  /** Set once staff confirmed the month; its amounts are then fixed. */
  confirmed: { at: string; staff: string } | null
  /** Why the month cannot be confirmed now, or null when it can or already is. */
  blocked: string | null
  /** Fingerprint of the amounts shown, sent back with a confirm. */
  version: string
  rules: PayRules
}

/** A lesson as pay sees it: one booking, or one group session however many seats it has. */
interface Unit {
  unit: string
  coachId: number
  lessonTypeId: number
  startsAt: Date
  counted: boolean
}

interface Change {
  unit: string
  coachId: number
  lessonTypeId: number
  startsAt: Date
  rate: number | null
  lessons: number
  amount: number
}

/** The lessons that started in [from, to), each counted under the rules of its month. */
function loadUnits(tx: Q, from: Date, to: Date, now: Date, rulesFor: (month: string) => PayRules) {
  const rows = tx
    .select({
      bookingId: bookings.id,
      slotId: bookings.slotId,
      sessionOf: slots.lessonTypeId,
      coachId: slots.coachId,
      lessonTypeId: bookings.lessonTypeId,
      status: bookings.status,
      startsAt: bookings.startsAt,
      endsAt: bookings.endsAt,
      attendance: bookings.attendance,
      cancelledBy: bookings.cancelledBy,
      late: bookings.late,
      sessionCancelled: sql<boolean>`${slots.cancelledAt} is not null`.mapWith(Boolean),
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
    .orderBy(asc(bookings.startsAt), asc(bookings.id))
    .all()
  const units = new Map<string, Unit>()
  for (const r of rows) {
    const key = r.sessionOf === null ? `b${r.bookingId}` : `s${r.slotId}`
    const counted = countsForPay(r, rulesFor(monthOf(r.startsAt)), now)
    const unit = units.get(key)
    if (unit) unit.counted ||= counted
    else
      units.set(key, {
        unit: key,
        coachId: r.coachId,
        lessonTypeId: r.lessonTypeId,
        startsAt: r.startsAt,
        counted,
      })
  }
  return [...units.values()]
}

/** When the last lesson that started in [from, to) ends, or the epoch when there is none. */
function lastEnd(tx: Q, from: Date, to: Date) {
  const row = tx
    .select({ endsAt: sql<number | null>`max(${bookings.endsAt})` })
    .from(bookings)
    .where(
      and(
        gte(bookings.startsAt, from),
        lt(bookings.startsAt, to),
        inArray(bookings.status, ['pending_payment', 'confirmed', 'cancelled']),
      ),
    )
    .get()
  return new Date(row?.endsAt ?? 0)
}

function confirmedMonths(tx: Q) {
  return tx
    .select({
      month: coachPayMonths.month,
      rules: coachPayMonths.rules,
      confirmedAt: coachPayMonths.confirmedAt,
      staff: staff.name,
    })
    .from(coachPayMonths)
    .innerJoin(staff, eq(staff.id, coachPayMonths.staffId))
    .orderBy(asc(coachPayMonths.month))
    .all()
}

/**
 * What confirmed months owe or overpaid now: lessons whose attendance or cancellation changed
 * after their month was confirmed. Each is compared with what was paid for it, so a change and its
 * undo cancel out. Rates are the ones the lesson was paid at, or today's for a lesson paid first.
 */
function pendingChanges(
  tx: Q,
  months: ReturnType<typeof confirmedMonths>,
  now: Date,
  rateOf: (coachId: number, lessonTypeId: number) => number | null,
): Change[] {
  const first = months[0]
  const last = months.at(-1)
  if (!first || !last) return []
  const rules = new Map(months.map((m) => [m.month, m.rules]))
  // Confirmed months run without gaps, so every lesson in range has its month's rules.
  const fallback = getSettings(tx).pay
  const units = loadUnits(
    tx,
    monthRange(first.month).from,
    monthRange(last.month).to,
    now,
    (month) => rules.get(month) ?? fallback,
  )
  // What each lesson was paid so far, by coach, lesson type and rate.
  const held = new Map<string, Change[]>()
  for (const g of tx
    .select({
      unit: coachPayEntries.unit,
      coachId: coachPayEntries.coachId,
      lessonTypeId: coachPayEntries.lessonTypeId,
      rate: coachPayEntries.rate,
      startsAt: sql<number>`max(${coachPayEntries.startsAt})`,
      lessons: sql<number>`sum(${coachPayEntries.lessons})`,
      amount: sql<number>`sum(${coachPayEntries.amount})`,
    })
    .from(coachPayEntries)
    .groupBy(
      coachPayEntries.unit,
      coachPayEntries.coachId,
      coachPayEntries.lessonTypeId,
      coachPayEntries.rate,
    )
    .all()) {
    const list = held.get(g.unit) ?? []
    list.push({ ...g, startsAt: new Date(g.startsAt) })
    held.set(g.unit, list)
  }

  const changes: Change[] = []
  const settle = (target: Unit | null, paid: Change[]) => {
    const live = paid.filter((p) => p.lessons !== 0)
    const keep =
      target &&
      live.find(
        (p) =>
          p.coachId === target.coachId && p.lessonTypeId === target.lessonTypeId && p.lessons === 1,
      )
    for (const p of live) {
      if (p !== keep) changes.push({ ...p, lessons: -p.lessons, amount: -p.amount })
    }
    if (target && !keep) {
      const before = paid.find(
        (p) => p.coachId === target.coachId && p.lessonTypeId === target.lessonTypeId,
      )
      const rate = before ? before.rate : rateOf(target.coachId, target.lessonTypeId)
      changes.push({ ...target, rate, lessons: 1, amount: rate ?? 0 })
    }
  }
  const seen = new Set<string>()
  for (const u of units) {
    seen.add(u.unit)
    settle(u.counted ? u : null, held.get(u.unit) ?? [])
  }
  for (const [unit, paid] of held) if (!seen.has(unit)) settle(null, paid)
  return changes.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
}

/**
 * Coach pay for a venue month. A confirmed month shows what it paid. An open month shows its
 * lessons at today's rates and rules; the month after the last confirmed one also carries the
 * changes to confirmed months as adjustments.
 */
export function monthPay(tx: Q, month: string, now: Date) {
  const { to } = monthRange(month)
  const names = new Map(
    tx
      .select({ id: lessonTypes.id, name: lessonTypes.name })
      .from(lessonTypes)
      .orderBy(asc(lessonTypes.sort), asc(lessonTypes.id))
      .all()
      .map((t) => [t.id, t.name]),
  )
  const months = confirmedMonths(tx)
  const done = months.find((m) => m.month === month)

  let lessons: Change[]
  let adjustments: Change[]
  let rules: PayRules
  if (done) {
    rules = done.rules
    const entries = tx
      .select()
      .from(coachPayEntries)
      .where(eq(coachPayEntries.month, month))
      .orderBy(asc(coachPayEntries.startsAt), asc(coachPayEntries.id))
      .all()
    lessons = entries.filter((e) => e.kind === 'lesson')
    adjustments = entries.filter((e) => e.kind === 'adjustment')
  } else {
    rules = getSettings(tx).pay
    const rateOf = payRateLookup(tx)
    const { from } = monthRange(month)
    lessons = loadUnits(tx, from, to, now, () => rules)
      .filter((u) => u.counted)
      .map((u) => {
        const rate = rateOf(u.coachId, u.lessonTypeId)
        return { ...u, rate, lessons: 1, amount: rate ?? 0 }
      })
    const last = months.at(-1)
    adjustments =
      last && month === nextMonth(last.month) ? pendingChanges(tx, months, now, rateOf) : []
  }

  const byCoach = new Map<number, CoachPay>()
  const payOf = (coachId: number) => {
    let pay = byCoach.get(coachId)
    if (!pay) {
      pay = { amount: 0, lessons: 0, unrated: 0, lines: [], adjustments: [] }
      byCoach.set(coachId, pay)
    }
    return pay
  }
  // Lines in the lesson types' own order.
  const order = [...names.keys()]
  for (const l of [...lessons].sort(
    (a, b) => order.indexOf(a.lessonTypeId) - order.indexOf(b.lessonTypeId),
  )) {
    const pay = payOf(l.coachId)
    let line = pay.lines.find((x) => x.lessonTypeId === l.lessonTypeId && x.rate === l.rate)
    if (!line) {
      line = {
        lessonTypeId: l.lessonTypeId,
        name: names.get(l.lessonTypeId) ?? '',
        lessons: 0,
        rate: l.rate,
        amount: 0,
      }
      pay.lines.push(line)
    }
    line.lessons += l.lessons
    line.amount += l.amount
    pay.lessons += l.lessons
    pay.amount += l.amount
    if (l.rate === null) pay.unrated += l.lessons
  }
  for (const a of adjustments) {
    const pay = payOf(a.coachId)
    pay.adjustments.push({
      lessonTypeId: a.lessonTypeId,
      name: names.get(a.lessonTypeId) ?? '',
      startsAt: a.startsAt.toISOString(),
      lessons: a.lessons,
      rate: a.rate,
      amount: a.amount,
    })
    pay.amount += a.amount
    if (a.rate === null) pay.unrated += 1
  }

  const last = months.at(-1)
  let blocked: string | null = null
  if (!done) {
    const unrated = [...byCoach.values()].reduce((sum, p) => sum + p.unrated, 0)
    if (to > now) blocked = '这个月还没结束'
    else if (lastEnd(tx, monthRange(month).from, to) > now) {
      // A lesson that started on the month's last evening can run past midnight.
      blocked = '本月最后一节课还没结束，下课后再确认'
    } else if (last && month < last.month) blocked = '早于已确认的月份，不能再确认'
    else if (last && month !== nextMonth(last.month)) {
      blocked = `请先确认 ${nextMonth(last.month)} 的课时费`
    } else if (unrated > 0) {
      blocked = `还有 ${unrated} 节课未设课时费，设置后再确认（不付课时费的课程可设为 0 元）`
    }
  }
  const shown = [...byCoach].sort(([a], [b]) => a - b)
  const status: PayMonthStatus = {
    confirmed: done ? { at: done.confirmedAt.toISOString(), staff: done.staff } : null,
    blocked,
    version: versionOf({ rules, shown }),
    rules,
  }
  return { byCoach, status, lessons, adjustments }
}

/**
 * Fixes a month's coach pay: records each paid lesson and each adjustment, with the rules in
 * force. Months are confirmed in order. Returns null when the month was already confirmed, so a
 * repeat is logged once.
 */
export function confirmMonth(tx: Q, month: string, version: string, staffId: number, now: Date) {
  if (tx.select().from(coachPayMonths).where(eq(coachPayMonths.month, month)).get()) return null
  const pay = monthPay(tx, month, now)
  if (pay.status.blocked) throw new ApiError(409, 'pay_not_confirmable', pay.status.blocked)
  if (version !== pay.status.version) {
    throw new ApiError(409, 'edited_elsewhere', '课时费有变动，请刷新后再确认')
  }
  const total = [...pay.byCoach.values()].reduce((sum, p) => sum + p.amount, 0)
  tx.insert(coachPayMonths)
    .values({ month, rules: pay.status.rules, total, confirmedAt: now, staffId })
    .run()
  const rows = [
    ...pay.lessons.map((l) => ({ ...l, kind: 'lesson' as const })),
    ...pay.adjustments.map((a) => ({ ...a, kind: 'adjustment' as const })),
  ]
  for (const r of rows) {
    tx.insert(coachPayEntries)
      .values({
        month,
        kind: r.kind,
        unit: r.unit,
        coachId: r.coachId,
        lessonTypeId: r.lessonTypeId,
        startsAt: r.startsAt,
        // Confirming waits until every lesson has a rate.
        rate: r.rate ?? 0,
        lessons: r.lessons,
        amount: r.amount,
      })
      .run()
  }
  return { total, coaches: pay.byCoach.size }
}

/**
 * Reopens the last confirmed month, for a confirm made too early. Its adjustments go back to being
 * worked out. Returns null when the month is not confirmed, so a repeat is logged once.
 */
export function unconfirmMonth(tx: Q, month: string) {
  const months = confirmedMonths(tx)
  if (!months.some((m) => m.month === month)) return null
  if (months.at(-1)?.month !== month) {
    throw new ApiError(409, 'pay_not_last', '只能撤销最近一个确认的月份')
  }
  tx.delete(coachPayEntries).where(eq(coachPayEntries.month, month)).run()
  tx.delete(coachPayMonths).where(eq(coachPayMonths.month, month)).run()
  return true
}
