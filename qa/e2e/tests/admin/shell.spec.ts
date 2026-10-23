import { expect, test } from '@playwright/test'

test('asks for a staff login', async ({ page }) => {
  await page.goto('./')
  await expect(page).toHaveTitle('球馆管理')
  await page.getByPlaceholder('登录名').fill('admin')
  await page.getByPlaceholder('密码').fill('wrong')
  await page.getByRole('button', { name: '登录' }).click()
  await expect(page.getByText('登录名或密码错误')).toBeVisible()
})

test('applies the venue brand color over TDesign', async ({ page }) => {
  await page.goto('./')
  const brand = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--td-brand-color-7').trim(),
  )
  expect(brand).toBe('#1f4fa8')
})
