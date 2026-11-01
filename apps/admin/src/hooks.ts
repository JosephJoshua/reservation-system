import { venueDateKey } from '@rs/shared'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { MessagePlugin } from 'tdesign-react'
import { api, RequestError } from './api'
import { lastPressed, settleDialog } from './SaveBar'

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

/** What `useApi` gives a page, for handing a loaded list to a part of it. */
export type ApiData<T> = ReturnType<typeof useApi<T>>

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

/**
 * True while a dialog's change is on its way, for its confirm button's loading state, or the
 * change passed to `attempt` under `key`.
 */
export function useSubmitting(key = DIALOG) {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    () => inFlight.has(key),
  )
}

/**
 * True while a dialog, drawer or popup is on screen, which then owns the keyboard. One matching
 * `except`, such as a menu still fading out, does not count.
 */
export function overlayShown(except?: string) {
  return [
    ...document.querySelectorAll<HTMLElement>('.t-dialog__ctx, .t-drawer--open, .t-popup'),
  ].some(
    (el) =>
      !(except && (el.matches(except) || el.querySelector(except))) &&
      getComputedStyle(el).display !== 'none',
  )
}

// Refusals that mean the record changed elsewhere, so what the dialog shows is out of date.
const STALE = new Set([
  'not_found',
  'not_cancellable',
  'session_cancelled',
  'ended',
  'refund_not_requested',
  'refund_not_failed',
  'refund_not_pending',
  'package_not_active',
  'slot_has_bookings',
  'invoice_handled',
  'anomaly_handled',
  'refund_rejected',
  'exception_exists',
  // An earlier submit of this dialog may have gone through: reload to see what it did.
  'in_progress',
  'idempotency_key_reused',
])

const warned = new Map<string, number>()

/** Shows a warning, once for a double click: the same text again within 2 s is dropped. */
export function warn(text: string, theme: 'warning' | 'info' = 'warning') {
  const at = Date.now()
  if ((warned.get(text) ?? 0) > at - 2_000) return
  warned.set(text, at)
  void MessagePlugin[theme](text)
}

/**
 * Runs a change, shows its error as a message, and reports success. `onStale` runs when the
 * record changed elsewhere, so the page can close the dialog and reload, and the change counts as
 * on its way until a promise it returns settles; `stale` adds codes that mean this for one action.
 * `onRefused` runs when the server refused it for any other reason, but not for a second click
 * dropped while the first is on its way. Row actions pass their own `key`, so a change on one row
 * does not block another.
 */
export async function attempt(
  fn: () => Promise<unknown>,
  /** Said once it worked, or worded from what the request answered. */
  success?: string | ((result: unknown) => string),
  {
    onStale,
    onRefused,
    key = DIALOG,
    stale = [],
    quiet = [],
  }: {
    onStale?: (e: RequestError) => unknown
    onRefused?: () => void
    key?: string
    stale?: string[]
    /** Codes the caller shows itself, with no message. */
    quiet?: string[]
  } = {},
): Promise<boolean> {
  if (inFlight.has(key)) return false
  setInFlight(key, true)
  // The dialog the change was made in, if any, whose typing it saves.
  const from = lastPressed()
  try {
    const result = await fn()
    settleDialog(from)
    const said = typeof success === 'function' ? success(result) : success
    if (said) void MessagePlugin.success(said)
    return true
  } catch (e) {
    if (!(e instanceof RequestError && quiet.includes(e.code))) {
      void MessagePlugin.error(e instanceof RequestError ? e.message : '操作失败，请重试')
    }
    if (onStale && e instanceof RequestError && (STALE.has(e.code) || stale.includes(e.code))) {
      await onStale(e)
    } else onRefused?.()
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

// One per page load, so this tab's keys never match another's.
const pageKey = newKey()

/**
 * The Idempotency-Key for an action that can only happen once to a record, such as
 * `cancel-booking-12` or `delete-slot-3`: every try of it from this page is the same action.
 */
export function onceKey(action: string) {
  return `${pageKey}-${action}`
}

/**
 * Idempotency-Keys for actions that can be done again later, such as switching 测试学员 or
 * retrying a refund: `get(name)` gives the same key until `done(name)` is called once the action
 * went through, so a retry after a lost response is a repeat and the next action is new.
 */
export function useActionKeys() {
  const keys = useRef(new Map<string, string>())
  return useState(() => ({
    get(name: string) {
      let key = keys.current.get(name)
      if (!key) {
        key = newKey()
        keys.current.set(name, key)
      }
      return key
    },
    done(name: string) {
      keys.current.delete(name)
    },
  }))[0]
}

/** A query parameter of the current page, as in `#/refunds?status=failed`. */
export function hashParam(name: string) {
  return new URLSearchParams(window.location.hash.split('?')[1] ?? '').get(name)
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

/**
 * The time now, taken again every `stepMs`, for a page whose wording changes as time passes,
 * such as a 闭馆 that starts while it is open.
 */
export function useNow(stepMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), stepMs)
    return () => window.clearInterval(timer)
  }, [stepMs])
  return now
}

/**
 * The venue date, which moves on at midnight while the page is open; `onChange` runs then with
 * the day before and the new one.
 */
export function useToday(onChange?: (from: string, to: string) => void): string {
  const now = useNow(10_000)
  const day = venueDateKey(new Date(now))
  const last = useRef(day)
  const changed = useRef(onChange)
  changed.current = onChange
  useEffect(() => {
    if (last.current === day) return
    const from = last.current
    last.current = day
    changed.current?.(from, day)
  }, [day])
  return day
}
