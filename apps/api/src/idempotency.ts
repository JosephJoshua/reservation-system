import { createHash } from 'node:crypto'
import { and, eq, gt, isNull, lt } from 'drizzle-orm'
import type { MiddlewareHandler } from 'hono'
import { idempotencyKeys, sessions } from './db/schema'
import type { Deps } from './deps'
import { ApiError } from './errors'

const KEEP_MS = 24 * 3_600_000
const WAIT_STEP_MS = 50
const MAX_WAITS = 200

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

/**
 * Makes a signed-in caller's mutating request safe to repeat when it carries an Idempotency-Key:
 * the first request runs, and a repeat with the same key and body to the same endpoint gets the
 * first successful response back instead of running again, waiting for it if the first is still
 * running. Failed requests are not kept, so they can be retried.
 *
 * A first request that never finished (the process restarted mid-request) keeps its key busy
 * rather than being run again, since its work may already be committed. The caller reloads and
 * submits afresh with a new key.
 */
export function idempotency(deps: Deps): MiddlewareHandler {
  return async (c, next) => {
    const key = c.req.header('Idempotency-Key')
    const auth = c.req.header('Authorization')
    // Only signed-in callers: a cached response must never reach anyone but its owner.
    if (!key || !auth || c.req.method === 'GET') return next()
    if (key.length > 100) throw new ApiError(400, 'invalid_idempotency_key', '请求格式错误')
    const { db } = deps
    const now = deps.now()
    const signedIn = db
      .select({ token: sessions.token })
      .from(sessions)
      .where(and(eq(sessions.token, auth.replace(/^Bearer /, '')), gt(sessions.expiresAt, now)))
      .get()
    // The route's own auth answers this one.
    if (!signedIn) return next()
    const id = sha256([auth, c.req.method, c.req.path, key].join('\n'))
    const bodyHash = sha256(await c.req.raw.clone().text())

    for (let wait = 0; ; wait++) {
      const claimed = db
        .insert(idempotencyKeys)
        .values({ id, bodyHash, createdAt: now })
        .onConflictDoNothing()
        .run()
      if (claimed.changes === 1) break
      const seen = db.select().from(idempotencyKeys).where(eq(idempotencyKeys.id, id)).get()
      if (!seen) continue // the first request failed meanwhile, so this one runs
      if (seen.bodyHash !== bodyHash) {
        throw new ApiError(409, 'idempotency_key_reused', '内容已变更，请刷新后重新提交')
      }
      if (seen.status !== null) {
        return new Response(seen.body || null, {
          status: seen.status,
          headers: seen.contentType ? { 'Content-Type': seen.contentType } : {},
        })
      }
      // A first request that never finished (cut off by a restart) is not waited on at all.
      const age = deps.now().getTime() - seen.createdAt.getTime()
      if (wait >= MAX_WAITS || age > MAX_WAITS * WAIT_STEP_MS) {
        throw new ApiError(409, 'in_progress', '正在处理，请刷新后查看结果')
      }
      await new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS))
    }

    let ok = false
    try {
      await next()
      ok = c.res.status < 300 && !c.error
    } finally {
      if (ok) {
        const body = await c.res.clone().text()
        db.update(idempotencyKeys)
          .set({ status: c.res.status, body, contentType: c.res.headers.get('Content-Type') })
          .where(and(eq(idempotencyKeys.id, id), isNull(idempotencyKeys.status)))
          .run()
      } else {
        db.delete(idempotencyKeys)
          .where(and(eq(idempotencyKeys.id, id), isNull(idempotencyKeys.status)))
          .run()
      }
    }
  }
}

/** Forgets keys older than a day. Run by the sweeper. */
export function expireIdempotencyKeys(deps: Deps) {
  deps.db
    .delete(idempotencyKeys)
    .where(lt(idempotencyKeys.createdAt, new Date(deps.now().getTime() - KEEP_MS)))
    .run()
}
