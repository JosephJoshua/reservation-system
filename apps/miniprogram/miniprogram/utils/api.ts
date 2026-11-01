import { apiBaseUrl } from '../lib/env'
import type { ApiErrorBody } from '../lib/shared'

const TOKEN_KEY = 'token'
/** Development only: a storage key QA sets to log in as a named test student. */
const DEV_LOGIN_KEY = 'devLogin'
const LOGIN_TIMEOUT = 10000

export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** The booking the error is about, as with already_booked. */
    readonly bookingId?: number,
  ) {
    super(message)
  }
}

const networkError = () => new ApiError(0, 'network', '网络不佳，请稍后再试')

/** How far the server's clock is ahead of the phone's, from the Date header of its answers. */
let clockOffset = 0

/**
 * The time now by the server's clock, to the second. The phone's clock can be wrong, which would
 * show a lesson's deadline or a payment's time limit as passed, or not yet, by mistake.
 */
export function serverNow(): number {
  return Date.now() + clockOffset
}

function noteServerTime(header: WechatMiniprogram.IAnyObject | undefined): void {
  const date = header?.Date ?? header?.date
  const at = typeof date === 'string' ? Date.parse(date) : Number.NaN
  // The header is rounded down to the second, so half a second is added back.
  if (Number.isFinite(at)) clockOffset = at + 500 - Date.now()
}

/**
 * A fresh Idempotency-Key for one user action. It only has to differ from the student's other
 * keys, since the server keeps keys per session.
 */
export function newKey(): string {
  const part = () => Math.random().toString(36).slice(2, 10).padEnd(8, '0')
  return `${Date.now().toString(36)}${part()}${part()}`
}

/**
 * Headers for one user action. A change carries an Idempotency-Key, sent with every attempt of
 * that action, so a repeat after a lost answer gets the first answer back instead of acting twice.
 */
export function actionHeaders(
  method: Method,
  headers: Record<string, string> = {},
): Record<string, string> {
  return method === 'GET' ? headers : { ...headers, 'Idempotency-Key': newKey() }
}

/** The API's error from a failed response, or `fallback` when the body does not say. */
function responseError(statusCode: number, body: unknown, fallback: string): ApiError {
  const error = (body as Partial<ApiErrorBody> | undefined)?.error
  return new ApiError(
    statusCode,
    error?.code ?? 'http_error',
    error?.message ?? fallback,
    typeof error?.bookingId === 'number' ? error.bookingId : undefined,
  )
}

export function request<T>(
  method: Method,
  path: string,
  data?: unknown,
  token?: string,
  /** Extra headers, such as If-Match for a save checked against what the page loaded. */
  headers: Record<string, string> = {},
): Promise<T> {
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${apiBaseUrl}/api${path}`,
      method,
      data: data as WechatMiniprogram.IAnyObject | undefined,
      header: token ? { ...headers, Authorization: `Bearer ${token}` } : headers,
      timeout: 15000,
      success(res) {
        noteServerTime(res.header)
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

/**
 * The first send of a change was lost and its resend was lost too or refused for the session, so it
 * may have gone through. Not a 401: logging in again would send it afresh under a new session.
 */
export const RESULT_UNKNOWN = 'result_unknown'

/**
 * Sends a signed-in request, once more when the network loses a change that carries an
 * Idempotency-Key: the server then answers the repeat with the first result if it got there.
 */
export async function requestKeyed<T>(
  method: Method,
  path: string,
  data: unknown,
  token: string,
  headers: Record<string, string>,
): Promise<T> {
  try {
    return await request<T>(method, path, data, token, headers)
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 0 || !headers['Idempotency-Key']) throw e
  }
  try {
    return await request<T>(method, path, data, token, headers)
  } catch (e) {
    // Refused for the session, or lost again: either way the first send may have gone through.
    if (e instanceof ApiError && (e.status === 401 || e.status === 0)) {
      throw new ApiError(0, RESULT_UNKNOWN, '网络不佳，请刷新后查看是否已成功')
    }
    throw e
  }
}

/**
 * Whether a failed change means the page is out of date and should reload: refused for how
 * things stand now (403, 404, 409). Not a lost answer: with the network down the reload would
 * fail too and could replace the page, and what was typed, with an error.
 */
export function refreshAfter(e: unknown): boolean {
  return e instanceof ApiError && [403, 404, 409].includes(e.status)
}

/** Sends a local file as the `file` field of a multipart POST; answers like request. */
export function upload<T>(
  path: string,
  filePath: string,
  token: string,
  /** The upload's Idempotency-Key, the same when it is sent again. */
  key: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: `${apiBaseUrl}/api${path}`,
      filePath,
      name: 'file',
      header: { Authorization: `Bearer ${token}`, 'Idempotency-Key': key },
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
    const failed = () => reject(new ApiError(0, 'login_failed', '登录失败，请稍后再试'))
    // wx.login can hang without calling back when WeChat's servers are unreachable, which would
    // leave every page waiting on the login; give up so the page can show its error state.
    const timer = setTimeout(failed, LOGIN_TIMEOUT + 2000)
    wx.login({
      timeout: LOGIN_TIMEOUT,
      success: (res) => resolve(res.code),
      fail: failed,
      complete: () => clearTimeout(timer),
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

/**
 * The session to use after `token` was refused: one another call saved meanwhile, or a new login.
 * Only the refused token is forgotten, never a newer one.
 */
async function nextToken(token: string): Promise<string> {
  const current = wx.getStorageSync(TOKEN_KEY) as string
  if (current && current !== token) return current
  if (current) wx.removeStorageSync(TOKEN_KEY)
  return login()
}

/** Calls the student API, logging in first when there is no session or it has expired. */
export async function api<T>(method: Method, path: string, data?: unknown): Promise<T> {
  const headers = actionHeaders(method)
  const saved = wx.getStorageSync(TOKEN_KEY) as string
  const token = saved || (await login())
  try {
    return await requestKeyed<T>(method, path, data, token, headers)
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 401) throw e
    return requestKeyed<T>(method, path, data, await nextToken(token), headers)
  }
}

/**
 * Calls the student API with the current session only, never logging in again, for a call that
 * must not land on a different account than the one the student is looking at.
 */
export function apiOnce<T>(method: Method, path: string, data?: unknown): Promise<T> {
  const token = wx.getStorageSync(TOKEN_KEY) as string
  if (!token) return Promise.reject(new ApiError(401, 'unauthorized', '请重新登录'))
  // Not sent again by itself: a lost 注销 ends the session, so a repeat could only say 401, and
  // the page tells that apart from an expired session by knowing it sent one.
  return request<T>(method, path, data, token, actionHeaders(method))
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
    return downloadWith(path, await nextToken(token))
  }
}

/** The saved session, or '' before the first login. */
export function savedToken(): string {
  return (wx.getStorageSync(TOKEN_KEY) as string) || ''
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
