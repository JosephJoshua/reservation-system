import { join } from 'node:path'
import { expect, type Locator, type Page, test } from '@playwright/test'
import { ADMIN_PASSWORD, API, call, dialog, field, login, saveEdit, typeNumber } from './helpers'

// Previews of coaches, lessons, packages, banners and the home notice in the mini program's
// own styles, beside the edit forms and from each list's 预览.
test.describe.configure({ mode: 'serial' })

const run = Date.now().toString(36)
const lessonName = `预览课${run.slice(-5)}`
const coachName = `预览教练${run.slice(-4)}`
const productName = `预览卡${run.slice(-5)}`
const shots = join(import.meta.dirname, '../../test-results/preview-shots')

/** The page inside the phone. */
const screen = (scope: Page | Locator) => scope.locator('.mp-page')
const navTitle = (scope: Page | Locator) => scope.locator('.mp-nav-title')
/** The lesson's row in the 课程 table. */
const lessonRow = (page: Page, name = lessonName) => page.getByRole('row').filter({ hasText: name })
/** A record's edit page, with its form and the phone beside it. */
const editPage = (page: Page) => page.locator('.edit-page')

async function both(page: Page, name: string) {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForTimeout(200)
    await page.screenshot({ path: `${shots}/${name}-${scheme}.png` })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

const bannerTitle = `预览图${run}`
// A 2x2 PNG, enough for an upload.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==',
  'base64',
)

test.beforeAll(async ({ request }) => {
  const admin = (
    await call<{ token: string }>(request, 'POST', '/admin/login', undefined, {
      username: 'admin',
      password: ADMIN_PASSWORD,
    })
  ).token
  await call(request, 'POST', '/admin/lesson-types', admin, {
    name: lessonName,
    description: '预览用的课程',
    durationMinutes: 45,
    price: 18800,
  })
  const upload = await request.post(`${API}/admin/uploads`, {
    headers: { Authorization: `Bearer ${admin}` },
    multipart: { file: { name: 'banner.png', mimeType: 'image/png', buffer: png } },
  })
  expect(upload.ok()).toBeTruthy()
  const { url } = await upload.json()
  await call(request, 'POST', '/admin/banners', admin, {
    imageUrl: url,
    title: bannerTitle,
    linkKind: 'none',
    linkId: null,
    startsAt: null,
    endsAt: null,
    active: true,
    sort: 0,
  })
})

test('a new coach shows on their page as it is typed', async ({ page }) => {
  await login(page)
  await page.goto('./#/coaches')
  await page.getByRole('button', { name: '新建教练' }).click()
  const d = editPage(page)
  // Nothing typed yet: no lessons to book, and the page says so.
  await expect(screen(d)).toContainText('这位教练暂未开放预约')
  await expect(d.locator('.mp-preview-alert')).toContainText('还没有可预约的课程')

  await field(d, '姓名').locator('input').fill(coachName)
  await field(d, '头衔').locator('input').fill('前省队队员')
  const tags = field(d, '擅长').locator('input')
  await tags.fill('弧圈球')
  await tags.press('Enter')
  await field(d, '所教课程').getByText(lessonName).click()
  await expect(navTitle(d)).toHaveText(coachName)
  await expect(screen(d).locator('.head-name')).toHaveText(coachName)
  await expect(screen(d).locator('.head-title')).toHaveText('前省队队员')
  await expect(screen(d).locator('.head-tags')).toHaveText('弧圈球')
  await expect(screen(d).locator('.lesson')).toContainText(`${lessonName}45分钟¥188`)
  await expect(screen(d).locator('.action-bar')).toHaveText(`预约${coachName}`)
  await expect(d.locator('.mp-preview-alert')).toHaveCount(0)

  // The profile shows in the page's own text styles.
  await field(d, '介绍').locator('.ProseMirror').fill('十年执教经验')
  await expect(screen(d).locator('.profile-body')).toHaveText('十年执教经验')

  // 在职 off: still previewed, with the reason students would not see it.
  await field(d, '在职').locator('.t-switch').click()
  await expect(d.locator('.mp-preview-alert')).toContainText('教练已停用')
  await field(d, '在职').locator('.t-switch').click()

  // The home tab lists the coach, scrolled into view.
  await d.locator('.mp-preview-bar').getByText('首页').click()
  await expect(navTitle(d)).not.toHaveText(coachName)
  await expect(screen(d).locator('[data-preview-focus]')).toContainText(coachName)
  await expect(screen(d).locator('[data-preview-focus]')).toBeInViewport()
  await both(page, 'coach-edit')

  await saveEdit(page)
  await expect(page.locator('.t-message')).toContainText('已保存')
})

test('the dark switch shows the dark theme whatever the admin uses', async ({ page }) => {
  await login(page)
  await page.goto('./#/coaches')
  const row = page.getByRole('row').filter({ hasText: coachName })
  await row.getByRole('button', { name: '预览' }).click()
  const d = dialog(page)
  await expect(d).toContainText(`预览：${coachName}`)
  await expect(screen(d)).toHaveClass(/mp-light/)
  const bg = () =>
    screen(d).evaluate((el) => getComputedStyle(el.firstElementChild as Element).backgroundColor)
  const light = await bg()
  await d.getByRole('button', { name: '看深色模式' }).click()
  await expect(screen(d)).toHaveClass(/mp-dark/)
  // The mini program's own page colours: #ededed light, #111111 dark (styles/tokens.wxss).
  expect(light).toBe('rgb(237, 237, 237)')
  expect(await bg()).toBe('rgb(17, 17, 17)')
  await d.getByRole('button', { name: '关闭' }).click()
  await expect(d).toHaveCount(0)
})

test('a lesson shows on the home tab with its price and who teaches it', async ({ page }) => {
  await login(page)
  await page.goto('./#/courses')
  const row = lessonRow(page)
  await row.getByRole('button', { name: '编辑' }).click()
  const d = editPage(page)
  const focused = screen(d).locator('[data-preview-focus]')
  await expect(focused).toContainText(lessonName)
  await expect(focused).toContainText('¥188')
  await expect(focused).toContainText('45分钟')

  await typeNumber(field(d, '标准价').locator('input'), '150')
  await expect(focused).toContainText('¥150')
  await typeNumber(field(d, '上课人数').locator('input'), '4')
  await expect(focused).toContainText('45分钟 · 最多4人')
  await expect(focused).toContainText('小班')

  await d.locator('.mp-preview-bar').getByText('选择时间').click()
  await expect(navTitle(d)).toHaveText(lessonName)
  await expect(screen(d).locator('.coach-row')).toContainText(coachName)
  await expect(screen(d).locator('.coach-row')).toContainText('¥150')

  // Not saved: the list keeps the old price.
  await page.locator('.breadcrumb').getByRole('link', { name: '课程' }).click()
  await page.getByRole('button', { name: '放弃修改' }).click()
  await row.getByRole('button', { name: '预览' }).click()
  await expect(screen(dialog(page)).locator('[data-preview-focus]')).toContainText('¥188')
})

test('a package previews on the 课时包 page, outlined', async ({ page }) => {
  await login(page)
  await page.goto('./#/products')
  await page.getByRole('button', { name: '新建课时包' }).click()
  const d = editPage(page)
  await field(d, '名称').locator('input').fill(productName)
  await field(d, '课程').locator('.t-select').click()
  await page.locator('.t-select-option').filter({ hasText: lessonName }).click()
  // A cleared box takes the digits typed next, and a number over the limit comes down to it.
  const count = field(d, '课时数').locator('input')
  await count.click()
  await count.press('ControlOrMeta+a')
  await count.press('Backspace')
  await count.pressSequentially('8')
  const days = field(d, '有效期').locator('input')
  await typeNumber(days, '3700')
  await field(d, '名称').locator('.field-label').click()
  await expect(count).toHaveValue('8')
  await expect(days).toHaveValue('3650')
  await typeNumber(field(d, '价格').locator('input'), '1200')
  const card = screen(d).locator('.product-highlight')
  await expect(card).toContainText(productName)
  await expect(card).toContainText(`${lessonName} · 全部教练`)
  await expect(card).toContainText('¥1200')
  await expect(card).toContainText('¥150/节')
  await field(d, '在售').locator('.t-switch').click()
  await expect(d.locator('.mp-preview-alert')).toContainText('未在售')
  await both(page, 'package-edit')
})

test('a banner previews on the home tab with its title', async ({ page }) => {
  await login(page)
  await page.goto('./#/banners')
  const row = page.getByRole('row').filter({ hasText: bannerTitle })
  // 首页内容 has its own preview beside the list, so 预览 turns its carousel to the banner.
  await row.getByRole('button', { name: '预览' }).click()
  const side = page.locator('.editor-preview')
  await expect(screen(side).locator('.banners img')).toBeVisible()
  await expect(screen(side).locator('.banner-title')).toHaveText(bannerTitle)
  await expect(dialog(page)).toHaveCount(0)

  await row.getByRole('button', { name: '编辑' }).click()
  const d = editPage(page)
  await field(d, '标题').locator('input').fill(`预览标题${run}`)
  await expect(screen(d).locator('.banner-title')).toHaveText(`预览标题${run}`)
  await field(d, '展示').locator('.t-switch').click()
  await expect(d.locator('.mp-preview-alert')).toContainText('已设为隐藏')
})

test('首页内容 previews the home notice as it is typed', async ({ page }) => {
  await login(page)
  await page.goto('./#/banners')
  await field(page, '公告').locator('input').fill(`预览公告${run}`)
  await expect(screen(page.locator('.editor-preview')).locator('.notice')).toContainText(
    `预览公告${run}`,
  )
  await page.locator('.save-bar').getByRole('button', { name: '撤销修改' }).click()
})

test('on a phone, 预览 on 首页内容 opens the banner in a dialog', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page)
  await page.goto('./#/banners')
  const card = page.locator('tr').filter({ hasText: bannerTitle })
  await card.getByRole('button', { name: '预览' }).click()
  await expect(screen(dialog(page)).locator('.banner-title')).toHaveText(bannerTitle)
})

test('on a phone the form and the preview take turns', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page)
  await page.goto('./#/courses')
  await lessonRow(page).getByRole('button', { name: '编辑' }).click()
  const d = editPage(page)
  await expect(screen(d)).toHaveCount(0)
  await field(d, '名称').locator('input').fill(`${lessonName}改`)
  await d.locator('.editor-preview-switch').getByText('预览').click()
  await expect(screen(d).locator('[data-preview-focus]')).toContainText(`${lessonName}改`)
  await expect(field(d, '名称')).toBeHidden()
  // The phone fits the screen's width.
  const box = await d.locator('.mp-phone').boundingBox()
  expect(box?.width).toBeLessThanOrEqual(390)
  await both(page, 'phone-preview')
  await d.locator('.editor-preview-switch').getByText('编辑').click()
  await expect(field(d, '名称').locator('input')).toHaveValue(`${lessonName}改`)
})
