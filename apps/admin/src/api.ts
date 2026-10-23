import type { ApiErrorBody } from '@rs/shared'

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
 * action safe: the server runs it once and answers repeats with the first result.
 */
export async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  options: { key?: string } = {},
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
        ...(options.key ? { 'Idempotency-Key': options.key } : {}),
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
