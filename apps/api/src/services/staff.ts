import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import type { StaffRole } from '@rs/shared'
import { and, eq, ne } from 'drizzle-orm'
import type { Db } from '../db/client'
import { immediate } from '../db/client'
import { sessions, staff } from '../db/schema'
import type { Deps } from '../deps'
import { ApiError, isUniqueViolation, notFound } from '../errors'
import { hashToken } from './ids'

const KEY_LENGTH = 32

/** `scrypt$<salt>$<hash>`, both hex. Node's default scrypt cost is fine for a handful of staff. */
export function hashPassword(password: string) {
  const salt = randomBytes(16)
  return `scrypt$${salt.toString('hex')}$${scryptSync(password, salt, KEY_LENGTH).toString('hex')}`
}

// Checked against when the username is unknown, so a miss takes as long as a wrong password.
const DUMMY_HASH = hashPassword(randomBytes(16).toString('hex'))

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>

/**
 * Hashed off the main thread, since anyone can make the server check a password: many logins at
 * once must not hold up every other request.
 */
export async function verifyPassword(password: string, stored: string | undefined) {
  const [scheme, salt, hash] = (stored ?? DUMMY_HASH).split('$')
  if (scheme !== 'scrypt' || !salt || !hash) return false
  const expected = Buffer.from(hash, 'hex')
  const actual = await scryptAsync(password, Buffer.from(salt, 'hex'), expected.length)
  return timingSafeEqual(actual, expected) && stored !== undefined
}

export const FIRST_USERNAME = 'admin'

/**
 * Creates the first login, `admin`, from ADMIN_PASSWORD when there is no staff yet. After that
 * staff are managed in the admin app and the variable is not read again.
 */
export function ensureFirstStaff(db: Db, password: string | undefined) {
  if (db.select({ id: staff.id }).from(staff).get()) return
  if (!password) throw new Error('ADMIN_PASSWORD is required to create the first staff login')
  db.insert(staff)
    .values({ name: '管理员', username: FIRST_USERNAME, passwordHash: hashPassword(password) })
    .onConflictDoNothing()
    .run()
}

export type StaffRow = typeof staff.$inferSelect

export function staffView(row: StaffRow) {
  return {
    id: row.id,
    name: row.name,
    username: row.username,
    roles: row.roles,
    active: row.active,
    createdAt: row.createdAt,
  }
}

export function findStaff(db: Db, id: number) {
  const row = db.select().from(staff).where(eq(staff.id, id)).get()
  if (!row) throw notFound('员工')
  return row
}

export function createStaff(
  deps: Deps,
  input: { name: string; username: string; password: string; roles: StaffRole[] },
) {
  try {
    return deps.db
      .insert(staff)
      .values({
        name: input.name,
        username: input.username,
        passwordHash: hashPassword(input.password),
        roles: input.roles,
      })
      .returning()
      .get()
  } catch (e) {
    if (isUniqueViolation(e)) throw new ApiError(409, 'username_taken', '该登录名已被使用')
    throw e
  }
}

/**
 * Renames, (de)activates or changes the roles of a login. Deactivating logs it out everywhere at
 * once (its sessions are refused, and end on enabling it again); new roles apply on its next
 * request.
 */
export function updateStaff(
  deps: Deps,
  actorId: number,
  id: number,
  patch: { name?: string; active?: boolean; roles?: StaffRole[] },
) {
  if (patch.active === false && id === actorId) {
    throw new ApiError(409, 'cannot_deactivate_self', '不能停用自己的账号')
  }
  if (patch.roles && id === actorId) {
    throw new ApiError(409, 'own_roles', '不能修改自己的角色，请让其他管理员修改')
  }
  return immediate(deps.db, (tx) => {
    const before = tx.select().from(staff).where(eq(staff.id, id)).get()
    if (!before) throw notFound('员工')
    const after = tx.update(staff).set(patch).where(eq(staff.id, id)).returning().get()
    if (!after) throw notFound('员工')
    // Checked after the write, so two admins demoting or deactivating each other at once cannot
    // leave nobody able to manage staff.
    const admins = tx
      .select({ roles: staff.roles })
      .from(staff)
      .where(eq(staff.active, true))
      .all()
      .filter((r) => r.roles.includes('admin'))
    if (admins.length === 0) {
      throw new ApiError(409, 'last_admin', '至少要保留一个启用的管理员')
    }
    // Deactivated, the sessions stay so the app can tell them why they are refused; they never work
    // again, as they end when the login is enabled again.
    if (!before.active && after.active) tx.delete(sessions).where(eq(sessions.staffId, id)).run()
    return { before, after }
  })
}

/** Sets a new password and ends the login's other sessions, keeping `keepToken` if given. */
export function setStaffPassword(deps: Deps, id: number, password: string, keepToken?: string) {
  immediate(deps.db, (tx) => {
    const changed = tx
      .update(staff)
      .set({ passwordHash: hashPassword(password) })
      .where(eq(staff.id, id))
      .run()
    if (changed.changes === 0) throw notFound('员工')
    tx.delete(sessions)
      .where(
        and(
          eq(sessions.staffId, id),
          keepToken ? ne(sessions.tokenHash, hashToken(keepToken)) : undefined,
        ),
      )
      .run()
  })
}
