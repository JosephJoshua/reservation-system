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
