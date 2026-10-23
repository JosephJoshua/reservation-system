import { type APIRequestContext, expect, type Locator, type Page } from '@playwright/test'

export const API = 'http://localhost:8787/api'
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'admin'

export async function login(page: Page) {
  await page.goto('./')
  await page.getByPlaceholder('管理密码').fill(ADMIN_PASSWORD)
  await page.getByRole('button', { name: '登录' }).click()
  await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible()
}

/** A labelled row in an admin form. */
export function field(scope: Page | Locator, label: string) {
  const page = 'page' in scope && typeof scope.page === 'function' ? scope.page() : (scope as Page)
  return scope
    .locator('.field')
    .filter({ has: page.locator('.field-label', { hasText: new RegExp(`^${label}$`) }) })
}

/** TDesign's InputNumber reformats on focus, so select its text after focusing, then type. */
export async function typeNumber(input: Locator, value: string) {
  await input.click()
  await input.press('ControlOrMeta+a')
  await input.pressSequentially(value)
}

export function dialog(page: Page) {
  return page.locator('.t-dialog:visible')
}

/** Signs in a student through the development login and returns their token. */
export async function student(request: APIRequestContext, name: string) {
  const res = await request.post(`${API}/auth/student`, { data: { code: `dev:${name}` } })
  expect(res.ok()).toBeTruthy()
  const { token } = await res.json()
  return token as string
}

export async function call<T = unknown>(
  request: APIRequestContext,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  token?: string,
  data?: unknown,
): Promise<T> {
  const res = await request.fetch(`${API}${path}`, {
    method,
    data,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  const text = await res.text()
  if (!res.ok()) throw new Error(`${method} ${path} ${res.status()} ${text}`)
  return (text ? JSON.parse(text) : null) as T
}
