import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HealthResponse } from '@rs/shared'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Deps } from './deps'
import { ApiError } from './errors'
import { FakeGateway } from './pay/fake'
import { adminRoutes } from './routes/admin'
import { coachRoutes } from './routes/coach'
import { devPayRoutes, payRoutes } from './routes/pay'
import { studentRoutes } from './routes/student'

const imageTypes: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

export function createApp(deps: Deps) {
  const app = new Hono().basePath('/api')

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json({ error: { code: err.code, message: err.message } }, err.status)
    }
    deps.log('unhandled error', { path: c.req.path, error: err.stack ?? err.message })
    return c.json({ error: { code: 'internal', message: '服务出错，请稍后再试' } }, 500)
  })

  app.notFound((c) => c.json({ error: { code: 'not_found', message: '接口不存在' } }, 404))

  app.get('/health', (c) => {
    deps.db.run(sql`select 1`)
    return c.json({ ok: true, time: deps.now().toISOString() } satisfies HealthResponse)
  })

  app.get('/uploads/:name', (c) => {
    const name = c.req.param('name')
    const ext = /^[\w-]+\.(jpg|png|webp)$/.exec(name)?.[1]
    if (!ext) return c.notFound()
    try {
      const data = readFileSync(join(deps.uploadsDir, name))
      return c.body(data, 200, {
        'Content-Type': imageTypes[ext] ?? 'application/octet-stream',
        'Cache-Control': 'public, max-age=31536000, immutable',
      })
    } catch {
      return c.notFound()
    }
  })

  app.route('/', payRoutes(deps))
  if (deps.gateway instanceof FakeGateway) app.route('/', devPayRoutes(deps, deps.gateway))
  app.route('/admin', adminRoutes(deps))
  app.route('/coach', coachRoutes(deps))
  app.route('/', studentRoutes(deps))

  return app
}
