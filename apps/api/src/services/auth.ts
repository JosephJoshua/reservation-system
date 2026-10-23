import { timingSafeEqual } from 'node:crypto'
import { and, eq, gt, lt } from 'drizzle-orm'
import type { MiddlewareHandler } from 'hono'
import { sessions, students } from '../db/schema'
import type { Deps } from '../deps'
import { ApiError } from '../errors'
import { newToken } from './ids'

const STUDENT_SESSION_MS = 30 * 86_400_000
const ADMIN_SESSION_MS = 12 * 3_600_000

export type AuthVars = { Variables: { studentId: number } }

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

export function loginAdmin(deps: Deps, password: string) {
  const a = Buffer.from(password)
  const b = Buffer.from(deps.adminPassword)
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new ApiError(401, 'bad_password', '密码错误')
  }
  const token = newToken()
  deps.db
    .insert(sessions)
    .values({ token, role: 'admin', expiresAt: new Date(deps.now().getTime() + ADMIN_SESSION_MS) })
    .run()
  return { token }
}

function bearer(header: string | undefined) {
  return header?.startsWith('Bearer ') ? header.slice(7) : undefined
}

function session(deps: Deps, token: string | undefined, role: 'student' | 'admin') {
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

export function logout(deps: Deps, header: string | undefined) {
  const token = bearer(header)
  if (token) deps.db.delete(sessions).where(eq(sessions.token, token)).run()
}
