import { expect, test } from '@playwright/test'

test('shows the coach shell and a healthy API', async ({ page }) => {
  await page.goto('./')
  await expect(page.getByText('今日课程')).toBeVisible()
  await expect(page.getByText('服务正常')).toBeVisible()
})

test('applies the venue brand color over TDesign', async ({ page }) => {
  await page.goto('./')
  const brand = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--td-brand-color-7').trim(),
  )
  expect(brand).toBe('#1f4fa8')
})
