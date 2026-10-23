// Consistent copies of the live SQLite database, safe while the API is writing to it.
//   node sqlite.mjs snapshot <db> <out>   online backup of <db> into <out>, then check <out>
//   node sqlite.mjs check <db>            integrity check
//   node sqlite.mjs summary <db>          row counts and the newest booking and order
import Database from 'better-sqlite3'

const [command, source, target] = process.argv.slice(2)

function check(path) {
  const db = new Database(path, { readonly: true, fileMustExist: true })
  try {
    const result = db.pragma('integrity_check', { simple: true })
    if (result !== 'ok') throw new Error(`integrity check failed for ${path}: ${result}`)
    const tables = db.prepare("select count(*) as n from sqlite_master where type = 'table'").get()
    if (tables.n === 0) throw new Error(`${path} has no tables`)
  } finally {
    db.close()
  }
}

if (command === 'snapshot' && source && target) {
  const db = new Database(source, { fileMustExist: true, timeout: 10_000 })
  try {
    await db.backup(target)
  } finally {
    db.close()
  }
  check(target)
} else if (command === 'check' && source) {
  check(source)
} else if (command === 'summary' && source) {
  const db = new Database(source, { readonly: true, fileMustExist: true })
  const tables = ['students', 'coaches', 'bookings', 'orders', 'packages', 'refunds']
  for (const table of tables) {
    console.log(`${table}: ${db.prepare(`select count(*) as n from ${table}`).get().n}`)
  }
  for (const table of ['bookings', 'orders']) {
    const { at } = db.prepare(`select max(created_at) as at from ${table}`).get()
    console.log(`newest ${table.slice(0, -1)}: ${at ? new Date(at).toISOString() : 'none'}`)
  }
  db.close()
} else {
  console.error('usage: sqlite.mjs snapshot <db> <out> | check <db> | summary <db>')
  process.exit(2)
}
