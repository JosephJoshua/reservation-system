import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema'

export type Db = ReturnType<typeof openDb>

/** Opens the SQLite database. Pass ':memory:' for tests. */
export function openDb(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const sqlite = new Database(path)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  return drizzle(sqlite, { schema })
}

/** The query surface shared by the database and a transaction. */
export type Q = Pick<Db, 'select' | 'insert' | 'update' | 'delete'>

/**
 * Runs `fn` in an IMMEDIATE transaction: it takes the write lock up front, so two requests can
 * never both read "slot free" and then both write. `fn` must be synchronous.
 */
export function immediate<T>(db: Db, fn: (tx: Q) => T): T {
  return db.transaction((tx) => fn(tx), { behavior: 'immediate' })
}
