import { type ApiErrorBody, versionOf } from '@rs/shared'
import { STAFF_CHANGED } from './me'

const TOKEN_KEY = 'rs-admin-token'

export class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {}
}

/** Calls `fn` when another tab of this browser logs in or out, with the token it left. */
export function onTokenChange(fn: (token: string | null) => void) {
  const onStorage = (e: StorageEvent) => {
    // null when the other tab cleared all of the site's storage.
    if (e.key === TOKEN_KEY || e.key === null) fn(getToken())
  }
  window.addEventListener('storage', onStorage)
  return () => window.removeEventListener('storage', onStorage)
}

// While this tab asks who it acts as, such as after another tab logged out or in as someone
// else, requests wait instead of going out with a login that may not be this tab's. Logging in
// itself goes through.
let held: { turn: Promise<boolean>; release: (send: boolean) => void } | null = null

/** Holds requests until `releaseRequests`. */
export function holdRequests() {
  if (held) return
  let release: (send: boolean) => void = () => {}
  const turn = new Promise<boolean>((resolve) => {
    release = resolve
  })
  held = { turn, release }
}

/** Lets held requests go, or with `send` false fails them, as after signing out or switching account. */
export function releaseRequests(send: boolean) {
  const was = held
  held = null
  was?.release(send)
}

async function waitTurn(path: string) {
  if (path.startsWith('/admin/login')) return
  while (held) {
    if (!(await held.turn)) throw new RequestError(401, 'signed_out', '登录已变更，请重新操作')
  }
}

// Asks the signed-in staff member to log in again, resolving true once they have. Requests
// turned away meanwhile all wait on the one question.
let onUnauthorized: () => Promise<boolean> = async () => false
let onDisabled = () => {}
let asking: Promise<boolean> | null = null
/** `disabled` runs instead when the login itself was deactivated. */
export function handleUnauthorized(fn: () => Promise<boolean>, disabled: () => void) {
  onUnauthorized = fn
  onDisabled = disabled
}

function signInAgain() {
  asking ??= onUnauthorized().finally(() => {
    asking = null
  })
  return asking
}

/**
 * Calls the API. Pass `key` (one per dialog opening, say) to make repeated submits of the same
 * action safe: the server runs it once and answers repeats with the first result. `ifMatch` is
 * the record as it was loaded for editing: the save is refused if someone changed it since.
 */
export async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  options: { key?: string; ifMatch?: unknown } = {},
): Promise<T> {
  return (await request<T>(method, path, body, options)).data
}

/** A page of a list, with how many rows match in all. */
export async function apiPage<T>(path: string): Promise<{ rows: T[]; total: number }> {
  const { data, res } = await request<T[]>('GET', path)
  const header = res.headers.get('X-Total-Count')
  const total = header === null ? Number.NaN : Number(header)
  return { rows: data, total: Number.isFinite(total) ? total : data.length }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  { key, ifMatch }: { key?: string; ifMatch?: unknown } = {},
  retried = false,
): Promise<{ data: T; res: Response }> {
  await waitTurn(path)
  const token = getToken()
  const isForm = body instanceof FormData
  let res: Response
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: {
        ...(body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(key ? { 'Idempotency-Key': key } : {}),
        ...(ifMatch === undefined ? {} : { 'If-Match': versionOf(ifMatch) }),
      },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    })
  } catch {
    throw new RequestError(0, 'network', '网络异常，请检查网络后重试')
  }
  if (res.status === 204) return { data: undefined as T, res }
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    const err = (data as ApiErrorBody | null)?.error
    // The session ended: the page stays as it is while the staff member logs in again, and then
    // the request goes again. The server turned it away before doing anything, so this is safe.
    if (res.status === 401 && err?.code === 'account_disabled') onDisabled()
    else if (res.status === 401 && !path.startsWith('/admin/login') && !retried) {
      // Logged in again meanwhile, such as in another tab, or asked now.
      const fresh = getToken()
      if ((fresh && fresh !== token) || (await signInAgain())) {
        return request<T>(method, path, body, { key, ifMatch }, true)
      }
    }
    // Roles changed since the page loaded: reload them, so the menu drops what is no longer allowed.
    if (res.status === 403 && err?.code === 'forbidden')
      window.dispatchEvent(new Event(STAFF_CHANGED))
    const fallback = method === 'GET' ? '加载失败，请重试' : '操作失败，请重试'
    throw new RequestError(res.status, err?.code ?? 'unknown', err?.message ?? fallback)
  }
  return { data: data as T, res }
}

/** Uploads an image and returns its URL under /api/uploads/. */
export async function uploadImage(file: File): Promise<string> {
  // The API refuses these too; checking here saves uploading a large file first.
  if (file.size > 2 * 1024 * 1024) throw new RequestError(400, 'too_large', '图片不能超过 2MB')
  const form = new FormData()
  form.append('file', file)
  const { url } = await api<{ url: string }>('POST', '/admin/uploads', form)
  return url
}

/** Fetches a file the API only gives to a signed-in admin, such as an export or an invoice. */
export async function fetchFile(
  path: string,
  retried = false,
): Promise<{ blob: Blob; name: string }> {
  await waitTurn(path)
  const token = getToken()
  let res: Response
  try {
    res = await fetch(`/api${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
  } catch {
    throw new RequestError(0, 'network', '网络异常，请检查网络后重试')
  }
  if (!res.ok) {
    const err = ((await res.json().catch(() => null)) as ApiErrorBody | null)?.error
    if (res.status === 401 && err?.code === 'account_disabled') onDisabled()
    else if (res.status === 401 && !retried) {
      const fresh = getToken()
      if ((fresh && fresh !== token) || (await signInAgain())) return fetchFile(path, true)
    }
    // Roles changed since the page loaded: reload them, so the menu drops what is no longer allowed.
    if (res.status === 403 && err?.code === 'forbidden')
      window.dispatchEvent(new Event(STAFF_CHANGED))
    throw new RequestError(res.status, err?.code ?? 'unknown', err?.message ?? '下载失败，请重试')
  }
  const disposition = res.headers.get('Content-Disposition') ?? ''
  const encoded = /filename\*=UTF-8''([^;]+)/.exec(disposition)?.[1]
  const plain = /filename="([^"]+)"/.exec(disposition)?.[1]
  return { blob: await res.blob(), name: encoded ? decodeURIComponent(encoded) : (plain ?? 'file') }
}

/** Saves a file from the API under the name the API gives it. */
export async function downloadFile(path: string) {
  const { blob, name } = await fetchFile(path)
  save(blob, name)
}

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/**
 * Opens a PDF from the API in a new tab. The tab opens before the fetch, while the click still
 * counts as the user's, so pop-up blockers let it through.
 */
export async function openFile(path: string) {
  const tab = window.open('', '_blank')
  try {
    const { blob, name } = await fetchFile(path)
    if (tab) {
      const url = URL.createObjectURL(blob)
      tab.location.href = url
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } else save(blob, name)
  } catch (e) {
    tab?.close()
    throw e
  }
}
