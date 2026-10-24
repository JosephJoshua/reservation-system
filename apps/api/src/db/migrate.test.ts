import { readFileSync } from 'node:fs'
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
