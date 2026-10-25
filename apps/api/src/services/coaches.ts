import {
  type CoachHoursDto,
  type CoachMeDto,
  lessonsFromHours,
  type SlotSyncDto,
  venueDateKey,
  venueDates,
  venueInstant,
  type WeeklyHours,
  weeklyHoursError,
} from '@rs/shared'
import { and, asc, eq, gt, gte, inArray } from 'drizzle-orm'
import { immediate, type Q } from '../db/client'
import {
  bookings,
  coachDaysOff,
  coaches,
  coachHours,
  coachLessonTypes,
  lessonTypes,
  sessions,
  slots,
} from '../db/schema'
import type { Deps } from '../deps'
import { ApiError, notFound } from '../errors'
import { templateIds } from '../wx-notify'
import { startCoachSession } from './auth'
import { LIVE } from './bookings'
import { newBindCode, normalizeBindCode } from './ids'
import { ruleBook, taughtBy } from './settings'

const BIND_CODE_MS = 24 * 3_600_000

/** A one-time code, valid for a day, that links a coach to the WeChat user who enters it. */
export function newCoachBindCode(deps: Deps, coachId: number) {
  const code = newBindCode()
  const expiresAt = new Date(deps.now().getTime() + BIND_CODE_MS)
  const changed = deps.db
    .update(coaches)
    .set({ bindCode: code, bindCodeExpiresAt: expiresAt })
    .where(eq(coaches.id, coachId))
    .run()
  if (changed.changes === 0) throw notFound('教练')
  return { code, expiresAt: expiresAt.toISOString() }
}

export function unbindCoach(deps: Deps, coachId: number) {
  immediate(deps.db, (tx) => {
    const changed = tx
      .update(coaches)
      .set({ openid: null, bindCode: null, bindCodeExpiresAt: null })
      .where(eq(coaches.id, coachId))
      .run()
    if (changed.changes === 0) throw notFound('教练')
    tx.delete(sessions).where(eq(sessions.coachId, coachId)).run()
  })
}

function coachMe(deps: Deps, coach: typeof coaches.$inferSelect): CoachMeDto {
  return {
    id: coach.id,
    name: coach.name,
    title: coach.title,
    avatarUrl: coach.avatarUrl,
    notifyTemplateIds: templateIds(deps.notifier, [
      'coach_booked',
      'coach_cancelled',
      'coach_moved',
    ]),
    // The days any of the coach's own lessons can be booked on.
    advanceDays: ruleBook(deps.db).longestAdvanceDays(taughtBy(deps.db, coach.id)),
  }
}

export function coachProfile(deps: Deps, coachId: number) {
  const coach = deps.db.select().from(coaches).where(eq(coaches.id, coachId)).get()
  if (!coach) throw notFound('教练')
  return coachMe(deps, coach)
}

export async function loginCoach(deps: Deps, code: string) {
  const openid = await deps.wxLogin(code)
  const coach = deps.db.select().from(coaches).where(eq(coaches.openid, openid)).get()
  if (!coach) throw new ApiError(404, 'not_bound', '这个微信还没有绑定教练')
  if (!coach.active) throw new ApiError(403, 'coach_inactive', '教练账号已停用，请联系场馆')
  return { token: startCoachSession(deps, coach.id), coach: coachMe(deps, coach) }
}

export async function bindCoach(deps: Deps, code: string, bindCode: string) {
  const openid = await deps.wxLogin(code)
  const normalized = normalizeBindCode(bindCode)
  const coach = immediate(deps.db, (tx) => {
    const coach = tx.select().from(coaches).where(eq(coaches.bindCode, normalized)).get()
    if (!coach?.bindCodeExpiresAt || coach.bindCodeExpiresAt <= deps.now()) {
      throw new ApiError(400, 'bad_bind_code', '绑定码无效或已过期，请向场馆重新获取')
    }
    if (!coach.active) throw new ApiError(403, 'coach_inactive', '教练账号已停用，请联系场馆')
    const other = tx.select().from(coaches).where(eq(coaches.openid, openid)).get()
    if (other && other.id !== coach.id) {
      throw new ApiError(409, 'already_bound', `这个微信已绑定教练「${other.name}」`)
    }
    // A new phone replaces the old one: sessions from the old WeChat stop working.
    if (coach.openid !== openid) tx.delete(sessions).where(eq(sessions.coachId, coach.id)).run()
    return tx
      .update(coaches)
      .set({ openid, bindCode: null, bindCodeExpiresAt: null })
      .where(eq(coaches.id, coach.id))
      .returning()
      .get()
  })
  return { token: startCoachSession(deps, coach.id), coach: coachMe(deps, coach) }
}

// Weekly hours and days off

/** Lesson lengths a coach teaches, in minutes, shortest first. */
function lessonMinutes(tx: Q, coachId: number) {
  const rows = tx
    .select({ minutes: lessonTypes.durationMinutes })
    .from(coachLessonTypes)
    .innerJoin(lessonTypes, eq(lessonTypes.id, coachLessonTypes.lessonTypeId))
    // Group classes run in sessions the venue schedules, not in the coach's weekly hours.
    .where(
      and(
        eq(coachLessonTypes.coachId, coachId),
        eq(lessonTypes.active, true),
        eq(lessonTypes.capacity, 1),
      ),
    )
    .all()
  return [...new Set(rows.map((r) => r.minutes))].sort((a, b) => a - b)
}

function weeklyHours(tx: Q, coachId: number): WeeklyHours[] {
  return tx
    .select({
      weekday: coachHours.weekday,
      startMinute: coachHours.startMinute,
      endMinute: coachHours.endMinute,
      lessonMinutes: coachHours.lessonMinutes,
    })
    .from(coachHours)
    .where(eq(coachHours.coachId, coachId))
    .orderBy(asc(coachHours.weekday), asc(coachHours.startMinute))
    .all()
}

function daysOffFrom(tx: Q, coachId: number, now: Date) {
  return tx
    .select({ date: coachDaysOff.date })
    .from(coachDaysOff)
    .where(and(eq(coachDaysOff.coachId, coachId), gte(coachDaysOff.date, venueDateKey(now))))
    .orderBy(asc(coachDaysOff.date))
    .all()
    .map((r) => r.date)
}

export function hoursView(deps: Deps, coachId: number): CoachHoursDto {
  const { db } = deps
  if (!db.select({ id: coaches.id }).from(coaches).where(eq(coaches.id, coachId)).get()) {
    throw notFound('教练')
  }
  return {
    hours: weeklyHours(db, coachId),
    daysOff: daysOffFrom(db, coachId, deps.now()),
    lessonMinutes: lessonMinutes(db, coachId),
    advanceDays: ruleBook(db).longestAdvanceDays(taughtBy(db, coachId)),
  }
}

/**
 * Brings a coach's future slots in line with their weekly hours and days off: adds the lessons
 * that are missing, removes generated slots nobody ever booked, and closes generated slots that
 * have booking history. Booked lessons are never touched. Manual slots are left alone, except that
 * open ones nobody holds are closed on days off. Slots this closed open again once they are wanted;
 * slots a person closed stay closed.
 */
export function syncSlots(tx: Q, coachId: number, now: Date): SlotSyncDto {
  const daysOff = new Set(daysOffFrom(tx, coachId, now))
  // Far enough ahead for the coach's lesson with the longest booking window.
  const days = ruleBook(tx).longestAdvanceDays(taughtBy(tx, coachId))
  const desired = lessonsFromHours(weeklyHours(tx, coachId), venueDates(now, days), daysOff).filter(
    (l) => l.startsAt > now,
  )

  const existing = tx
    .select()
    .from(slots)
    .where(and(eq(slots.coachId, coachId), gt(slots.endsAt, now)))
    .all()
  const ids = existing.map((s) => s.id)
  const used = ids.length
    ? tx
        .select({ slotId: bookings.slotId, status: bookings.status })
        .from(bookings)
        .where(inArray(bookings.slotId, ids))
        .all()
    : []
  const everBooked = new Set(used.map((u) => u.slotId))
  const live = new Set(
    used.filter((u) => (LIVE as readonly string[]).includes(u.status)).map((u) => u.slotId),
  )

  const key = (s: { startsAt: Date; endsAt: Date }) =>
    `${s.startsAt.getTime()}-${s.endsAt.getTime()}`
  const wanted = new Set(desired.map(key))
  let created = 0
  let removed = 0
  const setOpen = (id: number, open: boolean) =>
    tx.update(slots).set({ open, closedBySync: !open }).where(eq(slots.id, id)).run()
  // Group sessions are the venue's to manage. While one is on the schedule, even called off,
  // the coach's private slots under it stay closed and none are added there.
  const sessions = existing.filter((s) => s.lessonTypeId !== null)
  const underSession = (s: { startsAt: Date; endsAt: Date }) =>
    sessions.some((o) => o.startsAt < s.endsAt && o.endsAt > s.startsAt)
  const kept: { startsAt: Date; endsAt: Date }[] = []
  for (const s of existing) {
    kept.push(s)
    if (s.startsAt <= now || live.has(s.id) || s.lessonTypeId !== null) continue
    if (s.source === 'hours') {
      if (wanted.has(key(s))) {
        if (s.closedBySync && !underSession(s)) {
          setOpen(s.id, true)
          created++
        }
      } else if (everBooked.has(s.id)) {
        // Booking history keeps the row; closing it takes it off sale.
        if (s.open) {
          setOpen(s.id, false)
          removed++
        }
      } else {
        tx.delete(slots).where(eq(slots.id, s.id)).run()
        kept.pop()
        removed++
      }
      continue
    }
    const offDay = daysOff.has(venueDateKey(s.startsAt))
    if (offDay && s.open) {
      setOpen(s.id, false)
      removed++
    } else if (!offDay && s.closedBySync && !underSession(s)) {
      setOpen(s.id, true)
      created++
    }
  }

  const have = new Set(existing.filter((s) => s.source === 'hours').map(key))
  for (const lesson of desired) {
    if (have.has(key(lesson))) continue
    // Never double-book the coach: a manual slot or a lesson kept from old hours wins.
    const clash = kept.some((s) => s.startsAt < lesson.endsAt && s.endsAt > lesson.startsAt)
    if (clash) continue
    tx.insert(slots)
      .values({ coachId, ...lesson, source: 'hours' })
      .run()
    kept.push(lesson)
    created++
  }

  const bookedOnDaysOff = existing.filter(
    (s) => live.has(s.id) && s.startsAt > now && daysOff.has(venueDateKey(s.startsAt)),
  ).length
  return { created, removed, bookedOnDaysOff }
}

export function saveHours(deps: Deps, coachId: number, hours: WeeklyHours[]): SlotSyncDto {
  return immediate(deps.db, (tx) => {
    if (!tx.select({ id: coaches.id }).from(coaches).where(eq(coaches.id, coachId)).get()) {
      throw notFound('教练')
    }
    const error = weeklyHoursError(hours)
    if (error) throw new ApiError(400, 'invalid_hours', error)
    const allowed = new Set(lessonMinutes(tx, coachId))
    if (hours.some((h) => !allowed.has(h.lessonMinutes))) {
      throw new ApiError(400, 'invalid_hours', '每节时长需与所教课程一致')
    }
    tx.delete(coachHours).where(eq(coachHours.coachId, coachId)).run()
    for (const h of hours)
      tx.insert(coachHours)
        .values({ coachId, ...h })
        .run()
    return syncSlots(tx, coachId, deps.now())
  })
}

export function setDayOff(deps: Deps, coachId: number, date: string, off: boolean): SlotSyncDto {
  const now = deps.now()
  let day: Date
  try {
    day = venueInstant(date, 0)
  } catch {
    throw new ApiError(400, 'invalid_date', '日期无效')
  }
  if (date < venueDateKey(now)) throw new ApiError(400, 'invalid_date', '不能设置过去的日期')
  if (day.getTime() - now.getTime() > 366 * 86_400_000) {
    throw new ApiError(400, 'invalid_date', '只能设置一年内的休息日')
  }
  return immediate(deps.db, (tx) => {
    if (!tx.select({ id: coaches.id }).from(coaches).where(eq(coaches.id, coachId)).get()) {
      throw notFound('教练')
    }
    if (off) tx.insert(coachDaysOff).values({ coachId, date }).onConflictDoNothing().run()
    else
      tx.delete(coachDaysOff)
        .where(and(eq(coachDaysOff.coachId, coachId), eq(coachDaysOff.date, date)))
        .run()
    return syncSlots(tx, coachId, now)
  })
}

function coachesWithHours(db: Deps['db']) {
  return db
    .selectDistinct({ id: coachHours.coachId })
    .from(coachHours)
    .innerJoin(coaches, eq(coaches.id, coachHours.coachId))
    .where(eq(coaches.active, true))
    .all()
    .map((r) => r.id)
}

/** How many days ahead each coach's slots reach, to tell later whether an edit changed it. */
export function slotWindows(db: Deps['db']): Map<number, number> {
  const book = ruleBook(db)
  return new Map(coachesWithHours(db).map((id) => [id, book.longestAdvanceDays(taughtBy(db, id))]))
}

/**
 * Brings the slots of coaches whose window changed since `before` in line now, rather than at the
 * next hourly sync, so a longer window is bookable at once.
 */
export function syncChangedWindows(deps: Deps, before: Map<number, number>) {
  const now = deps.now()
  for (const [id, days] of slotWindows(deps.db)) {
    if (before.get(id) === days) continue
    try {
      immediate(deps.db, (tx) => syncSlots(tx, id, now))
    } catch (e) {
      deps.log('slot sync failed', { coachId: id, error: (e as Error).message })
    }
  }
}

/** Rolls every active coach's generated slots forward as days pass. */
export function syncAllSlots(deps: Deps) {
  const now = deps.now()
  for (const id of coachesWithHours(deps.db)) {
    try {
      immediate(deps.db, (tx) => syncSlots(tx, id, now))
    } catch (e) {
      deps.log('slot sync failed', { coachId: id, error: (e as Error).message })
    }
  }
}
