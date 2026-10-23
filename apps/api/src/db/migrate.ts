import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { config } from '../config'
import { type Db, openDb } from './client'

/** Nearest directory at or above `from` that holds a package.json. */
export function packageRoot(from: string): string {
  let dir = from
  while (!existsSync(join(dir, 'package.json'))) {
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`No package.json above ${from}`)
    dir = parent
  }
  return dir
}

// Found from the package root so it works from src/ in dev and from the bundled dist/ build.
export const migrationsFolder = join(
  packageRoot(dirname(fileURLToPath(import.meta.url))),
  'drizzle',
)

export function runMigrations(db: Db) {
  if (existsSync(migrationsFolder)) migrate(db, { migrationsFolder })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations(openDb(config.databasePath))
}
