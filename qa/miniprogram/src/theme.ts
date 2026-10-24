import type automator from 'miniprogram-automator'

type MiniProgram = Awaited<ReturnType<typeof automator.launch>>

// Same key as THEME_STORAGE_KEY in apps/miniprogram/miniprogram/utils/theme.ts.
const THEME_STORAGE_KEY = 'rs:theme'
// DevTools writes simulator storage to disk a few seconds after a change; closing sooner loses it.
const STORAGE_FLUSH_MS = 7000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Forces the 外观 setting ('light' or 'dark'), or clears it to follow the system (null), and
 * waits until storage reads back the new value.
 */
export async function setTheme(miniProgram: MiniProgram, theme: 'light' | 'dark' | null) {
  if (theme) await miniProgram.callWxMethod('setStorageSync', THEME_STORAGE_KEY, theme)
  else await miniProgram.callWxMethod('removeStorageSync', THEME_STORAGE_KEY)
  const want = theme ?? ''
  for (let i = 0; i < 20; i++) {
    if ((await miniProgram.callWxMethod('getStorageSync', THEME_STORAGE_KEY)) === want) return
    await sleep(100)
  }
  throw new Error(`${THEME_STORAGE_KEY} did not become ${want || 'empty'}`)
}

/** The theme QA_THEME asks for: light or dark, or null to follow the system. */
export function qaTheme(): 'light' | 'dark' | null {
  const value = process.env.QA_THEME
  if (!value) return null
  if (value !== 'light' && value !== 'dark') throw new Error('QA_THEME must be light or dark')
  return value
}

/**
 * Applies QA_THEME at the start of a run. With it unset this clears the setting, so a value an
 * earlier run left behind cannot leak in: the clean-up at the end is not guaranteed to stick.
 */
export async function startTheme(miniProgram: MiniProgram) {
  await setTheme(miniProgram, qaTheme())
}

/** Clears a forced theme before closing, and waits for DevTools to write it to disk. */
export async function resetTheme(miniProgram: MiniProgram) {
  await setTheme(miniProgram, null)
  await sleep(STORAGE_FLUSH_MS)
}
