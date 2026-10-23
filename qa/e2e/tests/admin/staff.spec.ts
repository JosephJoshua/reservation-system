import { expect, test } from '@playwright/test'
import { ADMIN_PASSWORD, call, dialog, field, login, student } from './helpers'

// Named staff logins, front-desk booking (代约) and the action log, driven through the admin app.
test.describe.configure({ mode: 'serial' })

const run = Date.now().toString(36)
const staffName = `前台${run}`
const username = `desk${run}`
const password = 'desk-pass-1'
const coachName = `代约教练${run}`
const studentName = `代约${run}`
const ADMIN_URL = 'http://localhost:5173/admin/'
// Tomorrow at the venue.
const venueDate = new Date(Date.now() + 86_400_000 + 8 * 3_600_000).toISOString().slice(0, 10)

let admin = ''
let coachId = 0

test('sets up a coach with a free slot and a named student', async ({ request }) => {
  admin = (
    await call<{ token: string }>(request, 'POST', '/admin/login', undefined, {
      username: 'admin',
      password: ADMIN_PASSWORD,
    })
  ).token
  const lessonTypeId = (
    await call<{ id: number }>(request, 'POST', '/admin/lesson-types', admin, {
      name: `代约课${run}`,
      durationMinutes: 60,
      price: 20000,
    })
  ).id
  coachId = (
    await call<{ id: number }>(request, 'POST', '/admin/coaches', admin, {
      name: coachName,
      lessons: [{ lessonTypeId, price: null }],
    })
  ).id
  await call(request, 'POST', '/admin/slots', admin, {
    slots: [
      {
        coachId,
        startsAt: `${venueDate}T10:00:00+08:00`,
        endsAt: `${venueDate}T11:00:00+08:00`,
      },
    ],
  })
  const token = await student(request, studentName)
  await call(request, 'PUT', '/me', token, { name: studentName, phone: '13700137000' })
})

test('adds a staff login that can sign in', async ({ page, browser }) => {
  await login(page)
  await page.goto('./#/staff')
  await page.getByRole('button', { name: '新增员工' }).click()
  await field(dialog(page), '姓名').locator('input').fill(staffName)
  await field(dialog(page), '登录名').locator('input').fill(username)
  await field(dialog(page), '初始密码').locator('input').fill(password)
  await dialog(page).getByRole('button', { name: '添加' }).click()
  await expect(page.getByRole('row', { name: new RegExp(staffName) })).toBeVisible()

  const desk = await (await browser.newContext({ baseURL: ADMIN_URL })).newPage()
  await login(desk, username, password)
  await expect(desk.locator('.signed-in')).toHaveText(staffName)
  await desk.close()
})

test('books a lesson for a student from the schedule', async ({ page }) => {
  await login(page, username, password)
  await page.goto('./#/schedule')
  await page.locator('.t-select').first().click()
  await page.locator('.t-select-option', { hasText: coachName }).click()
  // Tomorrow may be in next week.
  const chip = page.locator('.slot-chip', { hasText: '可预约' })
  if (
    !(await chip
      .first()
      .isVisible()
      .catch(() => false))
  ) {
    await page.getByRole('button', { name: '下一周' }).click()
  }
  await chip.first().click()
  await dialog(page).getByRole('button', { name: '代约' }).click()
  const book = dialog(page).last()
  const picker = field(book, '学员').locator('input')
  await picker.click()
  await picker.pressSequentially(studentName)
  await page.locator('.t-select-option', { hasText: studentName }).click()
  await expect(book.getByText('线下收款（标价 ¥200）')).toBeVisible()
  await book.getByRole('button', { name: '确认代约' }).dblclick()
  await expect(page.getByText('已代约')).toBeVisible()
  await expect(page.locator('.slot-chip', { hasText: studentName })).toBeVisible()

  await page.goto('./#/bookings')
  await expect(
    page.getByRole('row', { name: new RegExp(studentName) }).getByText(`${staffName} 代约`),
  ).toHaveCount(1)
})

test('shows who did it in the action log', async ({ page }) => {
  await login(page)
  await page.goto('./#/actions')
  const row = page.getByRole('row').filter({ hasText: coachName }).filter({ hasText: '线下收款' })
  await expect(row).toHaveCount(1)
  await expect(row).toContainText(staffName)
  await expect(row).toContainText('代约')
  await expect(row).toContainText('线下收款 ¥200')
  await expect(row).toContainText(studentName)
})

test('locks out a deactivated login at once', async ({ page, browser }) => {
  const desk = await (await browser.newContext({ baseURL: ADMIN_URL })).newPage()
  await login(desk, username, password)
  await login(page)
  await page.goto('./#/staff')
  await page
    .getByRole('row', { name: new RegExp(staffName) })
    .getByRole('button', { name: '停用' })
    .click()
  await dialog(page).getByRole('button', { name: '停用' }).click()
  await expect(page.locator('.t-message', { hasText: '已停用' })).toBeVisible()
  await desk.goto('./#/orders')
  await expect(desk.getByPlaceholder('登录名')).toBeVisible()
  await desk.close()
})
