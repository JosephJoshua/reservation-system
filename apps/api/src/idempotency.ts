import { createHash } from 'node:crypto'
import { and, eq, lt } from 'drizzle-orm'
import type { MiddlewareHandler } from 'hono'
import { idempotencyKeys } from './db/schema'
import type { Deps } from './deps'
import { ApiError } from './errors'

const KEEP_MS = 24 * 3_600_000
const STALE_MS = 2 * 60_000
const WAIT_STEP_MS = 50
const MAX_WAITS = 200

/**
 * Makes a mutating request safe to repeat when the client sends an Idempotency-Key header: the
 * first request runs, and a repeat with the same key from the same caller to the same endpoint
 * gets the first successful response back instead of running again, waiting for it if the first
 * is still running. Failed requests are not kept, so they can be retried.
 */
export function idempotency(deps: Deps): MiddlewareHandler {
  return async (c, next) => {
    const key = c.req.header('Idempotency-Key')
    if (!key || c.req.method === 'GET') return next()
    if (key.length > 100) throw new ApiError(400, 'invalid_idempotency_key', '请求格式错误')
    const id = createHash('sha256')
      .update([c.req.header('Authorization') ?? '', c.req.method, c.req.path, key].join('\n'))
      .digest('hex')
    const now = deps.now()
    const { db } = deps
    db.delete(idempotencyKeys)
      .where(lt(idempotencyKeys.createdAt, new Date(now.getTime() - KEEP_MS)))
      .run()
    // A repeat that arrives while the first request is still running waits for its answer.
    for (let wait = 0; ; wait++) {
      const claimed = db
        .insert(idempotencyKeys)
        .values({ id, createdAt: now })
        .onConflictDoNothing()
        .run()
      if (claimed.changes === 1) break
      const seen = db.select().from(idempotencyKeys).where(eq(idempotencyKeys.id, id)).get()
      if (!seen) continue // the first request failed meanwhile, so this one runs
      if (seen.status !== null) {
        return new Response(seen.body || null, {
          status: seen.status,
          headers: seen.contentType ? { 'Content-Type': seen.contentType } : {},
        })
      }
      // Still marked running long after any request could take: a restart cut it off, so this
      // one runs in its place (only one repeat can take it over).
      if (now.getTime() - seen.createdAt.getTime() >= STALE_MS) {
        const taken = db
          .update(idempotencyKeys)
          .set({ createdAt: now })
          .where(and(eq(idempotencyKeys.id, id), eq(idempotencyKeys.createdAt, seen.createdAt)))
          .run()
        if (taken.changes === 1) break
        continue
      }
      if (wait >= MAX_WAITS) throw new ApiError(409, 'in_progress', '正在处理，请稍候')
      await new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS))
    }
    return run()

    async function run() {
      let ok = false
      try {
        await next()
        ok = c.res.status < 300 && !c.error
      } finally {
        if (ok) {
          const body = await c.res.clone().text()
          db.update(idempotencyKeys)
            .set({ status: c.res.status, body, contentType: c.res.headers.get('Content-Type') })
            .where(eq(idempotencyKeys.id, id))
            .run()
        } else {
          db.delete(idempotencyKeys).where(eq(idempotencyKeys.id, id)).run()
        }
      }
    }
  }
}
