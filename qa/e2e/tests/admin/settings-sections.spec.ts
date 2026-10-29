import { expect, type Page, test } from '@playwright/test'
import { field, login } from './helpers'

// 设置 in sections with a menu, and 首页内容 holding what students read: the notice and 预约须知.
const run = Date.now().toString(36)

const current = (page: Page) => page.locator('.section-nav-item[aria-current="true"]')
const item = (page: Page, name: string) =>
  page.locator('.section-nav-item').filter({ hasText: new RegExp(`^${name}$`) })
const bar = (page: Page) => page.locator('.save-bar')

test('the settings menu scrolls to a section and marks the ones changed', async ({ page }) => {
  // Scrolls at once, so the scroll by hand below does not race a smooth one.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await login(page)
  await page.goto('./#/settings')
  await expect(current(page)).toHaveText('场馆')
  // What students read moved to 首页内容.
  await expect(page.locator('.t-card__title', { hasText: '首页公告' })).toHaveCount(0)
  await expect(page.getByText('预约须知', { exact: true })).toHaveCount(0)

  await item(page, '课时费').click()
  await expect(current(page)).toHaveText('课时费')
  await expect(page.locator('.t-card__title', { hasText: '课时费' })).toBeInViewport()

  // The page scrolled by hand marks the section at the top.
  await page.mouse.wheel(0, -100000)
  await expect(current(page)).toHaveText('场馆')

  await field(page, '电话').locator('input').fill(`010-${run}`)
  await expect(item(page, '场馆').locator('.section-nav-dot')).toBeVisible()
  await expect(page.locator('.section-nav-dot')).toHaveCount(1)
  await bar(page).getByRole('button', { name: '撤销修改' }).click()
  await expect(page.locator('.section-nav-dot')).toHaveCount(0)
  await expect(bar(page)).toHaveCount(0)
})

test('a link to a settings section opens there', async ({ page }) => {
  await login(page)
  await page.goto('./#/settings?section=attendance')
  await expect(current(page)).toHaveText('签到')
  await expect(page.locator('.t-card__title', { hasText: '签到' })).toBeInViewport()
})

test('the settings menu is a row of chips under the header on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await login(page)
  await page.goto('./#/settings')
  await item(page, '协议与隐私').click()
  await expect(current(page)).toHaveText('协议与隐私')
  await expect(page.locator('.t-card__title', { hasText: '协议与隐私' })).toBeInViewport()
  // The chips stay in view while the page scrolls, and follow the section on screen.
  await expect(item(page, '协议与隐私')).toBeInViewport()
  await page.mouse.wheel(0, -100000)
  await expect(current(page)).toHaveText('场馆')
  await expect(item(page, '场馆')).toBeInViewport()
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBe(0)
})

test('首页内容 saves the notice and 预约须知 with the bar', async ({ page }) => {
  await login(page)
  await page.goto('./#/banners')
  const notice = field(page, '公告').locator('input')
  const policy = page.locator('.t-card', { hasText: '预约须知' }).locator('textarea')
  await notice.fill(`公告${run}`)
  await policy.fill(`须知${run}`)
  await expect(bar(page)).toBeVisible()
  await page.keyboard.press('ControlOrMeta+s')
  await expect(page.getByText('已保存')).toBeVisible()
  await expect(bar(page)).toHaveCount(0)

  await page.reload()
  await expect(notice).toHaveValue(`公告${run}`)
  await expect(policy).toHaveValue(`须知${run}`)

  // 设置 saves the whole settings, and keeps what 首页内容 saved.
  await page.goto('./#/settings')
  const hours = field(page, '营业时间').locator('input')
  await hours.fill((await hours.inputValue()) === '09:00-21:30' ? '09:00-21:00' : '09:00-21:30')
  await bar(page).getByRole('button', { name: '保存' }).click()
  await expect(page.getByText('已保存').first()).toBeVisible()
  // Saved once the settings load again and the bar goes.
  await expect(bar(page)).toHaveCount(0)
  await page.goto('./#/banners')
  await expect(notice).toHaveValue(`公告${run}`)
})

test('leaving 首页内容 with an unsaved notice asks first', async ({ page }) => {
  await login(page)
  await page.goto('./#/banners')
  await field(page, '公告').locator('input').fill(`没保存${run}`)
  await page.getByRole('link', { name: '设置' }).click()
  await expect(page.getByText('放弃未保存的修改？')).toBeVisible()
  await page.getByRole('button', { name: '继续编辑' }).click()
  await expect(page).toHaveURL(/#\/banners/)
  await expect(field(page, '公告').locator('input')).toHaveValue(`没保存${run}`)
})
