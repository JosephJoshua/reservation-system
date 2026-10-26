import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { ADMIN_PASSWORD, call, editForm, field, login, saveEdit, tab } from './helpers'

// 课程 and 教练 on their own pages, and every record of them, 课时包 and 轮播图 edited on a page.
test.describe.configure({ mode: 'serial' })

const run = Date.now().toString(36)
const lessonName = `页面课${run}`
const coachName = `页面教练${run}`
const shots = join(import.meta.dirname, '../../test-results/edit-pages')
let lessonId = 0
let coachId = 0

const bar = (page: Page) => page.getByRole('region', { name: '保存修改' })

async function both(page: Page, name: string) {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForTimeout(200)
    await page.screenshot({ path: `${shots}/${name}-${scheme}.png` })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

test('sets up a lesson and a coach', async ({ request }) => {
  const { token } = await call<{ token: string }>(request, 'POST', '/admin/login', undefined, {
    username: 'admin',
    password: ADMIN_PASSWORD,
  })
  lessonId = (
    await call<{ id: number }>(request, 'POST', '/admin/lesson-types', token, {
      name: lessonName,
      durationMinutes: 60,
      price: 20000,
    })
  ).id
  coachId = (
    await call<{ id: number }>(request, 'POST', '/admin/coaches', token, {
      name: coachName,
      lessonTypeIds: [lessonId],
    })
  ).id
})

test('an old 课程与教练 link opens 课程, and the menu lists 课程 and 教练', async ({ page }) => {
  await login(page)
  await page.goto('./#/catalog')
  await expect(page).toHaveURL(/#\/courses$/)
  await expect(page.locator('.admin-title-text')).toHaveText('课程')
  const menu = page.getByRole('navigation', { name: '主菜单' })
  await expect(menu.getByRole('link', { name: '课程', exact: true })).toBeVisible()
  await menu.getByRole('link', { name: '教练', exact: true }).click()
  await expect(page.locator('.admin-title-text')).toHaveText('教练')
  await tab(page, '教练类别').click()
  await expect(page).toHaveURL(/#\/coaches\?tab=categories$/)
  await expect(page.getByRole('button', { name: '新建类别' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('button', { name: '新建类别' })).toBeVisible()
})

test('a coach opens on its own page and saves back to the list', async ({ page }) => {
  await login(page)
  await page.goto('./#/coaches')
  await page.getByRole('link', { name: coachName }).click()
  await expect(page).toHaveURL(new RegExp(`#/coaches/${coachId}$`))
  await expect(page.locator('.breadcrumb')).toContainText(`教练/${coachName}`)
  await expect(page.getByRole('button', { name: '排班' })).toBeVisible()
  // Opened without a change, there is nothing to save.
  await expect(bar(page)).toHaveCount(0)
  await field(editForm(page), '头衔').locator('input').fill('一级教练')
  await expect(bar(page)).toBeVisible()
  await both(page, 'coach')
  // ⌘S saves.
  await page.keyboard.press('ControlOrMeta+s')
  await expect(page.locator('.edit-page')).toHaveCount(0)
  await expect(page).toHaveURL(/#\/coaches$/)
  await page.getByRole('link', { name: coachName }).click()
  await expect(field(editForm(page), '头衔').locator('input')).toHaveValue('一级教练')
})

test('leaving an edited coach asks first, and 撤销修改 puts the form back', async ({ page }) => {
  await login(page)
  await page.goto(`./#/coaches/${coachId}`)
  const title = field(editForm(page), '头衔').locator('input')
  await title.fill('改了没保存')
  await page.locator('.breadcrumb').getByRole('link', { name: '教练' }).click()
  await expect(page.getByText('放弃未保存的修改？')).toBeVisible()
  await page.getByRole('button', { name: '继续编辑' }).click()
  await expect(title).toHaveValue('改了没保存')
  await bar(page).getByRole('button', { name: '撤销修改' }).click()
  await expect(title).toHaveValue('一级教练')
  await expect(bar(page)).toHaveCount(0)
  await page.locator('.breadcrumb').getByRole('link', { name: '教练' }).click()
  await expect(page.getByText('放弃未保存的修改？')).toHaveCount(0)
  await expect(page).toHaveURL(/#\/coaches$/)
})

test('a new course needs a name, and lands in the list once saved', async ({ page }) => {
  await login(page)
  await page.goto('./#/courses')
  await page.getByRole('button', { name: '新建课程' }).click()
  await expect(page).toHaveURL(/#\/courses\/new$/)
  await expect(page.locator('.detail-title')).toHaveText('新建课程')
  const name = field(editForm(page), '名称').locator('input')
  await name.fill('  ')
  await bar(page).getByRole('button', { name: '保存' }).click()
  await expect(page.locator('.t-message', { hasText: '请填写课程名称' })).toBeVisible()
  await name.fill(`新课${run}`)
  await expect(page.locator('.detail-title')).toHaveText(`新课${run}`)
  // A double click saves one course.
  await bar(page).getByRole('button', { name: '保存' }).dblclick()
  await expect(page.locator('.edit-page')).toHaveCount(0)
  await expect(page.getByRole('row').filter({ hasText: `新课${run}` })).toHaveCount(1)
})

test('J and K open a course from the list', async ({ page }) => {
  await login(page)
  await page.goto('./#/courses')
  await expect(page.getByRole('link', { name: lessonName })).toBeVisible()
  const rows = page.locator('.t-table tbody tr')
  const index = await rows.evaluateAll(
    (trs, name) => trs.findIndex((tr) => tr.textContent?.includes(name)),
    lessonName,
  )
  for (let i = 0; i <= index; i++) await page.keyboard.press('j')
  await expect(page.locator('tr.row-cursor')).toContainText(lessonName)
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`#/courses/${lessonId}$`))
})

test('a coach goes off duty from the list at once and 撤销 puts them back', async ({ page }) => {
  await login(page)
  await page.goto('./#/coaches')
  const onDuty = page.locator('tr', { hasText: coachName }).getByRole('switch')
  await expect(onDuty).toHaveAttribute('aria-checked', 'true')
  await onDuty.click()
  const message = page.locator('.t-message', { hasText: `已停用：${coachName}` })
  await expect(message).toBeVisible()
  await expect(onDuty).toHaveAttribute('aria-checked', 'false')
  await message.getByRole('button', { name: '撤销' }).click()
  await expect(page.getByText('已撤销')).toBeVisible()
  await expect(onDuty).toHaveAttribute('aria-checked', 'true')
})

test('a course is switched off from the list and back with 撤销', async ({ page }) => {
  await login(page)
  await page.goto('./#/courses')
  const active = page.locator('tr', { hasText: lessonName }).getByRole('switch')
  await active.click()
  const message = page.locator('.t-message', { hasText: `已停用：${lessonName}` })
  await expect(message).toBeVisible()
  await message.getByRole('button', { name: '撤销' }).click()
  await expect(page.getByText('已撤销')).toBeVisible()
  await expect(active).toHaveAttribute('aria-checked', 'true')
})

test('a record that is not there says so', async ({ page }) => {
  await login(page)
  await page.goto('./#/coaches/999999')
  await expect(page.getByText('没有找到这个教练，可能已被删除')).toBeVisible()
  await page.goto('./#/products/999999')
  await expect(page.getByText('没有找到这个课时包，可能已被删除')).toBeVisible()
  await page.goto('./#/banners/999999')
  await expect(page.getByText('没有找到这个轮播图，可能已被删除')).toBeVisible()
})

test('on a phone the edit page fits the screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page)
  await page.goto(`./#/coaches/${coachId}`)
  await field(editForm(page), '头衔').locator('input').fill('手机上改')
  await expect(bar(page)).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
  await both(page, 'coach-phone')
  await saveEdit(page)
})
