import { createHash } from 'node:crypto'
import { and, eq, gt, gte, isNull, lt } from 'drizzle-orm'
import type { Context, MiddlewareHandler } from 'hono'
import { coaches, idempotencyKeys, sessions, staff, students } from './db/schema'
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
 * Who a bearer token's unexpired session acts for, as `staff:3`, `coach:2` or `student:7`, with
 * the student, if any. Keys are kept per person, not per token, so a request sent again after
 * logging in again is still a repeat. Null when the session's owner can no longer act (a
 * deactivated login or coach, a deleted student): nothing is replayed to them. The one place
 * here that knows how sessions store their token.
 */
function liveSession(deps: Deps, token: string, now: Date) {
  const s = deps.db
    .select({
      role: sessions.role,
      studentId: sessions.studentId,
      staffId: sessions.staffId,
      coachId: sessions.coachId,
      staffActive: staff.active,
      coachActive: coaches.active,
      coachOpenid: coaches.openid,
      studentDeletedAt: students.deletedAt,
      studentFound: students.id,
    })
    .from(sessions)
    .leftJoin(staff, eq(staff.id, sessions.staffId))
    .leftJoin(coaches, eq(coaches.id, sessions.coachId))
    .leftJoin(students, eq(students.id, sessions.studentId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, now)))
    .get()
  if (!s) return null
  if (s.role === 'admin' && s.staffId !== null && s.staffActive) {
    return { principal: `staff:${s.staffId}`, studentId: null }
  }
  if (s.role === 'coach' && s.coachId !== null && s.coachActive && s.coachOpenid) {
    return { principal: `coach:${s.coachId}`, studentId: null }
  }
  if (
    s.role === 'student' &&
    s.studentId !== null &&
    s.studentFound !== null &&
    !s.studentDeletedAt
  ) {
    return { principal: `student:${s.studentId}`, studentId: s.studentId }
  }
  return null
}

// Logins, coach binding and password changes: their answers hold a new session token, which is
// otherwise kept only as a hash, and their bodies a password. Repeating one is harmless anyway.
const CREDENTIAL_PATHS =
  /^\/api\/(?:admin\/login|auth\/student|coach\/login|coach\/bind|admin\/me\/password|admin\/staff\/[^/]+\/password)\/?$/

/**
 * The key a request is kept under, for a signed-in caller's mutating request that carries an
 * Idempotency-Key; null when it is not kept.
 */
function keyOf(deps: Deps, c: Context, now: Date) {
  const key = c.req.header('Idempotency-Key')
  const auth = c.req.header('Authorization')
  // Only signed-in callers: a cached response must never reach anyone but its owner.
  if (!key || !auth || c.req.method === 'GET' || CREDENTIAL_PATHS.test(c.req.path)) return null
  if (key.length > 100) throw new ApiError(400, 'invalid_idempotency_key', '请求格式错误')
  const signedIn = liveSession(deps, auth.replace(/^Bearer /, ''), now)
  // The route's own auth answers this one.
  if (!signedIn) return null
  return {
    id: sha256([signedIn.principal, c.req.method, c.req.path, key].join('\n')),
    studentId: signedIn.studentId,
  }
}

/**
 * Whether a request is a repeat of one already kept, finished or still running. Checks a route
 * makes before the body is read are skipped for a repeat, which gets the first answer instead.
 */
export function isKeptRepeat(deps: Deps, c: Context) {
  const kept = keyOf(deps, c, deps.now())
  return Boolean(
    kept &&
      deps.db
        .select({ id: idempotencyKeys.id })
        .from(idempotencyKeys)
        .where(eq(idempotencyKeys.id, kept.id))
        .get(),
  )
}

/** Whether a student's account was erased at or after a time. */
function erasedSince(deps: Deps, since: Date) {
  return Boolean(
    deps.db.select({ id: students.id }).from(students).where(gte(students.deletedAt, since)).get(),
  )
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
    const { db } = deps
    const now = deps.now()
    const kept = keyOf(deps, c, now)
    if (!kept) return next()
    const { id, studentId } = kept
    const bodyHash = await bodyHashOf(c.req.raw)

    for (let wait = 0; ; wait++) {
      const claimed = db
        .insert(idempotencyKeys)
        .values({ id, bodyHash, studentId, createdAt: now })
        .onConflictDoNothing()
        .run()
      if (claimed.changes === 1) break
      const seen = db.select().from(idempotencyKeys).where(eq(idempotencyKeys.id, id)).get()
      if (!seen) continue // the first request failed meanwhile, so this one runs
      if (seen.bodyHash !== bodyHash) {
        throw new ApiError(409, 'idempotency_key_reused', '内容已变更，请刷新后重新提交')
      }
      if (seen.status !== null) {
        // Its answer was dropped when a student in it deleted their account (see eraseStudent).
        if (seen.body === null && seen.status !== 204) {
          throw new ApiError(409, 'in_progress', '已处理，请刷新后查看结果')
        }
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
          // A staff member's or coach's answer may show a student whose account was erased
          // while this ran, after eraseStudent dropped the answers kept so far.
          const drop = studentId === null && erasedSince(deps, now)
          const body = drop ? null : await c.res.clone().text()
          db.update(idempotencyKeys)
            .set({
              status: c.res.status,
              body,
              contentType: drop ? null : c.res.headers.get('Content-Type'),
            })
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
