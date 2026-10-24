// The 外观 setting: follow the system (default), or force light or dark. Pages pick it up through
// components/theme-root, which sets .theme-light / .theme-dark on its wrapper and paints the native
// bars that theme.json would otherwise only paint for the system theme.
import { dark, light, tabs } from '../lib/native-theme'

export type Theme = 'light' | 'dark'
export type ThemeSetting = 'system' | Theme

// QA forces a theme by writing this key and then calling wx.reLaunch.
export const THEME_STORAGE_KEY = 'rs:theme'

export const THEME_SETTING_LABELS: Record<ThemeSetting, string> = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色',
}

function readSystemTheme(): Theme {
  const theme = wx.getAppBaseInfo ? wx.getAppBaseInfo().theme : wx.getSystemInfoSync().theme
  return theme === 'dark' ? 'dark' : 'light'
}

let systemTheme = readSystemTheme()
const listeners = new Set<() => void>()
const notify = () => {
  for (const listener of listeners) listener()
}

wx.onThemeChange(({ theme }) => {
  systemTheme = theme === 'dark' ? 'dark' : 'light'
  notify()
})

// Read on every call rather than cached, so a value QA writes before reLaunch takes effect.
export function themeSetting(): ThemeSetting {
  let value: unknown
  try {
    value = wx.getStorageSync(THEME_STORAGE_KEY)
  } catch {}
  return value === 'light' || value === 'dark' ? value : 'system'
}

export function setThemeSetting(setting: ThemeSetting) {
  if (setting === 'system') wx.removeStorageSync(THEME_STORAGE_KEY)
  else wx.setStorageSync(THEME_STORAGE_KEY, setting)
  notify()
}

export function currentTheme(): Theme {
  const setting = themeSetting()
  return setting === 'system' ? systemTheme : setting
}

/** Calls listener when the setting or the system theme changes; returns the unsubscribe. */
export function onThemeChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// Native dialogs (showModal, showActionSheet) follow the system theme whatever the setting says,
// so their colours are picked for the system theme: reds that keep 4.5:1 on the white and the dark
// modal.
export function modalDangerColor(): string {
  return systemTheme === 'dark' ? '#f07075' : '#c4362f'
}

const ignore = () => {}

/** Paints the current page's navigation bar and window background, and the tab bar on tab pages. */
export function applyNativeTheme(theme: Theme, route: string) {
  const values = theme === 'dark' ? dark : light
  wx.setNavigationBarColor({
    frontColor: values.navTextStyle === 'white' ? '#ffffff' : '#000000',
    backgroundColor: values.navBgColor,
    fail: ignore,
  })
  wx.setBackgroundColor({
    backgroundColor: values.bgColor,
    backgroundColorTop: values.bgColor,
    backgroundColorBottom: values.bgColor,
    fail: ignore,
  })
  wx.setBackgroundTextStyle({ textStyle: values.bgTextStyle as 'dark' | 'light', fail: ignore })
  // The tab bar is shared by the tab pages and these calls fail on other pages.
  if (!tabs.some((tab) => tab.pagePath === route)) return
  wx.setTabBarStyle({
    color: values.tabColor,
    selectedColor: values.tabSelectedColor,
    backgroundColor: values.tabBgColor,
    borderStyle: values.tabBorderStyle as 'black' | 'white',
    fail: ignore,
  })
  // Icon paths in app.json are theme.json variables, such as "@bookingIcon".
  const icon = (variable: string) => `/${values[variable.replace(/^@/, '')]}`
  tabs.forEach((tab, index) => {
    wx.setTabBarItem({
      index,
      iconPath: icon(tab.iconPath),
      selectedIconPath: icon(tab.selectedIconPath),
      fail: ignore,
    })
  })
}
