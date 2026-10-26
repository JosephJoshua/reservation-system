import { expect, test } from '@playwright/test'
import { ADMIN_PASSWORD, call, login } from './helpers'

test.describe.configure({ mode: 'serial' })

// A name no other spec uses, so a search finds only these students.
const NAME = '翻页同学'

test('adds 25 students at the desk', async ({ request }) => {
  const { token } = await call<{ token: string }>(request, 'POST', '/admin/login', undefined, {
    username: 'admin',
    password: ADMIN_PASSWORD,
  })
  for (let i = 1; i <= 25; i++) {
    await call(request, 'POST', '/admin/students', token, {
      name: `${NAME}${String(i).padStart(2, '0')}`,
      phone: `1990000${String(i).padStart(4, '0')}`,
    })
  }
})

test('pages through students and keeps the page and search in the address', async ({ page }) => {
  await login(page)
  await page.goto('./#/students')
  await page.getByPlaceholder('姓名、手机号或编号', { exact: true }).fill(NAME)
  await expect(page.getByText('共 25 条')).toBeVisible()
  await expect(page.locator('.t-table tbody tr')).toHaveCount(20)

  await page.locator('.t-pagination__number', { hasText: /^2$/ }).click()
  await expect(page.locator('.t-table tbody tr')).toHaveCount(5)
  await expect(page).toHaveURL(/page=2/)
  await expect(page).toHaveURL(/q=/)

  await page.reload()
  await expect(page.getByPlaceholder('姓名、手机号或编号', { exact: true })).toHaveValue(NAME)
  await expect(page.locator('.t-table tbody tr')).toHaveCount(5)

  // A new search starts again on page 1.
  await page.getByPlaceholder('姓名、手机号或编号', { exact: true }).fill(`${NAME}0`)
  await expect(page.getByText('共 9 条')).toBeVisible()
  await expect(page).not.toHaveURL(/page=/)

  // The menu link clears the filters.
  await page.locator('.admin-aside .nav-item', { hasText: /^学员$/ }).click()
  await expect(page.getByPlaceholder('姓名、手机号或编号', { exact: true })).toHaveValue('')
})

test('remembers the rows per page', async ({ page }) => {
  await login(page)
  await page.goto(`./#/students?q=${encodeURIComponent(NAME)}`)
  await expect(page.locator('.t-table tbody tr')).toHaveCount(20)
  await page.locator('.t-pagination__select').click()
  await page.locator('.t-select-option', { hasText: '50' }).click()
  await expect(page.locator('.t-table tbody tr')).toHaveCount(25)
  await page.goto('./#/orders')
  await page.goto(`./#/students?q=${encodeURIComponent(NAME)}`)
  await expect(page.locator('.t-table tbody tr')).toHaveCount(25)
})

test('shows 上一页 and 下一页 on a phone, with the filters in a sheet', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page)
  await page.goto(`./#/students?q=${encodeURIComponent(NAME)}`)
  await expect(page.locator('.pager-count')).toContainText('1 / 2 页')
  await page.getByRole('button', { name: '下一页' }).click()
  await expect(page.locator('.pager-count')).toContainText('2 / 2 页')
  // TDesign draws a disabled button as a div.
  await expect(page.locator('.pager .t-button', { hasText: '下一页' })).toHaveClass(/t-is-disabled/)

  await page.goto('./#/orders')
  await page.getByRole('button', { name: '筛选', exact: true }).click()
  const sheet = page.locator('.t-drawer:visible')
  await sheet.locator('.filter[data-label="类型"] .t-select').click()
  await page.locator('.t-select-option', { hasText: '课时包' }).click()
  await sheet.getByRole('button', { name: '完成' }).click()
  await expect(page.getByRole('button', { name: '筛选 · 1' })).toBeVisible()
  await expect(page).toHaveURL(/kind=package/)
  await page.getByRole('button', { name: '筛选 · 1' }).click()
  await sheet.getByRole('button', { name: '清除筛选' }).click()
  await expect(page).not.toHaveURL(/kind=/)
})

test('odd values in the address fall back to 全部', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await login(page)
  for (const hash of [
    '#/bookings?from=&to=2026-02-30&page=-1&status=nope',
    '#/orders?from=2026-13-01&kind=x&page=abc',
    '#/students?group=nope&page=99999',
    '#/actions?from=yesterday&q=%25',
  ]) {
    await page.goto(`./${hash}`)
    await expect(page.locator('.t-table')).toBeVisible()
  }
  expect(errors).toEqual([])
})
