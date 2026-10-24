import type { VenueSettings } from '@rs/shared'
import { useEffect, useState } from 'react'
import { api } from './api'
import { attempt, newKey, useApi } from './hooks'

/**
 * The venue settings as a form: 设置 and 首页内容 each edit their own part of them and save the
 * whole, guarded by If-Match, so a change saved elsewhere meanwhile is not overwritten.
 */
export function useSettingsDraft() {
  const { data, error, reload } = useApi<VenueSettings>('/admin/settings')
  const [s, setS] = useState<VenueSettings | null>(null)
  const [saving, setSaving] = useState(false)
  // One per loaded version, so a retry after a lost response is not saved twice.
  const [key, setKey] = useState(newKey)

  useEffect(() => {
    if (!data) return
    setS(structuredClone(data))
    setKey(newKey())
  }, [data])

  const set = (fn: (draft: VenueSettings) => void) =>
    setS((prev) => {
      if (!prev) return prev
      const next = structuredClone(prev)
      fn(next)
      return next
    })

  const reset = () => {
    if (data) setS(structuredClone(data))
  }

  /** Saves `body`, or the form as it is; true once saved and loaded again. */
  const save = async (body: VenueSettings | null = s) => {
    if (saving || !body) return false
    setSaving(true)
    const ok = await attempt(
      () => api('PUT', '/admin/settings', body, { ifMatch: data, key }),
      '已保存',
    )
    if (ok) await reload()
    setSaving(false)
    return ok
  }

  return {
    data,
    error,
    s,
    set,
    reset,
    save,
    saving,
    /** True once the parts named by `pick` differ from the saved settings. */
    changed: (pick: (v: VenueSettings) => unknown) =>
      !!s && !!data && JSON.stringify(pick(s)) !== JSON.stringify(pick(data)),
  }
}
