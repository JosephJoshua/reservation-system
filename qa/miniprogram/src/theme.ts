import type automator from 'miniprogram-automator'

type MiniProgram = Awaited<ReturnType<typeof automator.launch>>

// Same key as THEME_STORAGE_KEY in apps/miniprogram/miniprogram/utils/theme.ts.
const THEME_STORAGE_KEY = 'rs:theme'

/**
 * Forces the 外观 setting ('light' or 'dark'), or clears it to follow the system (null), and
 * waits until storage reads back the new value. Without the read back, a close() straight after
 * can drop the write, and the setting leaks into the next run.
 */
export async function setTheme(miniProgram: MiniProgram, theme: 'light' | 'dark' | null) {
  if (theme) await miniProgram.callWxMethod('setStorageSync', THEME_STORAGE_KEY, theme)
  else await miniProgram.callWxMethod('removeStorageSync', THEME_STORAGE_KEY)
  const want = theme ?? ''
  for (let i = 0; i < 20; i++) {
    if ((await miniProgram.callWxMethod('getStorageSync', THEME_STORAGE_KEY)) === want) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`${THEME_STORAGE_KEY} did not become ${want || 'empty'}`)
}
