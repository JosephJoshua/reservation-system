import { mkdirSync } from 'node:fs'
import { expect, type Page, test } from '@playwright/test'
import { ADMIN_PASSWORD, call, login, student } from './helpers'

const shots = 'test-results/expiring'
mkdirSync(shots, { recursive: true })

const run = Date.now().toString(36)

async function both(page: Page, name: string) {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForTimeout(200)
    await page.screenshot({ path: `${shots}/${name}-${scheme}.png`, fullPage: true })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

test('lists students whose packages expire soon, soonest first', async ({ page, request }) => {
  const admin = (
    await call<{ token: string }>(request, 'POST', '/admin/login', undefined, {
      username: 'admin',
      password: ADMIN_PASSWORD,
    })
  ).token
  const lesson = await call<{ id: number }>(request, 'POST', '/admin/lesson-types', admin, {
    name: `到期${run}`,
    durationMinutes: 60,
    price: 20000,
  })
  const product = (name: string, validityDays: number, lessonCount = 5) =>
    call<{ id: number }>(request, 'POST', '/admin/package-products', admin, {
      name,
      lessonTypeId: lesson.id,
      lessonCount,
      price: 100000,
      validityDays,
      onSale: false,
    })
  const soon = await product(`五天包${run}`, 5)
  const month = await product(`月卡${run}`, 25)
  const year = await product(`年卡${run}`, 365)
  const sell = async (who: string, productId: number) => {
    const token = await student(request, `${who}-${run}`)
    await call(request, 'PUT', '/me', token, { name: `${who}${run}` })
    const { id } = await call<{ id: number }>(request, 'GET', '/me', token)
    await call(request, 'POST', '/admin/packages/offline-sale', admin, {
      studentId: id,
      productId,
      amount: 100000,
      method: 'cash',
    })
  }
  await sell('甲', month.id)
  await sell('乙', soon.id)
  await sell('丙', year.id)
  // 甲 has two packages expiring within 30 days; the one that expires first is shown.
  const jia = (
    await call<{ id: number; name: string }[]>(request, 'GET', `/admin/students?q=甲${run}`, admin)
  )[0]
  await call(request, 'POST', '/admin/packages/offline-sale', admin, {
    studentId: jia?.id,
    productId: soon.id,
    amount: 100000,
    method: 'cash',
  })

  await login(page)
  await page.goto('./#/students')
  await page.getByPlaceholder('姓名或手机号', { exact: true }).fill(run)
  await expect(page.getByRole('row')).toHaveCount(4)
  await expect(page.getByRole('button', { name: '导出' })).toBeVisible()

  await page.locator('.toolbar .t-select').click()
  await page.locator('.t-select-option', { hasText: '课时包即将到期' }).click()
  await expect(page.getByText('30 天内到期且有剩余课时的学员')).toBeVisible()
  await expect(page.getByRole('button', { name: '导出' })).toHaveCount(0)
  const rows = page.locator('.t-table tbody tr')
  await expect(rows).toHaveCount(2)
  // Same expiry: the package sold first comes first.
  await expect(rows.nth(0)).toContainText(`乙${run}`)
  await expect(rows.nth(0)).toContainText('5 节')
  await expect(rows.nth(0)).toContainText('5 天后')
  await expect(rows.nth(1)).toContainText(`甲${run}`)
  await expect(rows.nth(1)).toContainText(`五天包${run} 等 2 个`)
  await expect(page.getByText(`丙${run}`)).toHaveCount(0)
  await both(page, 'expiring')
  await page.setViewportSize({ width: 390, height: 844 })
  await both(page, 'expiring-phone')
  await page.setViewportSize({ width: 1280, height: 720 })

  // Search narrows the filtered list; a name with nothing expiring shows the empty state.
  await page.getByPlaceholder('姓名或手机号', { exact: true }).fill(`丙${run}`)
  await expect(page.getByText('没有找到学员')).toBeVisible()
  await page.getByPlaceholder('姓名或手机号', { exact: true }).fill(`乙${run}`)
  await expect(rows).toHaveCount(1)

  // Opening a student keeps the filter.
  await rows.nth(0).getByRole('button', { name: '查看' }).click()
  await expect(page.locator('.t-drawer')).toContainText(`五天包${run}`)
  await page.goBack()
  await expect(rows).toHaveCount(1)
  await expect(page.getByText('30 天内到期且有剩余课时的学员')).toBeVisible()

  // Cleared, the list is every student again.
  await page.locator('.toolbar .t-select').hover()
  await page.locator('.toolbar .t-select .t-input__suffix-clear').click()
  await expect(page.getByRole('button', { name: '导出' })).toBeVisible()
  await expect(page.getByText(`乙${run}`)).toBeVisible()
})
