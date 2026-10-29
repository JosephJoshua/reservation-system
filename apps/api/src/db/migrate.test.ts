import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from './client'
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

describe('0023_hash_session_tokens', () => {
  it('ends every session, since a plain token cannot be hashed in SQL', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = off')
    const run = (file: string) => {
      const sql = readFileSync(join(migrationsFolder, file), 'utf8')
      for (const statement of sql.split('--> statement-breakpoint')) db.exec(statement)
    }
    const files = readdirSync(migrationsFolder)
      .filter((f) => f.endsWith('.sql'))
      .sort()
    for (const file of files.slice(0, files.indexOf('0023_hash_session_tokens.sql'))) run(file)
    db.pragma('foreign_keys = on')
    db.exec("insert into students (id, openid) values (1, 'wx')")
    db.exec(
      "insert into staff (id, name, username, password_hash) values (1, '管理员', 'admin', 'x')",
    )
    db.exec(
      "insert into sessions (token, role, student_id, expires_at) values ('a', 'student', 1, 9e12)",
    )
    db.exec(
      "insert into sessions (token, role, staff_id, expires_at) values ('b', 'admin', 1, 9e12)",
    )
    run('0023_hash_session_tokens.sql')
    expect(db.prepare('select * from sessions').all()).toEqual([])
    expect(
      db
        .prepare('pragma table_info(sessions)')
        .all()
        .map((c) => (c as { name: string }).name),
    ).toEqual(['token_hash', 'role', 'student_id', 'expires_at', 'coach_id', 'staff_id'])
    expect(db.prepare('select id from students').all()).toEqual([{ id: 1 }])
    expect(db.pragma('foreign_key_check')).toEqual([])
  })
})

describe('0026_outside_agreed', () => {
  it('marks lessons yet to come that the venue placed, to be checked against 排班', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = off')
    const run = (file: string) => {
      const sql = readFileSync(join(migrationsFolder, file), 'utf8')
      for (const statement of sql.split('--> statement-breakpoint')) db.exec(statement)
    }
    const files = readdirSync(migrationsFolder)
      .filter((f) => f.endsWith('.sql'))
      .sort()
    for (const file of files.slice(0, files.indexOf('0026_outside_agreed.sql'))) run(file)
    const later = Date.now() + 86_400_000
    const slot = db.prepare(
      'insert into slots (id, coach_id, starts_at, ends_at, lesson_type_id) values (?, 1, ?, ?, ?)',
    )
    for (let id = 1; id <= 7; id++) slot.run(id, later, later + 3_600_000, null)
    slot.run(8, later, later + 3_600_000, 9)
    const insert = db.prepare(
      "insert into bookings (id, slot_id, student_id, lesson_type_id, starts_at, ends_at, status, paid_with, price, booked_by_staff_id) values (?, ?, ?, 1, ?, ?, ?, 'order', 100, ?)",
    )
    const book = (id: number, status: string, staff: number | null, startsAt = later) =>
      insert.run(id, id, id, startsAt, startsAt + 3_600_000, status, staff)
    // 1: a student's. 2: the desk's. 3: a student's, last moved by the venue. 4: the desk's, last
    // moved by the coach. 5: the desk's, cancelled. 6: the desk's, past. 7: the desk's, pending.
    // 8: the desk's seat in a group session.
    book(1, 'confirmed', null)
    book(2, 'confirmed', 1)
    book(3, 'confirmed', null)
    book(4, 'confirmed', 1)
    book(5, 'cancelled', 1)
    book(6, 'confirmed', 1, Date.now() - 86_400_000)
    book(7, 'pending_payment', 1)
    book(8, 'confirmed', 1)
    const move = db.prepare(
      'insert into booking_moves (booking_id, by, from_coach_id, from_starts_at, from_ends_at, to_coach_id, to_starts_at, to_ends_at) values (?, ?, 1, 0, 1, 1, 0, 1)',
    )
    move.run(3, 'student')
    move.run(3, 'venue')
    move.run(4, 'venue')
    move.run(4, 'coach')
    db.pragma('foreign_keys = on')
    run('0026_outside_agreed.sql')
    expect(
      db.prepare('select id, outside_agreed as agreed from bookings order by id').all(),
    ).toEqual([
      { id: 1, agreed: 0 },
      { id: 2, agreed: 2 },
      { id: 3, agreed: 2 },
      { id: 4, agreed: 0 },
      { id: 5, agreed: 0 },
      { id: 6, agreed: 0 },
      { id: 7, agreed: 2 },
      { id: 8, agreed: 0 },
    ])
  })
})

describe('0027_action_log_coach_actor', () => {
  it('keeps every entry and the id counter, and takes either a staff member or a coach', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = off')
    const run = (file: string) => {
      const sql = readFileSync(join(migrationsFolder, file), 'utf8')
      for (const statement of sql.split('--> statement-breakpoint')) db.exec(statement)
    }
    const files = readdirSync(migrationsFolder)
      .filter((f) => f.endsWith('.sql'))
      .sort()
    for (const file of files.slice(0, files.indexOf('0027_action_log_coach_actor.sql'))) run(file)
    db.pragma('foreign_keys = on')
    db.exec(
      "insert into staff (id, name, username, password_hash) values (1, '管理员', 'admin', 'x')",
    )
    db.exec("insert into coaches (id, name) values (1, '王教练')")
    for (let i = 1; i <= 100; i++) {
      db.exec(
        `insert into action_log (staff_id, action, summary) values (1, 'data.export', 'e${i}')`,
      )
    }
    db.exec('delete from action_log where id > 8')
    run('0027_action_log_coach_actor.sql')
    expect(db.prepare('select count(*) n from action_log where staff_id = 1').get()).toEqual({
      n: 8,
    })
    // Ids of deleted entries are not handed out again.
    db.exec("insert into action_log (coach_id, action, summary) values (1, 'coach.hours', 'x')")
    expect(db.prepare('select max(id) id from action_log').get()).toEqual({ id: 101 })
    expect(() => db.exec("insert into action_log (action, summary) values ('x', 'y')")).toThrow(
      /CHECK/,
    )
    expect(() =>
      db.exec(
        "insert into action_log (staff_id, coach_id, action, summary) values (1, 1, 'x', 'y')",
      ),
    ).toThrow(/CHECK/)
    expect(db.pragma('foreign_key_check')).toEqual([])
  })
})

interface Journal {
  entries: { idx: number; when: number; tag: string }[]
}
const journal: Journal = JSON.parse(
  readFileSync(join(migrationsFolder, 'meta/_journal.json'), 'utf8'),
)

describe('migration journal', () => {
  it('lists every SQL file once, with strictly increasing times', () => {
    // The migrator applies only entries newer than the last applied `when`, so a migration merged
    // with an older time than the one before it would be skipped in production.
    const whens = journal.entries.map((e) => e.when)
    for (let i = 1; i < whens.length; i++) expect(whens[i]).toBeGreaterThan(whens[i - 1] as number)
    const files = readdirSync(migrationsFolder).filter((f) => f.endsWith('.sql'))
    expect(journal.entries.map((e) => `${e.tag}.sql`).sort()).toEqual(files.sort())
  })
})

describe('migrating a populated database the way production does', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  /** A migrations folder with the journal's entries up to and including `tag`. */
  function folderUpTo(root: string, tag: string) {
    const n = journal.entries.findIndex((e) => e.tag === tag) + 1
    expect(n).toBeGreaterThan(0)
    const dir = join(root, tag)
    mkdirSync(join(dir, 'meta'), { recursive: true })
    const entries = journal.entries.slice(0, n)
    for (const e of entries)
      copyFileSync(join(migrationsFolder, `${e.tag}.sql`), join(dir, `${e.tag}.sql`))
    writeFileSync(join(dir, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }))
    return dir
  }

  it('keeps foreign keys and integrity with data from the first releases', () => {
    const root = mkdtempSync(join(tmpdir(), 'rs-migrate-'))
    dirs.push(root)
    // openDb turns foreign keys on, as the server does when it migrates at start.
    const db = openDb(join(root, 'app.db'))
    const sqlite = db.$client
    expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1)

    migrate(db, { migrationsFolder: folderUpTo(root, '0001_coach_mode') })
    sqlite.exec(`
      insert into students (id, openid, name, phone) values (1,'o1','A','13800000000'),(2,'o2','B','');
      insert into coaches (id, name, bio) values (1,'C1','hello <b> & me'),(2,'C2','');
      insert into lesson_types (id, name, duration_minutes, price) values (1,'私教',60,20000);
      insert into coach_lesson_types (coach_id, lesson_type_id, price) values (1,1,30000),(2,1,null);
      insert into slots (id, coach_id, starts_at, ends_at, open) values
        (1,1,4102444800000,4102448400000,1),(2,1,4102452000000,4102455600000,1),(3,2,1000,2000,0);
      insert into orders (id, out_trade_no, student_id, kind, description, amount, provider, status, booking_id) values
        (1,'t1',1,'class','x',20000,'wechat','paid',1),(2,'t2',1,'package','10次',100,'wechat','paid',null);
      insert into bookings (id, slot_id, student_id, lesson_type_id, starts_at, ends_at, status, paid_with, price) values
        (1,1,1,1,4102444800000,4102448400000,'confirmed','order',20000),(2,3,2,1,1000,2000,'cancelled','order',20000);
      insert into package_products (id,name,lesson_type_id,lesson_count,price,validity_days) values (1,'10次',1,10,100,30);
      insert into packages (id,student_id,product_id,name,lesson_type_id,coach_ids,lessons_purchased,lessons_remaining,price_paid,expires_at,status,order_id) values
        (1,1,1,'10次',1,'[]',10,0,100,4102444800000,'active',2);
      insert into sessions (token, role, student_id, expires_at) values ('s1','student',1,4102444800000),('a1','admin',null,4102444800000);
      insert into settings (id, data, updated_at) values (1, '{"booking":{"cancelDeadlineHours":12,"lateCancel":{"kind":"partial","percent":50},"studentMoves":2}}', 0);
    `)

    // Coach pay as a confirmed month leaves it: a lesson, and a moved one paid back and forth.
    migrate(db, { migrationsFolder: folderUpTo(root, '0022_schedule') })
    sqlite.exec(`
      insert into staff (id, name, username, password_hash) values (1, 'S', 's', 'x');
      insert into coach_pay_months (month, rules, total, confirmed_at, staff_id) values ('2026-09', '{}', 0, 0, 1);
      insert into coach_pay_entries (month, kind, unit, coach_id, lesson_type_id, starts_at, rate, lessons, amount) values
        ('2026-09','lesson','b1',1,1,0,100,1,100),
        ('2026-09','adjustment','b2',1,1,0,100,-1,-100),
        ('2026-09','adjustment','b2',2,1,0,100,1,100);
    `)

    migrate(db, { migrationsFolder })
    expect(sqlite.pragma('foreign_key_check')).toEqual([])
    expect(sqlite.pragma('integrity_check', { simple: true })).toBe('ok')
    const applied = sqlite.prepare('select count(*) as n from __drizzle_migrations').get()
    expect(applied).toEqual({ n: journal.entries.length })
    expect(sqlite.prepare('select id, lessons_remaining as left from packages').all()).toEqual([
      { id: 1, left: 0 },
    ])
    sqlite.close()
  })
})

describe('0028_data_backstops', () => {
  function migrated() {
    const db = openDb(':memory:')
    migrate(db, { migrationsFolder })
    const sqlite = db.$client
    sqlite.exec(`
      insert into students (id, openid, name) values (1, 'o1', 'A');
      insert into lesson_types (id, name, duration_minutes, price) values (1, '私教', 60, 100);
      insert into coaches (id, name) values (1, 'C');
      insert into package_products (id, name, lesson_type_id, lesson_count, price, validity_days) values (1, 'p', 1, 2, 100, 30);
      insert into orders (id, out_trade_no, student_id, kind, description, amount, provider, status) values
        (1, 't1', 1, 'package', 'p', 100, 'offline', 'paid'), (2, 't2', 1, 'package', 'p', 100, 'offline', 'paid');
      insert into staff (id, name, username, password_hash) values (1, 'S', 's', 'x');
      insert into coach_pay_months (month, rules, total, confirmed_at, staff_id) values ('2026-09', '{}', 0, 0, 1);
    `)
    const pkg = sqlite.prepare(
      "insert into packages (student_id, product_id, name, lesson_type_id, coach_ids, lessons_purchased, lessons_remaining, price_paid, expires_at, status, order_id) values (1, 1, 'p', 1, '[]', 2, ?, 100, 0, 'active', ?)",
    )
    return { sqlite, pkg }
  }

  it('refuses a second package for one order', () => {
    const { sqlite, pkg } = migrated()
    pkg.run(2, 1)
    expect(() => pkg.run(2, 1)).toThrow(/UNIQUE/)
    pkg.run(2, 2)
    expect(sqlite.prepare('select count(*) as n from packages').get()).toEqual({ n: 2 })
  })

  it('refuses a package below zero lessons, and allows grants past what was bought', () => {
    const { sqlite, pkg } = migrated()
    expect(() => pkg.run(-1, 1)).toThrow(/below 0/)
    pkg.run(1, 1)
    const set = sqlite.prepare('update packages set lessons_remaining = lessons_remaining + ?')
    set.run(-1)
    expect(() => set.run(-1)).toThrow(/below 0/)
    set.run(5)
    expect(sqlite.prepare('select lessons_remaining as n from packages').get()).toEqual({ n: 5 })
  })

  it('pays a lesson once per month, and lets adjustments repeat a lesson', () => {
    const { sqlite } = migrated()
    const entry = sqlite.prepare(
      "insert into coach_pay_entries (month, kind, unit, coach_id, lesson_type_id, starts_at, rate, lessons, amount) values ('2026-09', ?, 'b1', 1, 1, 0, 100, ?, ?)",
    )
    entry.run('lesson', 1, 100)
    expect(() => entry.run('lesson', 1, 100)).toThrow(/UNIQUE/)
    entry.run('adjustment', -1, -100)
    entry.run('adjustment', 1, 100)
  })
})
