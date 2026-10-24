import type { CoachLoginResponse, CoachMeDto } from '../../lib/shared'
import { ApiError, type Method, request, upload, wxCode } from '../../utils/api'

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

/** Runs a call with the coach token, logging in again once when the saved one has expired. */
async function withToken<T>(call: (token: string) => Promise<T>): Promise<T> {
  const saved = wx.getStorageSync(TOKEN_KEY) as string
  const token = saved || (await login())
  try {
    return await call(token)
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 401) throw e
    wx.removeStorageSync(TOKEN_KEY)
    return call(await login())
  }
}

/** Calls the coach API. Fails with code `not_bound` when this WeChat user is not a coach yet. */
export function coachApi<T>(method: Method, path: string, data?: unknown): Promise<T> {
  return withToken((token) => request<T>(method, `/coach${path}`, data, token))
}

/** Uploads a local file to the coach API, like coachApi. */
export function coachUpload<T>(path: string, filePath: string): Promise<T> {
  return withToken((token) => upload<T>(`/coach${path}`, filePath, token))
}

export async function bind(bindCode: string): Promise<CoachMeDto> {
  const code = await wxCode()
  const res = await request<CoachLoginResponse>('POST', '/coach/bind', { code, bindCode })
  wx.setStorageSync(TOKEN_KEY, res.token)
  remember(res.coach)
  return res.coach
}

export function isNotBound(e: unknown): boolean {
  return e instanceof ApiError && e.code === 'not_bound'
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
