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

const networkError = () => new ApiError(0, 'network', '网络不佳，请稍后再试')

/** The API's error from a failed response, or `fallback` when the body does not say. */
function responseError(statusCode: number, body: unknown, fallback: string): ApiError {
  const error = (body as Partial<ApiErrorBody> | undefined)?.error
  return new ApiError(statusCode, error?.code ?? 'http_error', error?.message ?? fallback)
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
        reject(responseError(res.statusCode, res.data, '服务暂时不可用，请稍后再试'))
      },
      fail() {
        reject(networkError())
      },
    })
  })
}

/** Sends a local file as the `file` field of a multipart POST; answers like request. */
export function upload<T>(path: string, filePath: string, token: string): Promise<T> {
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: `${apiBaseUrl}/api${path}`,
      filePath,
      name: 'file',
      header: { Authorization: `Bearer ${token}` },
      timeout: 60000,
      success(res) {
        let body: unknown
        try {
          body = JSON.parse(res.data)
        } catch {
          body = undefined
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(body as T)
          return
        }
        reject(
          responseError(
            res.statusCode,
            body,
            res.statusCode === 413 ? '图片不能超过 5MB' : '上传失败，请稍后再试',
          ),
        )
      },
      fail() {
        reject(networkError())
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

function downloadWith(path: string, token: string): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.downloadFile({
      url: `${apiBaseUrl}/api${path}`,
      header: { Authorization: `Bearer ${token}` },
      timeout: 30000,
      success(res) {
        if (res.statusCode === 200) resolve(res.tempFilePath)
        else if (res.statusCode === 401) reject(new ApiError(401, 'unauthorized', '请重新登录'))
        else reject(new ApiError(res.statusCode, 'http_error', '文件暂时无法打开，请稍后再试'))
      },
      fail() {
        reject(new ApiError(0, 'network', '网络不佳，请稍后再试'))
      },
    })
  })
}

/** Downloads a file only the student may see, such as an invoice, to a temporary path. */
export async function download(path: string): Promise<string> {
  const saved = wx.getStorageSync(TOKEN_KEY) as string
  const token = saved || (await login())
  try {
    return await downloadWith(path, token)
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 401) throw e
    wx.removeStorageSync(TOKEN_KEY)
    return downloadWith(path, await login())
  }
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
