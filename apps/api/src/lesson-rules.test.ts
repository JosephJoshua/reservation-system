import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { venueInstant } from '@rs/shared'
import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { migrationsFolder } from './db/migrate'
import { actionLog, bookings, lessonTypes, refunds } from './db/schema'
import { type Harness, setup } from './test/harness'

// The harness clock is 2026-10-23 10:00 at the venue. Venue defaults: 14 days ahead, 2 hours'
// notice, free cancel until 24 hours before, then forfeit, 1 move.

function ownRules(h: Harness, id: number, rules: object) {
  h.db.update(lessonTypes).set({ rules }).where(eq(lessonTypes.id, id)).run()
}

async function book(h: Harness, token: string, slotId: number, lessonTypeId: number) {
  const res = await h.call('POST', '/bookings', { slotId, lessonTypeId }, token)
  if (res.json?.orderId) await h.call('POST', `/dev/fake-pay/${res.json.orderId}`)
  return res
}

const lessonBody = {
  name: '一对一私教',
  durationMinutes: 60,
  price: 20000,
}

describe('booking rules per lesson type', () => {
  it('lists each lesson type with its own rules over the venue defaults', async () => {
    const h = setup()
    const { lesson, trial } = h.seed()
    ownRules(h, lesson.id, { advanceDays: 30, lateCancel: { kind: 'partial', percent: 50 } })
    const t = await h.student('a')
    const catalog = (await h.call('GET', '/catalog', undefined, t)).json
    const rules = (id: number) => catalog.lessonTypes.find((x: { id: number }) => x.id === id).rules
    expect(rules(lesson.id)).toEqual({
      advanceDays: 30,
      minNoticeMinutes: 120,
      cancelDeadlineHours: 24,
      lateCancel: { kind: 'partial', percent: 50 },
      studentMoves: 1,
    })
    expect(rules(trial.id)).toMatchObject({ advanceDays: 14, lateCancel: { kind: 'forfeit' } })

    // A rule the type leaves out follows the venue's when that changes.
    h.settings((s) => {
      s.booking.minNoticeMinutes = 0
      s.booking.advanceDays = 7
    })
    const after = (await h.call('GET', '/catalog', undefined, t)).json
    const changed = after.lessonTypes.find((x: { id: number }) => x.id === lesson.id).rules
    expect(changed).toMatchObject({ advanceDays: 30, minNoticeMinutes: 0 })
  })

  it("books within the lesson type's own window", async () => {
    const h = setup()
    const { coach, lesson, trial } = h.seed()
    ownRules(h, lesson.id, { advanceDays: 30 })
    ownRules(h, trial.id, { minNoticeMinutes: 24 * 60 })
    const t = await h.student('a')

    // Twenty days ahead: past the venue's 14, inside the lesson's 30.
    const far = h.slot(coach.id, '2026-11-12', 10)
    const listed = (
      await h.call('GET', `/slots?date=2026-11-12&lessonTypeId=${lesson.id}`, undefined, t)
    ).json
    expect(
      listed.find((s: { startsAt: string }) => s.startsAt === far.startsAt.toISOString()),
    ).toMatchObject({ available: true })
    const trialListed = (
      await h.call('GET', `/slots?date=2026-11-12&lessonTypeId=${trial.id}`, undefined, t)
    ).json
    expect(trialListed).toEqual([])
    const days = (await h.call('GET', `/slots/open-days?lessonTypeId=${lesson.id}`, undefined, t))
      .json
    expect(days).toContain('2026-11-12')
    expect((await book(h, t, far.id, lesson.id)).status).toBe(201)

    // Tomorrow is too soon for the trial, which wants a day's notice, but not for the lesson.
    const soon = h.slot(coach.id, '2026-10-24', 9)
    expect((await book(h, t, soon.id, trial.id)).json.error.code).toBe('too_soon')
    const b = await h.student('b')
    expect((await book(h, b, soon.id, lesson.id)).status).toBe(201)
  })

  it('cancels under the rules the lesson was booked with, not later edits', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const t = await h.student('a')
    const slot = h.slot(coach.id, '2026-10-25', 10)
    const res = await book(h, t, slot.id, lesson.id)
    const id = res.json.bookingId as number
    expect(h.db.select().from(bookings).where(eq(bookings.id, id)).get()?.terms).toEqual({
      cancelDeadlineHours: 24,
      lateCancel: { kind: 'forfeit' },
      studentMoves: 1,
    })

    // Made stricter afterwards, on the lesson type and for the venue.
    ownRules(h, lesson.id, { cancelDeadlineHours: 72 })
    h.settings((s) => {
      s.booking.cancelDeadlineHours = 72
    })
    const view = (await h.call('GET', `/bookings/${id}`, undefined, t)).json
    expect(view).toMatchObject({
      cancelDeadline: venueInstant('2026-10-24', 10 * 60).toISOString(),
      terms: { cancelDeadlineHours: 24 },
    })
    const cancelled = await h.call('POST', `/bookings/${id}/cancel`, {}, t)
    expect(cancelled.json).toMatchObject({ status: 'cancelled', late: false })
    expect(h.db.select().from(refunds).all()).toMatchObject([{ amount: 20000 }])
  })

  it("applies the lesson type's late-cancel refund to lessons booked under it", async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    ownRules(h, lesson.id, {
      cancelDeadlineHours: 48,
      lateCancel: { kind: 'partial', percent: 50 },
    })
    const t = await h.student('a')
    const res = await book(h, t, h.slot(coach.id, '2026-10-24', 18).id, lesson.id)
    const id = res.json.bookingId as number
    // Booked 32 hours ahead, inside the lesson's 48: cancelling now is late, at half back.
    const early = await h.call('POST', `/bookings/${id}/cancel`, {}, t)
    expect(early.json.error.code).toBe('late_now')
    const late = await h.call('POST', `/bookings/${id}/cancel`, { acceptLate: true }, t)
    expect(late.json).toMatchObject({ status: 'cancelled', late: true })
    expect(h.db.select().from(refunds).all()).toMatchObject([{ amount: 10000 }])
  })

  it("follows the lesson type's current rules for a booking made before they were kept", async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const t = await h.student('a')
    const res = await book(h, t, h.slot(coach.id, '2026-10-25', 10).id, lesson.id)
    const id = res.json.bookingId as number
    h.db.update(bookings).set({ terms: null }).where(eq(bookings.id, id)).run()
    ownRules(h, lesson.id, { cancelDeadlineHours: 72, studentMoves: 0 })
    expect((await h.call('GET', `/bookings/${id}`, undefined, t)).json).toMatchObject({
      cancelDeadline: venueInstant('2026-10-22', 10 * 60).toISOString(),
      canMove: false,
      terms: { cancelDeadlineHours: 72, studentMoves: 0 },
    })
    const cancelled = await h.call('POST', `/bookings/${id}/cancel`, {}, t)
    expect(cancelled.json.error.code).toBe('late_now')
  })

  it('follows the venue for a saved rule it no longer accepts, keeping the others', async () => {
    const h = setup()
    const { lesson } = h.seed()
    ownRules(h, lesson.id, {
      studentMoves: 0,
      lateCancel: { kind: 'partial' },
      cancelDeadlineHours: 48,
    })
    const t = await h.student('a')
    const catalog = (await h.call('GET', '/catalog', undefined, t)).json
    expect(catalog.lessonTypes.find((x: { id: number }) => x.id === lesson.id).rules).toMatchObject(
      {
        studentMoves: 0,
        cancelDeadlineHours: 48,
        lateCancel: { kind: 'forfeit' },
      },
    )
    const admin = await h.admin()
    const listed = (await h.call('GET', '/admin/lesson-types', undefined, admin)).json
    expect(listed.find((x: { id: number }) => x.id === lesson.id).rules).toEqual({
      studentMoves: 0,
      cancelDeadlineHours: 48,
    })
  })

  it('keeps the rules on lessons the front desk books', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    ownRules(h, lesson.id, { studentMoves: 3 })
    const admin = await h.admin()
    await h.student('a')
    const slot = h.slot(coach.id, '2026-10-25', 10)
    const res = await h.call(
      'POST',
      '/admin/bookings',
      { studentId: 1, slotId: slot.id, lessonTypeId: lesson.id, payWith: 'offline', amount: 0 },
      admin,
    )
    expect(res.status).toBe(201)
    expect(h.db.select().from(bookings).get()?.terms).toMatchObject({ studentMoves: 3 })
  })

  it('saves, validates and logs a lesson type’s own rules', async () => {
    const h = setup()
    const admin = await h.admin()
    const created = await h.call(
      'POST',
      '/admin/lesson-types',
      { ...lessonBody, rules: { advanceDays: 30 } },
      admin,
    )
    expect(created.json.rules).toEqual({ advanceDays: 30 })
    const plain = await h.call(
      'POST',
      '/admin/lesson-types',
      { ...lessonBody, name: '体验' },
      admin,
    )
    expect(plain.json.rules).toEqual({})

    for (const rules of [
      { advanceDays: 0 },
      { studentMoves: 6 },
      { lateCancel: { kind: 'partial', percent: 101 } },
      { minNoticeMinutes: -1 },
    ]) {
      const bad = await h.call('POST', '/admin/lesson-types', { ...lessonBody, rules }, admin)
      expect(bad.status).toBe(400)
    }

    const id = created.json.id as number
    const current = (await h.call('GET', '/admin/lesson-types', undefined, admin)).json[0]
    const saved = await h.call(
      'PUT',
      `/admin/lesson-types/${id}`,
      { ...current, rules: { cancelDeadlineHours: 12 } },
      admin,
    )
    expect(saved.json.rules).toEqual({ cancelDeadlineHours: 12 })
    const logged = h.db
      .select()
      .from(actionLog)
      .all()
      .filter((r) => r.action === 'rules.lesson_type')
    expect(logged.map((r) => r.summary)).toEqual([
      '课程「一对一私教」的预约规则：单独设置可提前预约 30 天以内',
      '课程「一对一私教」的预约规则：单独设置免费取消 开课前 12 小时以上',
    ])

    // An edit that leaves rules out keeps them.
    const kept = await h.call(
      'PUT',
      `/admin/lesson-types/${id}`,
      { ...lessonBody, name: '一对一私教' },
      admin,
    )
    expect(kept.json.rules).toEqual({ cancelDeadlineHours: 12 })

    // The same rules, in another order, log nothing more.
    await h.call('PUT', `/admin/lesson-types/${id}`, { ...saved.json, name: '一对一' }, admin)
    await h.call(
      'PUT',
      `/admin/lesson-types/${id}`,
      { ...saved.json, rules: { advanceDays: 20, cancelDeadlineHours: 12 } },
      admin,
    )
    await h.call(
      'PUT',
      `/admin/lesson-types/${id}`,
      { ...saved.json, rules: { cancelDeadlineHours: 12, advanceDays: 20 } },
      admin,
    )
    expect(
      h.db
        .select()
        .from(actionLog)
        .all()
        .filter((r) => r.action === 'rules.lesson_type'),
    ).toHaveLength(3)
  })

  it('shows coaches the days of the longest window any lesson type has', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const admin = await h.admin()
    const before = (await h.call('GET', `/admin/coaches/${coach.id}/hours`, undefined, admin)).json
    ownRules(h, lesson.id, { advanceDays: 30 })
    const after = (await h.call('GET', `/admin/coaches/${coach.id}/hours`, undefined, admin)).json
    expect(before.advanceDays).toBe(14)
    expect(after.advanceDays).toBe(30)
    // A lesson type nobody can book does not stretch it.
    h.db.update(lessonTypes).set({ active: false }).where(eq(lessonTypes.id, lesson.id)).run()
    const off = (await h.call('GET', `/admin/coaches/${coach.id}/hours`, undefined, admin)).json
    expect(off.advanceDays).toBe(14)
  })

  it('refuses a booking whose rules changed since the student saw them', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    ownRules(h, lesson.id, {
      cancelDeadlineHours: 48,
      lateCancel: { kind: 'partial', percent: 50 },
    })
    const t = await h.student('a')
    const shown = {
      cancelDeadlineHours: 48,
      lateCancel: { kind: 'partial', percent: 50 },
      studentMoves: 1,
    }
    const slot = h.slot(coach.id, '2026-10-27', 10)
    ownRules(h, lesson.id, { cancelDeadlineHours: 2 })
    const body = { slotId: slot.id, lessonTypeId: lesson.id, payWith: 'wechat' }
    const refused = await h.call('POST', '/bookings', { ...body, expectedTerms: shown }, t)
    expect(refused.status).toBe(409)
    expect(refused.json.error.code).toBe('terms_changed')
    expect(h.db.select().from(bookings).all()).toHaveLength(0)

    const now = { cancelDeadlineHours: 2, lateCancel: { kind: 'forfeit' }, studentMoves: 1 }
    const booked = await h.call('POST', '/bookings', { ...body, expectedTerms: now }, t)
    expect(booked.status).toBe(201)
    expect(h.db.select().from(bookings).get()?.terms).toEqual(now)
  })

  it("offers move times inside the lesson type's own window", async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    ownRules(h, lesson.id, { advanceDays: 30 })
    const t = await h.student('a')
    const id = (await book(h, t, h.slot(coach.id, '2026-10-25', 10).id, lesson.id)).json.bookingId
    const far = h.slot(coach.id, '2026-11-12', 10)
    const listed = (
      await h.call('GET', `/slots?date=2026-11-12&coachId=${coach.id}&moving=${id}`, undefined, t)
    ).json
    expect(listed).toEqual([
      expect.objectContaining({ startsAt: far.startsAt.toISOString(), available: true }),
    ])
  })

  it("tells the move page the lesson type's window, even when students cannot book it now", async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const t = await h.student('a')
    const id = (await book(h, t, h.slot(coach.id, '2026-10-25', 10).id, lesson.id)).json.bookingId
    ownRules(h, lesson.id, { advanceDays: 3, minNoticeMinutes: 0 })
    h.db.update(lessonTypes).set({ active: false }).where(eq(lessonTypes.id, lesson.id)).run()
    expect((await h.call('GET', `/bookings/${id}`, undefined, t)).json.window).toEqual({
      advanceDays: 3,
      minNoticeMinutes: 0,
    })
  })
})

describe('0021_lesson_type_rules', () => {
  const migrated = (settings: object | null) => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = off')
    const run = (file: string) => {
      const sql = readFileSync(join(migrationsFolder, file), 'utf8')
      for (const statement of sql.split('--> statement-breakpoint')) db.exec(statement)
    }
    const files = readdirSync(migrationsFolder).filter((f) => f.endsWith('.sql'))
    for (const f of files.filter((f) => f < '0021')) run(f)
    if (settings) {
      db.prepare('insert into settings (id, data, updated_at) values (1, ?, 0)').run(
        JSON.stringify(settings),
      )
    }
    db.exec(`insert into bookings (slot_id, student_id, lesson_type_id, starts_at, ends_at, status,
      paid_with, price) values (1, 1, 1, 0, 0, 'confirmed', 'order', 100)`)
    run(files.find((f) => f.startsWith('0021')) ?? '')
    const row = db.prepare('select terms from bookings').get() as { terms: string }
    return JSON.parse(row.terms)
  }

  it('keeps the venue rules of the day on lessons already booked', () => {
    expect(
      migrated({
        booking: {
          cancelDeadlineHours: 12,
          lateCancel: { kind: 'partial', percent: 30 },
          studentMoves: 2,
        },
      }),
    ).toEqual({
      cancelDeadlineHours: 12,
      lateCancel: { kind: 'partial', percent: 30 },
      studentMoves: 2,
    })
  })

  it('uses the shipped defaults for rules never saved', () => {
    const defaults = { cancelDeadlineHours: 24, lateCancel: { kind: 'forfeit' }, studentMoves: 1 }
    expect(migrated(null)).toEqual(defaults)
    expect(migrated({ booking: { advanceDays: 7 } })).toEqual(defaults)
    // Values the app would not accept are not copied.
    expect(
      migrated({
        booking: { cancelDeadlineHours: -3, lateCancel: { kind: 'partial' }, studentMoves: 9 },
      }),
    ).toEqual(defaults)
    expect(
      migrated({
        booking: { cancelDeadlineHours: 2.5, lateCancel: { kind: 'partial', percent: 100 } },
      }),
    ).toEqual({ ...defaults, lateCancel: { kind: 'partial', percent: 100 } })
  })
})
