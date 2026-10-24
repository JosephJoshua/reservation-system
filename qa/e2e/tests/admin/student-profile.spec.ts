import { expect, test } from '@playwright/test'
import { ADMIN_PASSWORD, call, dialog, field, login, student } from './helpers'

// 学员档案 on the admin student page: filling it in, odd input, two staff editing at once, and a
// student who deleted their account.
test.describe.configure({ mode: 'serial' })

const run = Date.now().toString(36)
const studentName = `档案${run}`

let admin = ''
let studentId = 0
let token = ''

test('sets up a named student', async ({ request }) => {
  admin = (
    await call<{ token: string }>(request, 'POST', '/admin/login', undefined, {
      username: 'admin',
      password: ADMIN_PASSWORD,
    })
  ).token
  token = await student(request, `profile-${run}`)
  await call(request, 'PUT', '/me', token, { name: studentName, phone: '13700137001' })
  studentId = (await call<{ id: number }>(request, 'GET', '/me', token)).id
})

test('fills in the profile, keeping a tag typed without Enter', async ({ page, request }) => {
  await login(page)
  await page.goto(`./#/students?id=${studentId}`)
  const card = page.locator('.t-card').filter({ hasText: '学员档案' })
  await expect(card).toContainText('还没有填写水平、握拍、标签和备注')
  await expect(card).toContainText('已在本馆上课 0 次')

  await card.getByRole('button', { name: '编辑' }).click()
  const d = dialog(page)
  await field(d, '水平').getByText('中级').click()
  await field(d, '握拍').getByText('直拍').click()
  await field(d, '标签').locator('.t-tag-input').click()
  await page.keyboard.type('反手弱')
  await page.keyboard.press('Enter')
  await page.keyboard.type('反手弱')
  await page.keyboard.press('Enter')
  // Too long: kept as typed and refused, not cut short.
  await page.keyboard.type('一二三四五六七八九十十一')
  await field(d, '备注').locator('textarea').fill('反手推挡偏慢\n多练步法')
  await d.getByRole('button', { name: '保存' }).click()
  await expect(page.getByText('每个标签不超过 10 个字')).toBeVisible()
  await expect(d).toHaveCount(1)
  // Removing a tag keeps text that is still being typed.
  await field(d, '标签').locator('.t-tag-input').click()
  await page.keyboard.type('比赛型')
  await field(d, '标签').locator('.t-tag').last().locator('.t-tag__icon-close').click()
  // A double click saves once.
  await d.getByRole('button', { name: '保存' }).dblclick()
  await expect(d).toHaveCount(0)

  await expect(card).toContainText('中级')
  await expect(card).toContainText('直拍')
  await expect(card.locator('.t-tag')).toHaveText(['中级', '直拍', '反手弱', '比赛型'])
  await expect(card.locator('.profile-note')).toHaveText('反手推挡偏慢\n多练步法')

  const log = await call<{ summary: string }[]>(
    request,
    'GET',
    `/admin/actions?actions=student.update&studentId=${studentId}`,
    admin,
  )
  expect(log.map((e) => e.summary)).toEqual(['修改档案：水平、握拍、标签、备注'])
  expect(JSON.stringify(log)).not.toContain('反手推挡偏慢')
})

test('refuses a save on top of another staff member’s change', async ({ page, browser }) => {
  await login(page)
  await page.goto(`./#/students?id=${studentId}`)
  const other = await browser.newPage()
  await login(other)
  await other.goto(`./#/students?id=${studentId}`)

  const card = page.locator('.t-card').filter({ hasText: '学员档案' })
  const otherCard = other.locator('.t-card').filter({ hasText: '学员档案' })
  await card.getByRole('button', { name: '编辑' }).click()
  await otherCard.getByRole('button', { name: '编辑' }).click()

  await field(dialog(page), '备注').locator('textarea').fill('第一位员工')
  await dialog(page).getByRole('button', { name: '保存' }).click()
  await expect(dialog(page)).toHaveCount(0)

  await field(dialog(other), '水平').getByText('高级').click()
  await dialog(other).getByRole('button', { name: '保存' }).click()
  await expect(other.getByText('已被其他人修改，请刷新后再改')).toBeVisible()
  // The dialog closes and the page shows what was saved.
  await expect(dialog(other)).toHaveCount(0)
  await expect(otherCard.locator('.profile-note')).toHaveText('第一位员工')
  await expect(otherCard).toContainText('中级')
  await other.close()
})

test('clears with the account and cannot be edited afterwards', async ({ page, request }) => {
  await call(request, 'DELETE', '/me', token)
  await login(page)
  await page.goto(`./#/students?id=${studentId}`)
  await expect(page.getByText('姓名、手机号、学员档案和微信身份都已清除')).toBeVisible()
  const card = page.locator('.t-card').filter({ hasText: '学员档案' })
  await expect(card).toContainText('已在本馆上课 0 次')
  await expect(card.locator('.t-tag')).toHaveCount(0)
  await expect(card.getByRole('button', { name: '编辑' })).toHaveCount(0)
})
