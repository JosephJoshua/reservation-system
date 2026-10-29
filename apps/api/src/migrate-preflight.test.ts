import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { describe, expect, it } from 'vitest'
import { type Db, openDb } from './db/client'
import { migrationsFolder, runMigrations } from './db/migrate'

/** A database migrated up to, and not including, 0028_data_backstops. */
function before0028() {
  const dir = mkdtempSync(join(tmpdir(), 'rs-migrations-'))
  cpSync(migrationsFolder, dir, { recursive: true })
  const journalPath = join(dir, 'meta', '_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'))
  journal.entries = journal.entries.filter((e: { idx: number }) => e.idx < 28)
  writeFileSync(journalPath, JSON.stringify(journal))
  const db = openDb(':memory:')
  migrate(db, { migrationsFolder: dir })
  return db
}

/** Inserts a row with every required column filled with a placeholder, foreign keys off. */
function insert(db: Db, table: string, values: Record<string, unknown>) {
  const raw = db.$client
  const cols = raw.prepare(`pragma table_info("${table}")`).all() as {
    name: string
    type: string
    notnull: number
    dflt_value: unknown
    pk: number
  }[]
  const row: Record<string, unknown> = {}
  for (const c of cols) {
    if (c.pk || !c.notnull || c.dflt_value !== null) continue
    row[c.name] = /int/i.test(c.type) ? 1 : 'x'
  }
  Object.assign(row, values)
  const names = Object.keys(row)
  raw.pragma('foreign_keys = off')
  raw
    .prepare(
      `insert into "${table}" (${names.map((n) => `"${n}"`).join(',')}) values (${names.map(() => '?').join(',')})`,
    )
    .run(...names.map((n) => row[n]))
  raw.pragma('foreign_keys = on')
}

const indexes = (db: Db) =>
  (
    db.$client.prepare("select name from sqlite_master where type = 'index'").all() as {
      name: string
    }[]
  ).map((r) => r.name)

describe('migrating a database with rows 0028 cannot index', () => {
  it('refuses with a message naming them and changes nothing', () => {
    const db = before0028()
    insert(db, 'packages', { id: 1, order_id: 7 })
    insert(db, 'packages', { id: 2, order_id: 7 })
    insert(db, 'coach_pay_entries', { id: 1, month: '2026-09', unit: 'b12', kind: 'lesson' })
    insert(db, 'coach_pay_entries', { id: 2, month: '2026-09', unit: 'b12', kind: 'lesson' })
    expect(() => runMigrations(db)).toThrow(
      /nothing was changed: order 7 has several packages \(ids 1,2\); coach pay for 2026-09 lists lesson b12 several times \(ids 1,2\)\. See "Duplicate rows at startup"/,
    )
    expect(indexes(db)).not.toContain('packages_order')
  })

  it('migrates once the duplicates are gone', () => {
    const db = before0028()
    insert(db, 'packages', { id: 1, order_id: 7 })
    insert(db, 'packages', { id: 2, order_id: 8 })
    runMigrations(db)
    expect(indexes(db)).toContain('packages_order')
    // Already migrated: checked no more.
    runMigrations(db)
  })
})
