import { apiBaseUrl } from '../lib/env'
import type { ApiErrorBody } from '../lib/shared'

const TOKEN_KEY = 'token'
/** Development only: a storage key QA sets to log in as a named test student. */
const DEV_LOGIN_KEY = 'devLogin'

export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export function request<T>(
  method: Method,
  path: string,
  data?: unknown,
  token?: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${apiBaseUrl}/api${path}`,
      method,
      data: data as WechatMiniprogram.IAnyObject | undefined,
      header: token ? { Authorization: `Bearer ${token}` } : {},
      timeout: 15000,
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data as T)
          return
        }
        const body = res.data as Partial<ApiErrorBody> | undefined
        reject(
          new ApiError(
            res.statusCode,
            body?.error?.code ?? 'http_error',
            body?.error?.message ?? '服务暂时不可用，请稍后再试',
          ),
        )
      },
      fail() {
        reject(new ApiError(0, 'network', '网络不佳，请稍后再试'))
      },
    })
  })
}

/** A wx.login code, or the QA stand-in in development builds. */
export function wxCode(): Promise<string> {
  const devName =
    wx.getAccountInfoSync().miniProgram.envVersion === 'develop'
      ? (wx.getStorageSync(DEV_LOGIN_KEY) as string)
      : ''
  if (devName) return Promise.resolve(`dev:${devName}`)
  return new Promise((resolve, reject) => {
    wx.login({
      success: (res) => resolve(res.code),
      fail: () => reject(new ApiError(0, 'login_failed', '登录失败，请稍后再试')),
    })
  })
}

let loggingIn: Promise<string> | null = null

/** Logs in with wx.login once, however many requests are waiting on it. */
function login(): Promise<string> {
  if (!loggingIn) {
    loggingIn = wxCode()
      .then((code) => request<{ token: string }>('POST', '/auth/student', { code }))
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

/** Calls the student API, logging in first when there is no session or it has expired. */
export async function api<T>(method: Method, path: string, data?: unknown): Promise<T> {
  const saved = wx.getStorageSync(TOKEN_KEY) as string
  const token = saved || (await login())
  try {
    return await request<T>(method, path, data, token)
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 401) throw e
    wx.removeStorageSync(TOKEN_KEY)
    return request<T>(method, path, data, await login())
  }
}

/**
 * Calls the student API with the current session only, never logging in again, for a call that
 * must not land on a different account than the one the student is looking at.
 */
export function apiOnce<T>(method: Method, path: string, data?: unknown): Promise<T> {
  const token = wx.getStorageSync(TOKEN_KEY) as string
  if (!token) return Promise.reject(new ApiError(401, 'unauthorized', '请重新登录'))
  return request<T>(method, path, data, token)
}

/** Forgets the session, so the next call logs in afresh. */
export function clearSession(): void {
  wx.removeStorageSync(TOKEN_KEY)
}

/** Calls an endpoint that needs no login. */
export function publicApi<T>(method: Method, path: string, data?: unknown): Promise<T> {
  return request<T>(method, path, data)
}

/** Uploaded images come back as paths on the API server. */
export function assetUrl(url: string): string {
  return url.startsWith('/') ? `${apiBaseUrl}${url}` : url
}

export function errorMessage(e: unknown): string {
  return e instanceof ApiError ? e.message : '出了点问题，请稍后再试'
}

export function showError(e: unknown): void {
  wx.showToast({ title: errorMessage(e), icon: 'none', duration: 2500 })
}
