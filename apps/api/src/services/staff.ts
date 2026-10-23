import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { and, eq, ne } from 'drizzle-orm'
import type { Db } from '../db/client'
import { immediate } from '../db/client'
import { sessions, staff } from '../db/schema'
import type { Deps } from '../deps'
import { ApiError, isUniqueViolation, notFound } from '../errors'

const KEY_LENGTH = 32

/** `scrypt$<salt>$<hash>`, both hex. Node's default scrypt cost is fine for a handful of staff. */
export function hashPassword(password: string) {
  const salt = randomBytes(16)
  return `scrypt$${salt.toString('hex')}$${scryptSync(password, salt, KEY_LENGTH).toString('hex')}`
}

// Checked against when the username is unknown, so a miss takes as long as a wrong password.
const DUMMY_HASH = hashPassword(randomBytes(16).toString('hex'))

export function verifyPassword(password: string, stored: string | undefined) {
  const [scheme, salt, hash] = (stored ?? DUMMY_HASH).split('$')
  if (scheme !== 'scrypt' || !salt || !hash) return false
  const expected = Buffer.from(hash, 'hex')
  const actual = scryptSync(password, Buffer.from(salt, 'hex'), expected.length)
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
  input: { name: string; username: string; password: string },
) {
  try {
    return deps.db
      .insert(staff)
      .values({
        name: input.name,
        username: input.username,
        passwordHash: hashPassword(input.password),
      })
      .returning()
      .get()
  } catch (e) {
    if (isUniqueViolation(e)) throw new ApiError(409, 'username_taken', '该登录名已被使用')
    throw e
  }
}

/** Renames or (de)activates a login. Deactivating logs it out everywhere at once. */
export function updateStaff(
  deps: Deps,
  actorId: number,
  id: number,
  patch: { name?: string; active?: boolean },
) {
  if (patch.active === false && id === actorId) {
    throw new ApiError(409, 'cannot_deactivate_self', '不能停用自己的账号')
  }
  return immediate(deps.db, (tx) => {
    const before = tx.select().from(staff).where(eq(staff.id, id)).get()
    if (!before) throw notFound('员工')
    const after = tx.update(staff).set(patch).where(eq(staff.id, id)).returning().get()
    if (!after) throw notFound('员工')
    // Two people deactivating each other at once would otherwise lock everyone out.
    if (!tx.select({ id: staff.id }).from(staff).where(eq(staff.active, true)).get()) {
      throw new ApiError(409, 'last_active_staff', '至少要保留一个启用的账号')
    }
    if (!after.active) tx.delete(sessions).where(eq(sessions.staffId, id)).run()
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
      .where(and(eq(sessions.staffId, id), keepToken ? ne(sessions.token, keepToken) : undefined))
      .run()
  })
}
