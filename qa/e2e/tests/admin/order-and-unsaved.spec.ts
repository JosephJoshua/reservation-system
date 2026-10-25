import { expect, type Page, test } from '@playwright/test'
import { ADMIN_PASSWORD, API, call, field, login } from './helpers'

const run = Date.now().toString(36)

async function adminToken(page: Page) {
  const res = await page.request.post(`${API}/admin/login`, {
    data: { username: 'admin', password: ADMIN_PASSWORD },
  })
  return (await res.json()).token as string
}

/** The titles in the 轮播图 list that this run made, top to bottom. */
async function mine(page: Page) {
  const titles = await page.locator('tbody tr .banner-row-title').allInnerTexts()
  return titles.map((t) => t.trim()).filter((t) => t.endsWith(run))
}

test('banners reorder with 上移 and by dragging, and keep the order', async ({ page }) => {
  await login(page)
  const token = await adminToken(page)
  for (const name of ['甲', '乙', '丙']) {
    await call(page.request, 'POST', '/admin/banners', token, {
      imageUrl: '/api/uploads/x.png',
      title: `${name}${run}`,
    })
  }
  await page.goto('./#/banners')
  await expect.poll(() => mine(page)).toEqual([`甲${run}`, `乙${run}`, `丙${run}`])
  // No 排序 number to type any more.
  await page
    .locator('tbody tr', { hasText: `甲${run}` })
    .getByRole('button', { name: '编辑' })
    .click()
  await expect(field(page.locator('.t-dialog:visible'), '排序')).toHaveCount(0)
  await page.keyboard.press('Escape')

  const row = (name: string) => page.locator('tbody tr', { hasText: `${name}${run}` })
  await row('丙').hover()
  await row('丙').getByRole('button', { name: '上移' }).click()
  await expect.poll(() => mine(page)).toEqual([`甲${run}`, `丙${run}`, `乙${run}`])

  await row('乙')
    .locator('.reorder-handle')
    .dragTo(row('甲'), { targetPosition: { x: 20, y: 4 } })
  await expect.poll(() => mine(page)).toEqual([`乙${run}`, `甲${run}`, `丙${run}`])

  await page.reload()
  await expect.poll(() => mine(page)).toEqual([`乙${run}`, `甲${run}`, `丙${run}`])
  await page.screenshot({ path: 'test-results/order-banners.png' })
})

test('settings ask before leaving with unsaved changes', async ({ page }) => {
  await login(page)
  await page.goto('./#/settings')
  const phone = field(page.locator('.t-card', { hasText: '场馆信息' }), '电话').locator('input')
  const bar = page.locator('.save-bar')
  await expect(phone).toBeVisible()
  await expect(bar).toHaveCount(0)
  const was = await phone.inputValue()

  await phone.fill(`${was}1`)
  await expect(bar).toBeVisible()
  await phone.fill(was)
  await expect(bar).toHaveCount(0)

  await phone.fill(`${was}1`)
  await page.getByRole('link', { name: '课时包' }).click()
  await expect(page.locator('.t-dialog:visible')).toContainText('放弃未保存的修改？')
  await page.getByRole('button', { name: '继续编辑' }).click()
  await expect(page.locator('.t-dialog:visible')).toHaveCount(0)
  await expect(page).toHaveURL(/#\/settings$/)
  await expect(phone).toHaveValue(`${was}1`)

  await bar.getByRole('button', { name: '撤销修改' }).click()
  await expect(phone).toHaveValue(was)
  await expect(bar).toHaveCount(0)

  // The back button asks too, and leaving goes where it pointed.
  await page.getByRole('link', { name: '概览' }).click()
  await expect(page).toHaveURL(/#\/overview$/)
  await page.getByRole('link', { name: '设置' }).click()
  await phone.fill(`${was}2`)
  await page.goBack()
  await expect(page.locator('.t-dialog:visible')).toContainText('放弃未保存的修改？')
  await page.getByRole('button', { name: '继续编辑' }).click()
  await expect(page.locator('.t-dialog:visible')).toHaveCount(0)
  await expect(page).toHaveURL(/#\/settings$/)
  await expect(phone).toHaveValue(`${was}2`)
  await page.goBack()
  await page.getByRole('button', { name: '放弃修改' }).click()
  await expect(page).toHaveURL(/#\/overview$/)
  await expect(page.locator('.admin-title-text')).toHaveText('概览')
  await expect(page.locator('.t-dialog:visible')).toHaveCount(0)
  await page.goForward()
  await expect(phone).toHaveValue(was)

  await phone.fill(`${was}3`)
  await page.getByRole('link', { name: '课时包' }).click()
  await page.getByRole('button', { name: '放弃修改' }).click()
  await expect(page).toHaveURL(/#\/products$/)
  await page.goBack()
  await expect(phone).toHaveValue(was)
})
