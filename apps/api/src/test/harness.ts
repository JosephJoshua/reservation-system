import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultSettings, type VenueSettings, venueInstant } from '@rs/shared'
import { createApp } from '../app'
import { openDb } from '../db/client'
import { runMigrations } from '../db/migrate'
import { coaches, coachLessonTypes, lessonTypes, slots } from '../db/schema'
import type { Deps } from '../deps'
import { FakeGateway } from '../pay/fake'
import { saveSettings } from '../services/settings'
import { devLogin } from '../wx'

export const ADMIN_PASSWORD = 'test-password'

/** A fresh API on an in-memory database, with a fake gateway and a clock tests can move. */
export function setup(options: { dbPath?: string; now?: string } = {}) {
  const db = openDb(options.dbPath ?? ':memory:')
  runMigrations(db)
  const gateway = new FakeGateway()
  const clock = { now: new Date(options.now ?? '2026-10-23T02:00:00Z') }
  const logs: { message: string; detail: unknown }[] = []
  const deps: Deps = {
    db,
    gateway,
    now: () => new Date(clock.now),
    wxLogin: devLogin,
    adminPassword: ADMIN_PASSWORD,
    uploadsDir: mkdtempSync(join(tmpdir(), 'rs-uploads-')),
    log: (message, detail) => logs.push({ message, detail }),
  }
  const app = createApp(deps)

  async function call(
    method: string,
    path: string,
    body?: unknown,
    token?: string,
    headers: Record<string, string> = {},
  ) {
    const res = await app.request(`/api${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    // biome-ignore lint/suspicious/noExplicitAny: test helper returns loosely typed JSON
    const json: any = text ? JSON.parse(text) : null
    return { status: res.status, json }
  }

  async function student(name: string) {
    const res = await call('POST', '/auth/student', { code: `dev:${name}` })
    return res.json.token as string
  }

  async function admin() {
    const res = await call('POST', '/admin/login', { password: ADMIN_PASSWORD })
    return res.json.token as string
  }

  function settings(patch: (s: VenueSettings) => void) {
    const s = structuredClone(defaultSettings)
    patch(s)
    saveSettings(db, s, deps.now())
  }

  /** One coach teaching a 60-minute lesson at ¥200 and a ¥50 trial. */
  function seed() {
    const coach = db.insert(coaches).values({ name: '王教练' }).returning().get()
    const lesson = db
      .insert(lessonTypes)
      .values({ name: '一对一私教', durationMinutes: 60, price: 20000 })
      .returning()
      .get()
    const trial = db
      .insert(lessonTypes)
      .values({ name: '体验课', durationMinutes: 60, price: 5000, isTrial: true })
      .returning()
      .get()
    db.insert(coachLessonTypes)
      .values({ coachId: coach.id, lessonTypeId: lesson.id, price: null })
      .run()
    db.insert(coachLessonTypes)
      .values({ coachId: coach.id, lessonTypeId: trial.id, price: null })
      .run()
    return { coach, lesson, trial }
  }

  /** A 60-minute slot on a venue date at a venue hour. */
  function slot(coachId: number, date = '2026-10-25', hour = 10) {
    return db
      .insert(slots)
      .values({
        coachId,
        startsAt: venueInstant(date, hour * 60),
        endsAt: venueInstant(date, hour * 60 + 60),
      })
      .returning()
      .get()
  }

  return { db, deps, gateway, clock, logs, app, call, student, admin, settings, seed, slot }
}

export type Harness = ReturnType<typeof setup>
