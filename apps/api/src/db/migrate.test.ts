import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { migrationsFolder, packageRoot } from './migrate'

const apiRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))

describe('migrationsFolder', () => {
  it('points at apps/api/drizzle', () => {
    expect(migrationsFolder).toBe(join(apiRoot, 'drizzle'))
  })

  it('resolves the same root from the bundled dist directory', () => {
    expect(packageRoot(join(apiRoot, 'dist'))).toBe(apiRoot)
  })
})

describe('0001_coach_mode', () => {
  it('treats existing bookings as announced, except unpaid holds', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = off')
    const run = (file: string) => {
      const sql = readFileSync(join(migrationsFolder, file), 'utf8')
      for (const statement of sql.split('--> statement-breakpoint')) db.exec(statement)
    }
    run('0000_payments_and_booking_core.sql')
    const insert = db.prepare(
      "insert into bookings (slot_id, student_id, lesson_type_id, starts_at, ends_at, status, paid_with, price) values (?, 1, 1, 0, 1, ?, 'order', 100)",
    )
    for (const [i, status] of ['confirmed', 'pending_payment', 'cancelled', 'expired'].entries())
      insert.run(i, status)
    run('0001_coach_mode.sql')
    const rows = db
      .prepare(
        'select status, coach_told_booked_at is not null as booked, coach_told_cancelled_at is not null as cancelled from bookings order by id',
      )
      .all()
    expect(rows).toEqual([
      { status: 'confirmed', booked: 1, cancelled: 0 },
      { status: 'pending_payment', booked: 0, cancelled: 0 },
      { status: 'cancelled', booked: 1, cancelled: 1 },
      { status: 'expired', booked: 1, cancelled: 1 },
    ])
  })
})

describe('0008_booking_moves', () => {
  it('records what coaches were already told about, so only later moves are announced', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = off')
    const run = (file: string) => {
      const sql = readFileSync(join(migrationsFolder, file), 'utf8')
      for (const statement of sql.split('--> statement-breakpoint')) db.exec(statement)
    }
    for (const file of [
      '0000_payments_and_booking_core.sql',
      '0001_coach_mode.sql',
      '0002_student_notices.sql',
      '0003_idempotency_keys.sql',
      '0004_coach_categories.sql',
      '0005_privacy_and_account_deletion.sql',
      '0006_staff_and_action_log.sql',
      '0007_invoices.sql',
    ])
      run(file)
    db.exec(
      'insert into slots (id, coach_id, starts_at, ends_at) values (7, 3, 1000, 2000), (8, 4, 1000, 2000)',
    )
    const insert = db.prepare(
      "insert into bookings (slot_id, student_id, lesson_type_id, starts_at, ends_at, status, paid_with, price, coach_told_booked_at) values (?, 1, 1, 1000, 2000, ?, 'order', 100, ?)",
    )
    insert.run(7, 'confirmed', 5)
    insert.run(8, 'pending_payment', null)
    db.exec(
      "insert into student_notices (booking_id, kind, data, created_at, done_at) values (1, 'reminder', '{}', 0, 1), (2, 'reminder', '{}', 0, null)",
    )
    run('0008_booking_moves.sql')
    // Reminders already sent were of the lesson's time then, which moves had not changed yet.
    expect(
      db
        .prepare(
          "select json_extract(data, '$.remindedFor') as at from student_notices order by id",
        )
        .all(),
    ).toEqual([{ at: '1000' }, { at: null }])
    const rows = db
      .prepare(
        'select coach_told_coach_id as coach, coach_told_starts_at as startsAt, coach_told_ends_at as endsAt from bookings order by id',
      )
      .all()
    expect(rows).toEqual([
      { coach: 3, startsAt: 1000, endsAt: 2000 },
      { coach: null, startsAt: null, endsAt: null },
    ])
  })
})

describe('0022_schedule', () => {
  it('turns days off and hand-made slots into 请假 and 加班, and drops unused slots', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = off')
    const run = (file: string) => {
      const sql = readFileSync(join(migrationsFolder, file), 'utf8')
      for (const statement of sql.split('--> statement-breakpoint')) db.exec(statement)
    }
    const files = readdirSync(migrationsFolder)
      .filter((f) => f.endsWith('.sql'))
      .sort()
    for (const file of files.slice(0, files.indexOf('0022_schedule.sql'))) run(file)
    const ms = (iso: string) => Date.parse(iso)
    const now = Date.now()
    const future = (h: number) => now + h * 3_600_000
    db.exec(
      `insert into coach_hours (coach_id, weekday, start_minute, end_minute, lesson_minutes) values (1, 0, 540, 720, 60)`,
    )
    db.exec(`insert into coach_days_off (coach_id, date) values (1, '2026-10-25')`)
    const slot = db.prepare(
      'insert into slots (id, coach_id, starts_at, ends_at, lesson_type_id, source, open, closed_by_sync) values (?, 1, ?, ?, ?, ?, ?, ?)',
    )
    // 1: opened by hand, free. 2: from weekly hours, free. 3: closed by a person, free.
    // 4: closed by the hourly sync. 5: booked. 6: a group session. 7: closed by a person, past.
    slot.run(1, future(24), future(25), null, 'manual', 1, 0)
    slot.run(2, future(26), future(27), null, 'hours', 1, 0)
    slot.run(3, future(28), future(29), null, 'hours', 0, 0)
    slot.run(4, future(30), future(31), null, 'hours', 0, 1)
    slot.run(5, future(32), future(33), null, 'hours', 1, 0)
    slot.run(6, future(34), future(35), 9, 'manual', 1, 0)
    slot.run(7, future(-30), future(-29), null, 'hours', 0, 0)
    // A cancelled booking still keeps its slot, which history points at.
    db.exec(
      `insert into bookings (slot_id, student_id, lesson_type_id, starts_at, ends_at, status, paid_with, price) values (5, 1, 1, ${future(32)}, ${future(33)}, 'confirmed', 'order', 100), (4, 1, 1, ${future(30)}, ${future(31)}, 'cancelled', 'order', 100)`,
    )
    run('0022_schedule.sql')

    const exceptions = db
      .prepare(
        'select coach_id as coachId, kind, starts_at as startsAt, ends_at as endsAt from schedule_exceptions order by id',
      )
      .all()
    expect(exceptions).toEqual([
      // Venue midnight to midnight, UTC+8.
      {
        coachId: 1,
        kind: 'off',
        startsAt: ms('2026-10-24T16:00:00Z'),
        endsAt: ms('2026-10-25T16:00:00Z'),
      },
      { coachId: 1, kind: 'extra', startsAt: future(24), endsAt: future(25) },
      { coachId: 1, kind: 'off', startsAt: future(28), endsAt: future(29) },
    ])
    expect(db.prepare('select id from slots order by id').all()).toEqual([
      { id: 4 },
      { id: 5 },
      { id: 6 },
    ])
    expect(db.prepare('select * from coach_hours').all()).toEqual([
      {
        id: 1,
        coach_id: 1,
        weekday: 0,
        start_minute: 540,
        end_minute: 720,
        from_date: '2000-01-01',
        to_date: null,
      },
    ])
    const slotColumns = db
      .prepare('pragma table_info(slots)')
      .all()
      .map((c) => (c as { name: string }).name)
    expect(slotColumns).not.toContain('source')
    expect(slotColumns).not.toContain('closed_by_sync')
    expect(
      db.prepare("select name from sqlite_master where name = 'coach_days_off'").all(),
    ).toEqual([])
  })
})
