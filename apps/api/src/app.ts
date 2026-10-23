import type { HealthResponse } from '@rs/shared'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Db } from './db/client'

export function createApp(db: Db) {
  const app = new Hono().basePath('/api')

  app.get('/health', (c) => {
    db.run(sql`select 1`)
    return c.json({ ok: true, time: new Date().toISOString() } satisfies HealthResponse)
  })

  return app
}
