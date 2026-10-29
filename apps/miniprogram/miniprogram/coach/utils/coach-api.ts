import type { CoachLoginResponse, CoachMeDto } from '../../lib/shared'
import {
  ApiError,
  actionHeaders,
  type Method,
  newKey,
  request,
  requestKeyed,
  upload,
  wxCode,
} from '../../utils/api'
import { isTop } from '../../utils/nav'

// Separate from the student token: one WeChat user can be both, with different sessions.
const TOKEN_KEY = 'coachToken'

let loggingIn: Promise<string> | null = null

function login(): Promise<string> {
  if (!loggingIn) {
    loggingIn = wxCode()
      .then((code) => request<CoachLoginResponse>('POST', '/coach/login', { code }))
      .then(({ token }) => {
        wx.setStorageSync(TOKEN_KEY, token)
        return token
      })
      .finally(() => {
        loggingIn = null
      })
  }
  return loggingIn
}

/**
 * Runs a call with the coach token, logging in again once when the saved one has expired. Only
 * the refused token is forgotten: a parallel call may have saved a newer one, which is used.
 */
async function withToken<T>(call: (token: string) => Promise<T>): Promise<T> {
  const saved = wx.getStorageSync(TOKEN_KEY) as string
  const token = saved || (await login())
  try {
    return await call(token)
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 401) throw e
    const current = wx.getStorageSync(TOKEN_KEY) as string
    if (current && current !== token) return call(current)
    if (current) wx.removeStorageSync(TOKEN_KEY)
    return call(await login())
  }
}

/** Calls the coach API. Fails with code `not_bound` when this WeChat user is not a coach yet. */
export function coachApi<T>(
  method: Method,
  path: string,
  data?: unknown,
  headers?: Record<string, string>,
): Promise<T> {
  // One key for this action, on every attempt.
  const keyed = actionHeaders(method, headers)
  return withToken((token) => requestKeyed<T>(method, `/coach${path}`, data, token, keyed))
}

/** Uploads a local file to the coach API, like coachApi. */
export function coachUpload<T>(path: string, filePath: string): Promise<T> {
  const key = newKey()
  return withToken((token) => upload<T>(`/coach${path}`, filePath, token, key))
}

/**
 * Binds this WeChat user with a bind code. `lostBefore` is true when an earlier try of the same
 * code got no answer: it may have bound, and a bind code works only once.
 */
export async function bind(bindCode: string, lostBefore: boolean): Promise<CoachMeDto> {
  const code = await wxCode()
  let res: CoachLoginResponse
  try {
    res = await request<CoachLoginResponse>('POST', '/coach/bind', { code, bindCode })
  } catch (e) {
    // Refused after a lost answer: if logging in works now, the earlier try bound this WeChat.
    // Without one, a refused code is a wrong code, even for a WeChat bound to a coach already.
    if (!lostBefore || !(e instanceof ApiError) || e.code !== 'bad_bind_code') throw e
    const bound = await wxCode()
      .then((again) => request<CoachLoginResponse>('POST', '/coach/login', { code: again }))
      .catch(() => null)
    if (!bound) throw e
    res = bound
  }
  wx.setStorageSync(TOKEN_KEY, res.token)
  remember(res.coach)
  return res.coach
}

/**
 * The lesson changed so its 学员档案 is no longer the coach's to see here: cancelled, over a week
 * old, moved to another coach, or the student deleted their account. Retrying cannot help.
 */
export function profileClosed(e: unknown): e is ApiError {
  return (
    e instanceof ApiError && ['profile_closed', 'account_deleted', 'not_found'].includes(e.code)
  )
}

export function isNotBound(e: unknown): boolean {
  return e instanceof ApiError && e.code === 'not_bound'
}

/**
 * Opened by a WeChat user who is not a coach (yet): goes on to 绑定 instead of an error with a
 * retry that cannot help. True when it did, so the page shows nothing else; false when the page
 * is no longer on screen, which then shows its error state.
 */
export function bindInstead(e: unknown, page: unknown): boolean {
  if (!isNotBound(e) || !isTop(page)) return false
  wx.redirectTo({ url: '/coach/bind/index' })
  return true
}

let templateIds: string[] = []

export function remember(me: CoachMeDto): void {
  templateIds = me.notifyTemplateIds
}

/**
 * Asks to send the coach one more lesson message. WeChat grants one message per accepted prompt,
 * so coach pages ask on ordinary taps; once the coach ticks "always", the prompt no longer shows.
 * Must run inside a tap handler, before any await.
 */
export function askForNotices(): void {
  if (!templateIds.length) return
  wx.requestSubscribeMessage({ tmplIds: templateIds.slice(0, 3), fail: () => {} })
}
