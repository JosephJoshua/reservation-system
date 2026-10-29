import { createHash } from 'node:crypto'
import { and, eq, gt, isNull, lt } from 'drizzle-orm'
import type { MiddlewareHandler } from 'hono'
import { idempotencyKeys, sessions } from './db/schema'
import type { Deps } from './deps'
import { ApiError } from './errors'
import { hashToken } from './services/ids'

const KEEP_MS = 24 * 3_600_000
const WAIT_STEP_MS = 50
// A repeat waits for the first request until 45 seconds after the first began. A call to WeChat
// gives up after at most 15 seconds and a request may make a couple in a row, so a repeat is not
// told 正在处理 while the first can still finish. That matters most for a client that sends again
// on its own after a timeout, as the mini program will once it sends keys (its 15-second timeout).
const MAX_WAITS = 900

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

/**
 * The body as it matters for a repeat. A browser picks a new multipart boundary each time it
 * sends a form, so the boundary is left out: a retried upload of the same file is a repeat.
 */
async function bodyHashOf(req: Request) {
  const bytes = Buffer.from(await req.clone().arrayBuffer())
  const boundary = /boundary="?([^";]+)"?/.exec(req.headers.get('Content-Type') ?? '')?.[1]
  const hash = createHash('sha256')
  if (boundary) {
    const sep = Buffer.from(boundary)
    let at = 0
    for (let i = bytes.indexOf(sep); i !== -1; i = bytes.indexOf(sep, at)) {
      hash.update(bytes.subarray(at, i))
      at = i + sep.length
    }
    hash.update(bytes.subarray(at))
  } else hash.update(bytes)
  return hash.digest('hex')
}

/**
 * The unexpired session of a bearer token, with the student it belongs to, if any. The one place
 * here that knows how sessions store their token.
 */
function liveSession(deps: Deps, token: string, now: Date) {
  return deps.db
    .select({ studentId: sessions.studentId })
    .from(sessions)
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, now)))
    .get()
}

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
    const signedIn = liveSession(deps, auth.replace(/^Bearer /, ''), now)
    // The route's own auth answers this one.
    if (!signedIn) return next()
    const id = sha256([auth, c.req.method, c.req.path, key].join('\n'))
    const bodyHash = await bodyHashOf(c.req.raw)

    for (let wait = 0; ; wait++) {
      const claimed = db
        .insert(idempotencyKeys)
        .values({ id, bodyHash, studentId: signedIn.studentId, createdAt: now })
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
      // A caller that has gone away is not waited for.
      if (c.req.raw.signal.aborted)
        throw new ApiError(409, 'in_progress', '正在处理，请刷新后查看结果')
      await new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS))
    }

    let ok = false
    try {
      await next()
      ok = c.res.status < 300 && !c.error
    } finally {
      // The request's own answer stands whatever happens here. A response that could not be
      // kept leaves the key busy, as for a request cut off by a restart, so a repeat is not run
      // again on top of work already done.
      try {
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
      } catch (e) {
        deps.log('idempotency key not saved', { path: c.req.path, error: String(e) })
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
