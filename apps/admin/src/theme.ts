import { useLayoutEffect, useSyncExternalStore } from 'react'

/** The 外观 setting: follow the system, or force light or dark. Saved per browser. */
export type ThemeChoice = 'system' | 'light' | 'dark'

// The inline script in index.html reads the same key before the first paint.
const THEME_KEY = 'rs:theme'
const THEME_CHANGED = 'rs:theme-changed'
const darkQuery = '(prefers-color-scheme: dark)'

// Holds the choice when storage refuses it.
let memory: ThemeChoice | null = null

function readChoice(): ThemeChoice {
  try {
    const value = localStorage.getItem(THEME_KEY)
    return value === 'light' || value === 'dark' ? value : 'system'
  } catch {
    return 'system'
  }
}

export function setThemeChoice(choice: ThemeChoice) {
  try {
    if (choice === 'system') localStorage.removeItem(THEME_KEY)
    else localStorage.setItem(THEME_KEY, choice)
    memory = null
  } catch {
    // Storage can be blocked; the choice then lasts until the page reloads.
    memory = choice
  }
  window.dispatchEvent(new Event(THEME_CHANGED))
}

function currentChoice() {
  return memory ?? readChoice()
}

function subscribeChoice(fn: () => void) {
  window.addEventListener(THEME_CHANGED, fn)
  // Another tab changed the setting.
  window.addEventListener('storage', fn)
  return () => {
    window.removeEventListener(THEME_CHANGED, fn)
    window.removeEventListener('storage', fn)
  }
}

function subscribeMode(fn: () => void) {
  const media = window.matchMedia(darkQuery)
  media.addEventListener('change', fn)
  const unsubscribe = subscribeChoice(fn)
  return () => {
    media.removeEventListener('change', fn)
    unsubscribe()
  }
}

/** The saved choice, kept current across tabs. */
export function useThemeChoice() {
  return useSyncExternalStore(subscribeChoice, currentChoice)
}

function resolvedMode() {
  const choice = currentChoice()
  if (choice !== 'system') return choice
  return window.matchMedia(darkQuery).matches ? 'dark' : 'light'
}

/** Sets TDesign's `theme-mode` on the root from the choice and the system preference. */
export function useThemeMode() {
  const mode = useSyncExternalStore(subscribeMode, resolvedMode)
  useLayoutEffect(() => {
    document.documentElement.setAttribute('theme-mode', mode)
  }, [mode])
}
