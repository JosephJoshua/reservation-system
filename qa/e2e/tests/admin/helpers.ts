import { type APIRequestContext, expect, type Locator, type Page } from '@playwright/test'

export const API = 'http://localhost:8787/api'
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'admin'

export async function login(page: Page, username = 'admin', password = ADMIN_PASSWORD) {
  await page.goto('./')
  await page.getByPlaceholder('登录名').fill(username)
  await page.getByPlaceholder('密码').fill(password)
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
  return page.locator('.t-dialog:not(.crop-dialog):visible')
}

/** Accepts the crop dialog that opens after picking an image, and waits for the upload. */
export async function useCrop(page: Page) {
  const crop = page.locator('.crop-dialog:visible')
  await expect(crop.getByRole('button', { name: '使用图片' })).toBeEnabled()
  await crop.getByRole('button', { name: '使用图片' }).click()
  await expect(crop).toHaveCount(0)
}

/** Signs in a student through the development login, agrees to the policies, returns the token. */
export async function student(request: APIRequestContext, name: string) {
  const res = await request.post(`${API}/auth/student`, { data: { code: `dev:${name}` } })
  expect(res.ok()).toBeTruthy()
  const { token } = await res.json()
  const { version } = await (await request.get(`${API}/policies`)).json()
  const consent = await request.post(`${API}/me/consent`, {
    data: { version },
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(consent.ok()).toBeTruthy()
  return token as string
}

export async function call<T = unknown>(
  request: APIRequestContext,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
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
