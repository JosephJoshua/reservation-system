import { execFile } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { bookings, coaches, coachLessonTypes } from './db/schema'
import { setup } from './test/harness'

const run = promisify(execFile)
const tsx = createRequire(import.meta.url).resolve('tsx/cli')

describe('booking one slot from several processes', () => {
  it('gives the slot to exactly one process', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'rs-race-')), 'race.db')
    const h = setup({ dbPath })
    const { coach, lesson } = h.seed()
    const slot = h.slot(coach.id)
    const n = 6
    for (let i = 0; i < n; i++) await h.student(`p${i}`)
    const startAt = Date.now() + 2500
    const outputs = await Promise.all(
      Array.from({ length: n }, (_, i) =>
        run(process.execPath, [
          tsx,
          join(import.meta.dirname, 'test/race-worker.ts'),
          dbPath,
          String(slot.id),
          String(lesson.id),
          String(i + 1),
          String(startAt),
          h.deps.now().toISOString(),
        ]),
      ),
    )
    const results = outputs.map((o) => JSON.parse(o.stdout.trim()))
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.filter((r) => !r.ok).map((r) => r.code)).toEqual(Array(n - 1).fill('slot_taken'))
    expect(h.db.select().from(bookings).all()).toHaveLength(1)
  }, 30_000)
})

describe('booking the last table from several processes', () => {
  it('gives the table to exactly one process', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'rs-race-')), 'race.db')
    const h = setup({ dbPath })
    const { coach, lesson } = h.seed()
    h.settings((s) => {
      s.booking.tables = 1
    })
    const n = 6
    const slotIds = [h.slot(coach.id).id]
    for (let i = 1; i < n; i++) {
      const other = h.db
        .insert(coaches)
        .values({ name: `教练${i}` })
        .returning()
        .get()
      h.db.insert(coachLessonTypes).values({ coachId: other.id, lessonTypeId: lesson.id }).run()
      slotIds.push(h.slot(other.id).id)
    }
    for (let i = 0; i < n; i++) await h.student(`p${i}`)
    const startAt = Date.now() + 2500
    const outputs = await Promise.all(
      slotIds.map((slotId, i) =>
        run(process.execPath, [
          tsx,
          join(import.meta.dirname, 'test/race-worker.ts'),
          dbPath,
          String(slotId),
          String(lesson.id),
          String(i + 1),
          String(startAt),
          h.deps.now().toISOString(),
        ]),
      ),
    )
    const results = outputs.map((o) => JSON.parse(o.stdout.trim()))
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.filter((r) => !r.ok).map((r) => r.code)).toEqual(
      Array(n - 1).fill('tables_full'),
    )
    expect(h.db.select().from(bookings).all()).toHaveLength(1)
  }, 30_000)
})
