import type { VenueSettings } from '@rs/shared'
import { useEffect, useRef, useState } from 'react'
import { MessagePlugin } from 'tdesign-react'
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
  // Set at once, unlike `saving`, so a second click or a held ⌘S before the next render is ignored.
  const busy = useRef(false)
  // The form as it was when saved: anything typed after it is kept when the saved settings load.
  const sent = useRef<VenueSettings | null>(null)
  // The form was put back while a save was on its way: the saved settings load in full.
  const discarded = useRef(false)
  // One per loaded version, so a retry after a lost response is not saved twice.
  const [key, setKey] = useState(newKey)
  // Someone else saved the settings meanwhile: the form keeps what was typed, but can't be saved
  // over their change until the newer settings are loaded.
  const [stale, setStale] = useState(false)
  // A refused save reloads the settings without replacing the form.
  const keep = useRef(false)

  useEffect(() => {
    if (!data) return
    const typed = sent.current
    sent.current = null
    const kept = keep.current
    keep.current = false
    setS((prev) =>
      prev && (kept || (typed && JSON.stringify(prev) !== JSON.stringify(typed)))
        ? prev
        : structuredClone(data),
    )
    setKey(newKey())
  }, [data])

  const set = (fn: (draft: VenueSettings) => void) =>
    setS((prev) => {
      if (!prev) return prev
      const next = structuredClone(prev)
      fn(next)
      return next
    })

  /** Puts the form back to the settings as last loaded, the newest after a refused save. */
  const reset = () => {
    if (busy.current) discarded.current = true
    if (data) setS(structuredClone(data))
    setStale(false)
  }

  /** Saves `body`, or the form as it is; true once saved and loaded again. */
  const save = async (body: VenueSettings | null = s) => {
    if (busy.current || !body) return false
    if (stale) {
      void MessagePlugin.warning('设置已被其他人修改，请先载入最新内容')
      return false
    }
    busy.current = true
    setSaving(true)
    const form = s
    discarded.current = false
    // Its own key, so a dialog on the same page (a banner's editor) is not held up by it.
    const ok = await attempt(
      () => api('PUT', '/admin/settings', body, { ifMatch: data, key }),
      '已保存',
      {
        key: 'settings',
        stale: ['edited_elsewhere'],
        onStale: async (e) => {
          if (e.code === 'edited_elsewhere') setStale(true)
          keep.current = true
          await reload()
        },
      },
    )
    if (ok) {
      sent.current = discarded.current ? null : form
      await reload()
    }
    busy.current = false
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
    /** Saved elsewhere since loading: `reset` loads the newer settings. */
    stale,
    /** True from the moment a save starts, before `saving` renders. */
    isSaving: () => busy.current,
    /** True once the parts named by `pick` differ from the saved settings. */
    changed: (pick: (v: VenueSettings) => unknown) =>
      !!s && !!data && JSON.stringify(pick(s)) !== JSON.stringify(pick(data)),
  }
}
