import { type ApiErrorBody, versionOf } from '@rs/shared'

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

let onUnauthorized = () => {}
export function handleUnauthorized(fn: () => void) {
  onUnauthorized = fn
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
  { key, ifMatch }: { key?: string; ifMatch?: unknown } = {},
): Promise<T> {
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
  if (res.status === 204) return undefined as T
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    const err = (data as ApiErrorBody | null)?.error
    if (res.status === 401 && !path.startsWith('/admin/login')) {
      setToken(null)
      onUnauthorized()
    }
    throw new RequestError(res.status, err?.code ?? 'unknown', err?.message ?? '操作失败，请重试')
  }
  return data as T
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
async function fetchFile(path: string): Promise<{ blob: Blob; name: string }> {
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
    if (res.status === 401) {
      setToken(null)
      onUnauthorized()
    }
    throw new RequestError(res.status, err?.code ?? 'unknown', err?.message ?? '操作失败，请重试')
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
