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

/**
 * Rows that would stop a pending migration from adding a unique index, as messages. Checked
 * before migrating, so a database with them fails to start with a message that names them,
 * rather than SQLite's bare constraint error, and is left as it was (the migrations run in one
 * transaction). deploy/README.md says what to do then.
 */
export function migrationBlockers(db: Db): string[] {
  const raw = db.$client
  const hasTable = (name: string) =>
    raw.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(name)
  const hasIndex = (name: string) =>
    raw.prepare("select 1 from sqlite_master where type = 'index' and name = ?").get(name)
  const found: string[] = []
  // 0028_data_backstops: one package per order.
  if (hasTable('packages') && !hasIndex('packages_order')) {
    const rows = raw
      .prepare(
        `select order_id as orderId, group_concat(id) as ids from packages
         where order_id is not null group by order_id having count(*) > 1`,
      )
      .all() as { orderId: number; ids: string }[]
    for (const r of rows) found.push(`order ${r.orderId} has several packages (ids ${r.ids})`)
  }
  // 0028_data_backstops: one pay line per lesson and month.
  if (hasTable('coach_pay_entries') && !hasIndex('coach_pay_entries_lesson')) {
    const rows = raw
      .prepare(
        `select month, unit, group_concat(id) as ids from coach_pay_entries
         where kind = 'lesson' group by month, unit having count(*) > 1`,
      )
      .all() as { month: string; unit: string; ids: string }[]
    for (const r of rows) {
      found.push(`coach pay for ${r.month} lists lesson ${r.unit} several times (ids ${r.ids})`)
    }
  }
  return found
}

export function runMigrations(db: Db) {
  if (!existsSync(migrationsFolder)) return
  const blockers = migrationBlockers(db)
  if (blockers.length) {
    throw new Error(
      `The database cannot be migrated, nothing was changed: ${blockers.join('; ')}. See "Duplicate rows at startup" in deploy/README.md.`,
    )
  }
  migrate(db, { migrationsFolder })
}

// Run as a script (pnpm db:migrate). Matched by file name, since in the bundled server this
// module shares the entry file's URL.
if (/[\\/]migrate\.ts$/.test(process.argv[1] ?? '')) {
  runMigrations(openDb(config.databasePath))
}
