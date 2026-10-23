import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { MessagePlugin } from 'tdesign-react'
import { api, RequestError } from './api'

/** Loads a GET endpoint; `reload` fetches again. */
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const seq = useRef(0)

  const reload = useCallback(async () => {
    if (!path) return
    const mine = ++seq.current
    setLoading(true)
    try {
      const result = await api<T>('GET', path)
      if (mine === seq.current) {
        setData(result)
        setError(null)
      }
    } catch (e) {
      if (mine === seq.current) setError((e as Error).message)
    } finally {
      if (mine === seq.current) setLoading(false)
    }
  }, [path])

  useEffect(() => {
    void reload()
  }, [reload])

  return { data, error, loading, reload, setData }
}

// Changes in flight, by key. A second click with the same key is dropped, so a double click
// cannot record a sale or grant lessons twice. Dialogs share the default key: only one is open.
const DIALOG = 'dialog'
const inFlight = new Set<string>()
const listeners = new Set<() => void>()
function setInFlight(key: string, on: boolean) {
  if (on) inFlight.add(key)
  else inFlight.delete(key)
  for (const fn of listeners) fn()
}

/** True while a dialog's change is on its way, for its confirm button's loading state. */
export function useSubmitting() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    () => inFlight.has(DIALOG),
  )
}

// Refusals that mean the record changed elsewhere, so what the dialog shows is out of date.
const STALE = new Set([
  'not_found',
  'not_cancellable',
  'ended',
  'refund_not_requested',
  'refund_not_failed',
  'refund_not_pending',
  'package_not_active',
  'slot_has_bookings',
  'invoice_handled',
  // An earlier submit of this dialog may have gone through: reload to see what it did.
  'in_progress',
  'idempotency_key_reused',
])

/**
 * Runs a change, shows its error as a message, and reports success. `onStale` runs when the
 * record changed elsewhere, so the page can close the dialog and reload. Row actions pass
 * their own `key`, so a change on one row does not block another.
 */
export async function attempt(
  fn: () => Promise<unknown>,
  success?: string,
  { onStale, key = DIALOG }: { onStale?: () => void; key?: string } = {},
): Promise<boolean> {
  if (inFlight.has(key)) return false
  setInFlight(key, true)
  try {
    await fn()
    if (success) void MessagePlugin.success(success)
    return true
  } catch (e) {
    void MessagePlugin.error(e instanceof RequestError ? e.message : '操作失败，请重试')
    if (onStale && e instanceof RequestError && STALE.has(e.code)) onStale()
    return false
  } finally {
    setInFlight(key, false)
  }
}

/**
 * A fresh Idempotency-Key. Works over plain http too, unlike crypto.randomUUID.
 */
export function newKey() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('')
}

/**
 * One Idempotency-Key per dialog opening: a retry after a lost response returns the first
 * result instead of recording the change twice.
 */
export function useIdempotencyKey() {
  return useState(newKey)[0]
}

// Matches the breakpoint in phone.css.
const phoneQuery = '(max-width: 767px)'

/** True on a phone-sized screen, where the admin uses its one-column layout. */
export function useIsPhone() {
  return useSyncExternalStore(
    (fn) => {
      const media = window.matchMedia(phoneQuery)
      media.addEventListener('change', fn)
      return () => media.removeEventListener('change', fn)
    },
    () => window.matchMedia(phoneQuery).matches,
  )
}
