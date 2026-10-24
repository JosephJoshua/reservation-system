import { expect, test } from '@playwright/test'
import { login } from './helpers'

const mode = (page: import('@playwright/test').Page) =>
  page.evaluate(() => document.documentElement.getAttribute('theme-mode'))

test('the 外观 setting forces light or dark and is kept on reload', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await login(page)
  const button = page.getByRole('button', { name: /^外观/ })
  await expect(button).toHaveAccessibleName('外观：跟随系统')
  await expect.poll(() => mode(page)).toBe('light')

  await button.click()
  await page.getByRole('button', { name: '深色' }).click()
  await expect.poll(() => mode(page)).toBe('dark')
  await expect(button).toHaveAccessibleName('外观：深色')

  // The inline script in index.html sets the theme before the app's script runs.
  await page.route('**/src/main.tsx*', (route) => route.abort())
  await page.reload()
  await expect.poll(() => mode(page)).toBe('dark')
  await page.unroute('**/src/main.tsx*')
  await page.reload()
  await expect(button).toHaveAccessibleName('外观：深色')

  // 浅色 holds while the system is dark; 跟随系统 follows it again.
  await page.emulateMedia({ colorScheme: 'dark' })
  await button.click()
  await page.getByRole('button', { name: '浅色' }).click()
  await expect.poll(() => mode(page)).toBe('light')
  // Picking closes the menu and returns focus to the button.
  await expect(page.locator('.theme-menu')).toBeHidden()
  await expect(button).toBeFocused()
  await button.click()
  await page.getByRole('button', { name: '跟随系统' }).click()
  await expect.poll(() => mode(page)).toBe('dark')
  expect(await page.evaluate(() => localStorage.getItem('rs:theme'))).toBeNull()

  // Escape closes the menu and returns focus to the button.
  await button.click()
  await page.getByRole('button', { name: '深色' }).focus()
  await page.keyboard.press('Escape')
  await expect(page.locator('.theme-menu')).toBeHidden()
  await expect(button).toBeFocused()
})
