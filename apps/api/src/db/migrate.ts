import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { config } from '../config'
import { type Db, openDb } from './client'

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url))

export function runMigrations(db: Db) {
  if (existsSync(migrationsFolder)) migrate(db, { migrationsFolder })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations(openDb(config.databasePath))
}
