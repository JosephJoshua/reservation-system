import { timingSafeEqual } from 'node:crypto'
import { and, eq, gt, lt } from 'drizzle-orm'
import type { MiddlewareHandler } from 'hono'
import { coaches, sessions, students } from '../db/schema'
import type { Deps } from '../deps'
import { ApiError } from '../errors'
import { newToken } from './ids'

const STUDENT_SESSION_MS = 30 * 86_400_000
const ADMIN_SESSION_MS = 12 * 3_600_000
const COACH_SESSION_MS = 30 * 86_400_000

export type AuthVars = { Variables: { studentId: number } }
export type CoachVars = { Variables: { coachId: number } }

export async function loginStudent(deps: Deps, code: string) {
  const openid = await deps.wxLogin(code)
  const now = deps.now()
  const student =
    deps.db.select().from(students).where(eq(students.openid, openid)).get() ??
    deps.db.insert(students).values({ openid }).onConflictDoNothing().returning().get() ??
    deps.db.select().from(students).where(eq(students.openid, openid)).get()
  if (!student) throw new Error('student upsert failed')
  const token = newToken()
  deps.db
    .insert(sessions)
    .values({
      token,
      role: 'student',
      studentId: student.id,
      expiresAt: new Date(now.getTime() + STUDENT_SESSION_MS),
    })
    .run()
  deps.db.delete(sessions).where(lt(sessions.expiresAt, now)).run()
  return { token, student }
}

// Failed admin logins per client, so the password cannot be guessed at speed.
const LOGIN_WINDOW_MS = 15 * 60_000
const MAX_FAILED_LOGINS = 10
// Kept per app instance, so separate test apps never share counts.
const failedLoginsByApp = new WeakMap<Deps, Map<string, { count: number; since: number }>>()

/** `client` identifies the caller, such as the address the reverse proxy saw. */
export function loginAdmin(deps: Deps, password: string, client: string) {
  const now = deps.now().getTime()
  let failedLogins = failedLoginsByApp.get(deps)
  if (!failedLogins) {
    failedLogins = new Map()
    failedLoginsByApp.set(deps, failedLogins)
  }
  for (const [key, entry] of failedLogins) {
    if (now - entry.since > LOGIN_WINDOW_MS) failedLogins.delete(key)
  }
  const failed = failedLogins.get(client)
  if (failed && failed.count >= MAX_FAILED_LOGINS) {
    throw new ApiError(429, 'too_many_attempts', '尝试次数过多，请 15 分钟后再试')
  }
  const a = Buffer.from(password)
  const b = Buffer.from(deps.adminPassword)
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    failedLogins.set(client, { count: (failed?.count ?? 0) + 1, since: failed?.since ?? now })
    throw new ApiError(401, 'bad_password', '密码错误')
  }
  failedLogins.delete(client)
  const token = newToken()
  deps.db
    .insert(sessions)
    .values({ token, role: 'admin', expiresAt: new Date(deps.now().getTime() + ADMIN_SESSION_MS) })
    .run()
  return { token }
}

/** Starts a session for a coach bound to the WeChat user who just logged in. */
export function startCoachSession(deps: Deps, coachId: number) {
  const token = newToken()
  deps.db
    .insert(sessions)
    .values({
      token,
      role: 'coach',
      coachId,
      expiresAt: new Date(deps.now().getTime() + COACH_SESSION_MS),
    })
    .run()
  return token
}

function bearer(header: string | undefined) {
  return header?.startsWith('Bearer ') ? header.slice(7) : undefined
}

function session(deps: Deps, token: string | undefined, role: 'student' | 'admin' | 'coach') {
  if (!token) return undefined
  return deps.db
    .select()
    .from(sessions)
    .where(
      and(eq(sessions.token, token), eq(sessions.role, role), gt(sessions.expiresAt, deps.now())),
    )
    .get()
}

export function requireStudent(deps: Deps): MiddlewareHandler<AuthVars> {
  return async (c, next) => {
    const s = session(deps, bearer(c.req.header('Authorization')), 'student')
    if (!s?.studentId) throw new ApiError(401, 'unauthorized', '请重新登录')
    c.set('studentId', s.studentId)
    await next()
  }
}

export function requireAdmin(deps: Deps): MiddlewareHandler {
  return async (c, next) => {
    if (!session(deps, bearer(c.req.header('Authorization')), 'admin')) {
      throw new ApiError(401, 'unauthorized', '请重新登录')
    }
    await next()
  }
}

export function requireCoach(deps: Deps): MiddlewareHandler<CoachVars> {
  return async (c, next) => {
    const s = session(deps, bearer(c.req.header('Authorization')), 'coach')
    // A coach who was unbound or deactivated loses access at once.
    const coach = s?.coachId
      ? deps.db.select().from(coaches).where(eq(coaches.id, s.coachId)).get()
      : undefined
    if (!coach?.openid || !coach.active) throw new ApiError(401, 'unauthorized', '请重新登录')
    c.set('coachId', coach.id)
    await next()
  }
}

export function logout(deps: Deps, header: string | undefined) {
  const token = bearer(header)
  if (token) deps.db.delete(sessions).where(eq(sessions.token, token)).run()
}
