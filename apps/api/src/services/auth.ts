import { can, type StaffPermission, type StaffRole } from '@rs/shared'
import { and, eq, gt, lt } from 'drizzle-orm'
import type { MiddlewareHandler } from 'hono'
import { coaches, sessions, staff, students } from '../db/schema'
import type { Deps } from '../deps'
import { ApiError } from '../errors'
import { hashToken, newToken } from './ids'
import { verifyPassword } from './staff'

const STUDENT_SESSION_MS = 30 * 86_400_000
const ADMIN_SESSION_MS = 12 * 3_600_000
const COACH_SESSION_MS = 30 * 86_400_000

export type AuthVars = { Variables: { studentId: number } }
export type CoachVars = { Variables: { coachId: number } }
export type AdminVars = { Variables: { staffId: number; roles: StaffRole[] } }

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
      tokenHash: hashToken(token),
      role: 'student',
      studentId: student.id,
      expiresAt: new Date(now.getTime() + STUDENT_SESSION_MS),
    })
    .run()
  deps.db.delete(sessions).where(lt(sessions.expiresAt, now)).run()
  return { token, student }
}

// Failed password checks per key, so passwords and codes cannot be guessed at speed.
const LOGIN_WINDOW_MS = 15 * 60_000
const MAX_FAILED_LOGINS = 10
// Kept per app instance, so separate test apps never share counts.
const failedLoginsByApp = new WeakMap<Deps, Map<string, { count: number; since: number }>>()

/** The failed checks still counting for this app, with the lock on `key` checked. */
function attemptsFor(deps: Deps, key: string) {
  const now = deps.now().getTime()
  let failedLogins = failedLoginsByApp.get(deps)
  if (!failedLogins) {
    failedLogins = new Map()
    failedLoginsByApp.set(deps, failedLogins)
  }
  for (const [k, entry] of failedLogins) {
    if (now - entry.since > LOGIN_WINDOW_MS) failedLogins.delete(k)
  }
  const failed = failedLogins.get(key)
  if (failed && failed.count >= MAX_FAILED_LOGINS) {
    throw new ApiError(429, 'too_many_attempts', '尝试次数过多，请 15 分钟后再试')
  }
  const miss = () =>
    failedLogins.set(key, { count: (failed?.count ?? 0) + 1, since: failed?.since ?? now })
  return { miss, clear: () => failedLogins.delete(key) }
}

/**
 * Runs a password check under the failed-attempt limit for `key`. `check` returns whether the
 * password was right; a wrong one counts against the key and throws `wrong`.
 */
export function limitedCheck(deps: Deps, key: string, check: () => boolean, wrong: ApiError) {
  const { miss, clear } = attemptsFor(deps, key)
  if (!check()) {
    miss()
    throw wrong
  }
  clear()
}

/** `limitedCheck` for a check that takes a while, such as hashing a password. */
export async function limitedCheckAsync(
  deps: Deps,
  key: string,
  check: () => Promise<boolean>,
  wrong: ApiError,
) {
  const { miss, clear } = attemptsFor(deps, key)
  // Counted before the check, so requests sent at once cannot all get past the limit meanwhile.
  miss()
  if (!(await check())) throw wrong
  clear()
}

// Staff logins are limited per login name and per address.
//
// A login name backs off after a run of wrong passwords from anywhere, so one login cannot keep
// guessing at another between its own good logins. The wait starts short, so someone typing
// wrong passwords on purpose keeps the real person out for a minute at first, and grows to 15
// minutes; the count is kept for a day after the last miss, so waiting out one wait does not
// start the count afresh.
//
// A name that signed in from an address before counts its misses there on their own, so the
// real person still gets in at the venue while someone elsewhere guesses at the name, and junk
// names typed on the venue Wi-Fi do not shut them out either.
//
// Each address also has a looser limit for all names together, so one address cannot try many
// names; a good login does not reset it.
const NAME_FREE_FAILURES = 10
const NAME_MAX_WAIT_MS = 15 * 60_000
const NAME_KEEP_MS = 24 * 3_600_000
const ADDRESS_MAX_FAILURES = 50
const KNOWN_ADDRESS_MS = 30 * 86_400_000

type LoginLimits = {
  /** Wrong passwords per key, forgotten `keep` ms after the last one. */
  failures: Map<string, { count: number; last: number; keep: number }>
  /** When each login name last signed in from each address. */
  known: Map<string, number>
}
const loginLimitsByApp = new WeakMap<Deps, LoginLimits>()

const tooMany = (waitMs: number) =>
  new ApiError(
    429,
    'too_many_attempts',
    `尝试次数过多，请 ${Math.max(1, Math.ceil(waitMs / 60_000))} 分钟后再试`,
  )

/**
 * How long a login name waits after `count` wrong passwords: nothing for the first ten, then a
 * minute, doubling with each further one up to 15 minutes.
 */
export function loginNameWaitMs(count: number) {
  if (count < NAME_FREE_FAILURES) return 0
  return Math.min(60_000 * 2 ** (count - NAME_FREE_FAILURES), NAME_MAX_WAIT_MS)
}

/**
 * A session of a deactivated staff login. Login itself answers a deactivated login like a wrong
 * password, so it never tells anyone that a password was right.
 */
function accountDisabled() {
  return new ApiError(401, 'account_disabled', '账号已停用，请联系管理员')
}

/** `client` identifies the caller, such as the address the reverse proxy saw. */
export async function loginAdmin(deps: Deps, username: string, password: string, client: string) {
  const now = deps.now().getTime()
  let limits = loginLimitsByApp.get(deps)
  if (!limits) {
    limits = { failures: new Map(), known: new Map() }
    loginLimitsByApp.set(deps, limits)
  }
  const { failures, known } = limits
  for (const [k, entry] of failures) {
    if (now - entry.last > entry.keep) failures.delete(k)
  }
  for (const [k, at] of known) {
    if (now - at > KNOWN_ADDRESS_MS) known.delete(k)
  }
  const pair = JSON.stringify([username, client])
  const knownPair = known.has(pair)
  const addressKey = `address:${client}`
  const nameKey = knownPair ? `pair:${pair}` : `name:${username}`

  // Checked before the password, so a locked name costs no hashing and reveals nothing.
  const address = failures.get(addressKey)
  if (!knownPair && address && address.count >= ADDRESS_MAX_FAILURES) {
    throw tooMany(address.last + LOGIN_WINDOW_MS - now)
  }
  const name = failures.get(nameKey)
  const wait = name ? name.last + loginNameWaitMs(name.count) - now : 0
  if (wait > 0) throw tooMany(wait)

  // Counted as a miss before the password is checked, so requests sent at once cannot all get
  // past the limit while their passwords are hashed; a right password takes the miss back.
  const counted: [string, number][] = [
    [addressKey, LOGIN_WINDOW_MS],
    [nameKey, NAME_KEEP_MS],
    // Misses on a known address also count for the name everywhere, but never stop it there.
    [`name:${username}`, NAME_KEEP_MS],
  ]
  for (const [key, keep] of new Map(counted)) {
    failures.set(key, { count: (failures.get(key)?.count ?? 0) + 1, last: now, keep })
  }
  const member = deps.db.select().from(staff).where(eq(staff.username, username)).get()
  // The hash is checked even for an unknown name, so timing does not reveal which names exist.
  const right = (await verifyPassword(password, member?.passwordHash)) && member?.active === true
  if (!right || !member) throw new ApiError(401, 'bad_password', '登录名或密码错误')

  const undo = (key: string) => {
    const entry = failures.get(key)
    if (entry && entry.count > 1) entry.count--
    else failures.delete(key)
  }
  undo(addressKey)
  // Only the count this login was checked against starts afresh. On a known address that is the
  // address's own count, so the real person signing in at the venue does not reset the count of
  // someone guessing elsewhere; their own miss here is taken back from the name's count. On any
  // other address the name's count was below its limit or its wait was over, so starting it
  // afresh gives someone guessing at most ten more tries each time the real person signs in from
  // a new address.
  failures.delete(nameKey)
  if (knownPair) undo(`name:${username}`)
  known.set(pair, now)
  const token = newToken()
  deps.db
    .insert(sessions)
    .values({
      tokenHash: hashToken(token),
      role: 'admin',
      staffId: member.id,
      expiresAt: new Date(now + ADMIN_SESSION_MS),
    })
    .run()
  return { token, staff: { id: member.id, name: member.name, username: member.username } }
}

/** Starts a session for a coach bound to the WeChat user who just logged in. */
export function startCoachSession(deps: Deps, coachId: number) {
  const token = newToken()
  deps.db
    .insert(sessions)
    .values({
      tokenHash: hashToken(token),
      role: 'coach',
      coachId,
      expiresAt: new Date(deps.now().getTime() + COACH_SESSION_MS),
    })
    .run()
  return token
}

export function bearer(header: string | undefined) {
  return header?.startsWith('Bearer ') ? header.slice(7) : undefined
}

function session(deps: Deps, token: string | undefined, role: 'student' | 'admin' | 'coach') {
  if (!token) return undefined
  return deps.db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.tokenHash, hashToken(token)),
        eq(sessions.role, role),
        gt(sessions.expiresAt, deps.now()),
      ),
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

export function requireAdmin(deps: Deps): MiddlewareHandler<AdminVars> {
  return async (c, next) => {
    const s = session(deps, bearer(c.req.header('Authorization')), 'admin')
    // A deactivated login loses access at once.
    const member = s?.staffId
      ? deps.db.select().from(staff).where(eq(staff.id, s.staffId)).get()
      : undefined
    if (!member) throw new ApiError(401, 'unauthorized', '请重新登录')
    // Said as such, so the admin app doesn't just ask for the password again.
    if (!member.active) throw accountDisabled()
    c.set('staffId', member.id)
    // Read on every request, so a role change applies at once.
    c.set('roles', member.roles)
    await next()
  }
}

/** Marks `need` middleware, so a test can check that every admin route has one. */
export const PERMISSION_CHECK = Symbol('permission check')

/** Turns away a signed-in staff member whose roles lack `permission`. */
export function need(permission: StaffPermission) {
  const check: MiddlewareHandler<AdminVars> = async (c, next) => {
    if (!can(c.get('roles'), permission)) {
      throw new ApiError(403, 'forbidden', '没有权限，请联系管理员')
    }
    await next()
  }
  return Object.assign(check, { [PERMISSION_CHECK]: permission })
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
  if (token)
    deps.db
      .delete(sessions)
      .where(eq(sessions.tokenHash, hashToken(token)))
      .run()
}
