import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import type { CatalogDto, CoachDetailDto } from '@rs/shared'
import { ADMIN_PASSWORD, call, dialog, field, login, student, typeNumber } from './helpers'

// Coach categories set prices; the coach profile is tags plus rich text.
test.describe.configure({ mode: 'serial' })

const run = Date.now().toString(36)
const lessonName = `私教${run}`
const categoryName = `主教${run.slice(-4)}`
const coachName = `教练${run}`
const shots = join(import.meta.dirname, '../../test-results/coach-profile-shots')
// A 2x2 PNG, enough for an upload.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==',
  'base64',
)

/** Light and dark screenshots: the viewport while a dialog is open, else the whole page. */
async function both(page: Page, name: string) {
  const fullPage = (await dialog(page).count()) === 0
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForTimeout(200)
    await page.screenshot({ path: `${shots}/${name}-${scheme}.png`, fullPage })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

/** Rows of the 教练类别 and 教练 tables, which mention each other's names. */
const categoryRow = (page: Page) =>
  page
    .locator('.t-card')
    .filter({ hasText: '新建类别' })
    .getByRole('row')
    .filter({ hasText: categoryName })
const coachRow = (page: Page) =>
  page
    .locator('.t-card')
    .filter({ hasText: '新建教练' })
    .getByRole('row')
    .filter({ hasText: coachName })

let lessonTypeId = 0
let coachId = 0

test('creates a category with its own price for a lesson', async ({ page, request }) => {
  const admin = (
    await call<{ token: string }>(request, 'POST', '/admin/login', undefined, {
      password: ADMIN_PASSWORD,
    })
  ).token
  lessonTypeId = (
    await call<{ id: number }>(request, 'POST', '/admin/lesson-types', admin, {
      name: lessonName,
      durationMinutes: 60,
      price: 20000,
    })
  ).id

  await login(page)
  await page.goto('./#/catalog')
  await page.getByRole('button', { name: '新建类别' }).click()
  await field(dialog(page), '名称').locator('input').fill(categoryName)
  const row = field(dialog(page), '价格')
    .locator('.t-space-item > .t-space')
    .filter({ hasText: lessonName })
  await expect(row).toContainText('标准价 ¥200')
  await row.getByText('单独定价').click()
  await typeNumber(row.locator('input.t-input__inner'), '360')
  await both(page, 'category-dialog')
  await dialog(page).getByRole('button', { name: '保存' }).click()
  await expect(page.locator('.t-message')).toContainText('已保存')
  await expect(categoryRow(page)).toContainText(`${lessonName} ¥360`)
})

test('creates a coach with photo, category, tags and a rich profile', async ({ page }) => {
  await login(page)
  await page.goto('./#/catalog')
  await page.getByRole('button', { name: '新建教练' }).click()
  const d = dialog(page)
  await field(d, '姓名').locator('input').fill(coachName)
  await field(d, '照片')
    .locator('input[type=file]')
    .setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: png })
  await expect(field(d, '照片').locator('img')).toBeVisible()
  await field(d, '类别').locator('.t-select').click()
  await page.locator('.t-select-option').filter({ hasText: categoryName }).click()
  await field(d, '头衔').locator('input').fill('前省队队员')

  // Tags: duplicates collapse, long ones are cut to 10 characters, and at most 6 fit.
  const tagInput = field(d, '擅长').locator('input')
  for (const tag of [
    '弧圈球',
    '弧圈球',
    '一二三四五六七八九十多',
    '步法',
    '发球',
    '青少年',
    '比赛',
    '多余',
  ])
    await tagInput.fill(tag).then(() => tagInput.press('Enter'))
  const tags = field(d, '擅长').locator('.t-tag')
  await expect(tags).toHaveText([
    '弧圈球',
    '一二三四五六七八九十',
    '步法',
    '发球',
    '青少年',
    '比赛',
  ])

  const lesson = field(d, '所教课程').locator('.t-space').filter({ hasText: lessonName }).last()
  await lesson.getByText(lessonName).click()
  await expect(lesson).toContainText('¥360')

  const editor = field(d, '介绍').locator('.tiptap')
  await editor.click()
  await field(d, '介绍').getByRole('button', { name: '小标题' }).click()
  await page.keyboard.type('比赛成绩')
  await page.keyboard.press('Enter')
  await field(d, '介绍').getByRole('button', { name: '列表' }).click()
  await page.keyboard.type('省运会男团冠军')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await field(d, '介绍').getByRole('button', { name: '加粗' }).click()
  await page.keyboard.type('重视基本功')
  await field(d, '介绍').getByRole('button', { name: '加粗' }).click()
  await page.keyboard.type(' <script>alert(1)</script>')
  await field(d, '介绍')
    .locator('input[type=file]')
    .setInputFiles({ name: 'b.png', mimeType: 'image/png', buffer: png })
  await expect(editor.locator('img')).toHaveCount(1)
  await both(page, 'coach-dialog')

  await d.getByRole('button', { name: '保存' }).click()
  await expect(page.locator('.t-message')).toContainText('已保存')
  const row = coachRow(page)
  await expect(row).toContainText(categoryName)
  await expect(row).toContainText(`${lessonName} ¥360`)
  await expect(row.locator('img')).toBeVisible()
  await both(page, 'catalog')
})

test('shows the category, tags, price and cleaned profile to students', async ({ request }) => {
  const t = await student(request, `profile-${run}`)
  const catalog = await call<CatalogDto>(request, 'GET', '/catalog', t)
  const coach = catalog.coaches.find((c) => c.name === coachName)
  expect(coach).toMatchObject({ category: categoryName, title: '前省队队员' })
  expect(coach?.tags).toHaveLength(6)
  expect(coach?.lessons).toEqual([{ lessonTypeId, price: { price: 36000, originalPrice: null } }])
  coachId = coach?.id ?? 0
  const detail = await call<CoachDetailDto>(request, 'GET', `/coaches/${coachId}`, t)
  expect(detail.profile).toContain('<h3>比赛成绩</h3>')
  expect(detail.profile).toContain('<ul><li><p>省运会男团冠军</p></li></ul>')
  expect(detail.profile).toContain('<strong>重视基本功</strong>')
  expect(detail.profile).toContain('&lt;script&gt;')
  expect(detail.profile).toMatch(/<img src="\/api\/uploads\/[\w.-]+\.png" \/>/)
})

test('reopens the coach with the saved profile and keeps it on save', async ({ page, request }) => {
  await login(page)
  await page.goto('./#/catalog')
  await coachRow(page).getByRole('button', { name: '编辑' }).click()
  const editor = field(dialog(page), '介绍').locator('.tiptap')
  await expect(editor.locator('h3')).toHaveText('比赛成绩')
  await expect(editor.locator('img')).toHaveCount(1)
  await dialog(page).getByRole('button', { name: '保存' }).click()
  await expect(page.locator('.t-message')).toContainText('已保存')
  const t = await student(request, `profile-${run}`)
  const detail = await call<CoachDetailDto>(request, 'GET', `/coaches/${coachId}`, t)
  expect(detail.profile).toContain('<h3>比赛成绩</h3>')
})

test('keeps edits made while a photo uploads and ignores one that lands after closing', async ({
  page,
  request,
}) => {
  await login(page)
  await page.route('**/api/admin/uploads', async (route) => {
    await new Promise((r) => setTimeout(r, 800))
    await route.continue()
  })
  await page.goto('./#/catalog')
  await coachRow(page).getByRole('button', { name: '编辑' }).click()
  const d = dialog(page)
  const photo = field(d, '照片').locator('input[type=file]')
  await photo.setInputFiles({ name: 'c.png', mimeType: 'image/png', buffer: png })
  await field(d, '头衔').locator('input').fill('省队退役')
  await expect(field(d, '照片').locator('img')).toHaveAttribute('src', /\/api\/uploads\//)
  await expect(field(d, '头衔').locator('input')).toHaveValue('省队退役')
  await d.getByRole('button', { name: '保存' }).click()
  await expect(page.locator('.t-message')).toContainText('已保存')
  const t = await student(request, `upload-${run}`)
  const detail = await call<CoachDetailDto>(request, 'GET', `/coaches/${coachId}`, t)
  expect(detail.title).toBe('省队退役')

  await coachRow(page).getByRole('button', { name: '编辑' }).click()
  await photo.setInputFiles({ name: 'd.png', mimeType: 'image/png', buffer: png })
  await d.getByRole('button', { name: '取消' }).click()
  await page.waitForTimeout(1200)
  await expect(dialog(page)).toHaveCount(0)
})

test('saves a new category once on a double click', async ({ page }) => {
  await login(page)
  await page.goto('./#/catalog')
  await page.getByRole('button', { name: '新建类别' }).click()
  const name = `双击${run.slice(-4)}`
  await field(dialog(page), '名称').locator('input').fill(name)
  await dialog(page).getByRole('button', { name: '保存' }).dblclick()
  await expect(page.locator('.t-message')).toContainText('已保存')
  const rows = page.locator('.t-card').filter({ hasText: '新建类别' }).getByRole('row')
  await expect(rows.filter({ hasText: name })).toHaveCount(1)
})

test('refuses to delete a category that has coaches', async ({ page }) => {
  await login(page)
  await page.goto('./#/catalog')
  await categoryRow(page).getByRole('button', { name: '删除' }).click()
  await page.locator('.t-popconfirm').getByRole('button', { name: '确定' }).click()
  await expect(page.locator('.t-message')).toContainText('还有教练属于该类别')
  await expect(categoryRow(page)).toBeVisible()
})

test("adds a whole category's coaches to a package", async ({ page }) => {
  await login(page)
  await page.goto('./#/products')
  await page.getByRole('button', { name: '新建课时包' }).click()
  const d = dialog(page)
  await field(d, '课程').locator('.t-select').click()
  await page.locator('.t-select-option').filter({ hasText: lessonName }).click()
  // The option list fades out over the quick-pick buttons; a click during the fade lands on it.
  await expect(page.locator('.t-select-option:visible')).toHaveCount(0)
  await field(d, '适用教练')
    .getByRole('button', { name: `添加全部${categoryName}` })
    .click()
  await expect(field(d, '适用教练').locator('.t-tag')).toHaveText([coachName])
  await both(page, 'package-quick-pick')
})
