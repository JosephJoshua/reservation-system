import type { CoachMeDto } from '@rs/shared'
import { eq } from 'drizzle-orm'
import { immediate } from '../db/client'
import { coaches, sessions } from '../db/schema'
import type { Deps } from '../deps'
import { ApiError, notFound } from '../errors'
import { templateIds } from '../wx-notify'
import { startCoachSession } from './auth'
import { newBindCode, normalizeBindCode } from './ids'
import { ruleBook, taughtBy } from './settings'

const BIND_CODE_MS = 24 * 3_600_000

/** A one-time code, valid for a day, that links a coach to the WeChat user who enters it. */
export function newCoachBindCode(deps: Deps, coachId: number) {
  const code = newBindCode()
  const expiresAt = new Date(deps.now().getTime() + BIND_CODE_MS)
  const changed = deps.db
    .update(coaches)
    .set({ bindCode: code, bindCodeExpiresAt: expiresAt })
    .where(eq(coaches.id, coachId))
    .run()
  if (changed.changes === 0) throw notFound('教练')
  return { code, expiresAt: expiresAt.toISOString() }
}

export function unbindCoach(deps: Deps, coachId: number) {
  immediate(deps.db, (tx) => {
    const changed = tx
      .update(coaches)
      .set({ openid: null, bindCode: null, bindCodeExpiresAt: null })
      .where(eq(coaches.id, coachId))
      .run()
    if (changed.changes === 0) throw notFound('教练')
    tx.delete(sessions).where(eq(sessions.coachId, coachId)).run()
  })
}

function coachMe(deps: Deps, coach: typeof coaches.$inferSelect): CoachMeDto {
  return {
    id: coach.id,
    name: coach.name,
    title: coach.title,
    avatarUrl: coach.avatarUrl,
    notifyTemplateIds: templateIds(deps.notifier, [
      'coach_booked',
      'coach_cancelled',
      'coach_moved',
    ]),
    // The days any of the coach's own lessons can be booked on.
    advanceDays: ruleBook(deps.db).longestAdvanceDays(taughtBy(deps.db, coach.id)),
  }
}

export function coachProfile(deps: Deps, coachId: number) {
  const coach = deps.db.select().from(coaches).where(eq(coaches.id, coachId)).get()
  if (!coach) throw notFound('教练')
  return coachMe(deps, coach)
}

export async function loginCoach(deps: Deps, code: string) {
  const openid = await deps.wxLogin(code)
  const coach = deps.db.select().from(coaches).where(eq(coaches.openid, openid)).get()
  if (!coach) throw new ApiError(404, 'not_bound', '这个微信还没有绑定教练')
  if (!coach.active) throw new ApiError(403, 'coach_inactive', '教练账号已停用，请联系场馆')
  return { token: startCoachSession(deps, coach.id), coach: coachMe(deps, coach) }
}

export async function bindCoach(deps: Deps, code: string, bindCode: string) {
  const openid = await deps.wxLogin(code)
  const normalized = normalizeBindCode(bindCode)
  const coach = immediate(deps.db, (tx) => {
    const coach = tx.select().from(coaches).where(eq(coaches.bindCode, normalized)).get()
    if (!coach?.bindCodeExpiresAt || coach.bindCodeExpiresAt <= deps.now()) {
      throw new ApiError(400, 'bad_bind_code', '绑定码无效或已过期，请向场馆重新获取')
    }
    if (!coach.active) throw new ApiError(403, 'coach_inactive', '教练账号已停用，请联系场馆')
    const other = tx.select().from(coaches).where(eq(coaches.openid, openid)).get()
    if (other && other.id !== coach.id) {
      throw new ApiError(409, 'already_bound', `这个微信已绑定教练「${other.name}」`)
    }
    // A new phone replaces the old one: sessions from the old WeChat stop working.
    if (coach.openid !== openid) tx.delete(sessions).where(eq(sessions.coachId, coach.id)).run()
    return tx
      .update(coaches)
      .set({ openid, bindCode: null, bindCodeExpiresAt: null })
      .where(eq(coaches.id, coach.id))
      .returning()
      .get()
  })
  return { token: startCoachSession(deps, coach.id), coach: coachMe(deps, coach) }
}
