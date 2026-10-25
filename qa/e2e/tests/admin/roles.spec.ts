import { expect, type Page, test } from '@playwright/test'
import { ADMIN_PASSWORD, call, dialog, field, login, student } from './helpers'

// Staff roles: what 前台 and 财务 see, and a role change by 管理员 reaching an open session.
test.describe.configure({ mode: 'serial' })

const run = Date.now().toString(36)
const password = 'role-pass-1'
const desk = { name: `前台${run}`, username: `rdesk${run}` }
const money = { name: `财务${run}`, username: `rmoney${run}` }
const ADMIN_URL = 'http://localhost:5173/admin/'
const productName = `前台价${run}`
let studentId = 0

const menu = (page: Page) => page.locator('.admin-aside .nav-item')

test('creates a 前台 and a 财务 login', async ({ request }) => {
  const admin = (
    await call<{ token: string }>(request, 'POST', '/admin/login', undefined, {
      username: 'admin',
      password: ADMIN_PASSWORD,
    })
  ).token
  await call(request, 'POST', '/admin/staff', admin, { ...desk, password, roles: ['front_desk'] })
  await call(request, 'POST', '/admin/staff', admin, { ...money, password, roles: ['finance'] })
  const lessonTypeId = (
    await call<{ id: number }>(request, 'POST', '/admin/lesson-types', admin, {
      name: `前台价课${run}`,
      durationMinutes: 60,
      price: 20000,
    })
  ).id
  await call(request, 'POST', '/admin/package-products', admin, {
    name: productName,
    lessonTypeId,
    lessonCount: 10,
    price: 180000,
    validityDays: 90,
  })
  const token = await student(request, `role-${run}`)
  studentId = (
    await call<{ id: number }>(request, 'PUT', '/me', token, {
      name: `角色学员${run}`,
      phone: '13900000019',
    })
  ).id
})

test('前台 sells a package at the listed price only', async ({ page }) => {
  await login(page, desk.username, password)
  await page.goto(`./#/students?id=${studentId}`)
  await page.getByRole('button', { name: '前台售卖' }).click()
  await field(dialog(page), '课时包').locator('.t-select').click()
  await page.locator('.t-select-option', { hasText: productName }).click()
  const amount = field(dialog(page), '实收金额')
  await expect(amount.locator('input')).toHaveValue('1800.00')
  await expect(amount.locator('input')).toBeDisabled()
  await expect(amount).toContainText('按标价收款，改价请联系管理员')
  await page.screenshot({ path: 'test-results/roles-desk-sale.png' })
  await dialog(page).getByRole('button', { name: '确认收款' }).click()
  await expect(page.getByRole('row', { name: new RegExp(productName) })).toBeVisible()
})

for (const scheme of ['light', 'dark'] as const) {
  test(`前台 sees only the desk pages (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await login(page, desk.username, password)
    await expect(menu(page)).toHaveText(['概览', '日程', '今日', '预约', '学员', '课后点评'])
    // No money on the home page.
    await expect(page.getByText('今日收款')).toHaveCount(0)
    await expect(page.getByText('待审核退款')).toHaveCount(0)
    await expect(page.getByText('待签到', { exact: true })).toBeVisible()
    await page.screenshot({ path: `test-results/roles-desk-overview-${scheme}.png` })

    await page.goto('./#/bookings')
    await expect(page.getByRole('button', { name: '代约' })).toBeVisible()
    await expect(page.getByRole('button', { name: '导出' })).toHaveCount(0)

    // An old link to a page the role lacks opens the first allowed page instead.
    await page.goto('./#/refunds')
    await expect(page.locator('.admin-title')).toHaveText('概览')
  })

  test(`财务 sees the money pages, read-only bookings (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await login(page, money.username, password)
    await expect(menu(page)).toHaveText(['概览', '预约', '学员', '订单', '退款', '发票', '报表'])
    await expect(page.getByText('今日收款')).toBeVisible()
    await page.goto('./#/bookings')
    await expect(page.locator('.admin-title')).toHaveText('预约')
    await expect(page.getByRole('button', { name: '代约' })).toHaveCount(0)
    await expect(page.getByRole('columnheader', { name: '操作' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '导出' })).toBeVisible()
    await page.screenshot({ path: `test-results/roles-finance-bookings-${scheme}.png` })
  })
}

test('管理员 changes a role, and the open session follows', async ({ page, browser }) => {
  const deskPage = await (await browser.newContext({ baseURL: ADMIN_URL })).newPage()
  await login(deskPage, desk.username, password)
  await deskPage.goto('./#/schedule')
  await expect(deskPage.locator('.admin-title')).toHaveText('日程')

  await login(page)
  await page.goto('./#/staff')
  const row = page.getByRole('row', { name: new RegExp(desk.name) })
  await row.getByRole('button', { name: '角色' }).click()
  const d = dialog(page)
  await expect(d.locator('.t-button', { hasText: '保存' })).toHaveClass(/t-is-disabled/)
  // 管理员 covers the others, so it locks them.
  await d.getByText('管理员', { exact: true }).click()
  await expect(d.locator('.t-checkbox.t-is-disabled')).toHaveCount(2)
  await d.getByText('管理员', { exact: true }).click()
  // Back to what it was: nothing to save.
  await d.getByText('前台', { exact: true }).click()
  await expect(d.locator('.t-button', { hasText: '保存' })).toHaveClass(/t-is-disabled/)
  await d.getByText('财务', { exact: true }).click()
  await d.getByText('前台', { exact: true }).click()
  await page.screenshot({ path: 'test-results/roles-dialog.png' })
  await d.getByRole('button', { name: '保存' }).dblclick()
  await expect(row.getByRole('cell', { name: '财务', exact: true })).toBeVisible()
  await expect(row.getByRole('cell', { name: '前台', exact: true })).toHaveCount(0)

  // The open desk session picks up the new role when it moves to another page.
  await deskPage.locator('.admin-aside .nav-item', { hasText: '预约' }).click()
  await expect(deskPage.locator('.admin-aside .nav-item', { hasText: '订单' })).toBeVisible()
  await expect(deskPage.locator('.admin-aside .nav-item', { hasText: '日程' })).toHaveCount(0)

  await page.goto('./#/actions')
  await expect(
    page
      .getByRole('row')
      .filter({ hasText: `${desk.name}（${desk.username}）角色由 前台 改为 财务` }),
  ).toHaveCount(1)
})
