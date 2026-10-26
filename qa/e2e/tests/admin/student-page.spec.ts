import { expect, type Page, test } from '@playwright/test'
import { ADMIN_PASSWORD, call, login, student } from './helpers'

// 学员详情: a page per student with tabs, reached from the list, the drawer and 今日, and the
// overview's 今日课程 that sends 签到 to 今日.
test.describe.configure({ mode: 'serial' })

const run = Date.now().toString(36)
const studentName = `详情${run}`
const password = 'page-pass-1'
const desk = { name: `详情前台${run}`, username: `pdesk${run}` }
let studentId = 0

const tab = (page: Page, name: string) => page.locator('.t-tabs__nav-item', { hasText: name })
const activeTab = (page: Page) => page.locator('.t-tabs__nav-item.t-is-active')

test('sets up a student and a 前台 login', async ({ request }) => {
  const admin = (
    await call<{ token: string }>(request, 'POST', '/admin/login', undefined, {
      username: 'admin',
      password: ADMIN_PASSWORD,
    })
  ).token
  await call(request, 'POST', '/admin/staff', admin, { ...desk, password, roles: ['front_desk'] })
  const token = await student(request, `page-${run}`)
  studentId = (
    await call<{ id: number }>(request, 'PUT', '/me', token, {
      name: studentName,
      phone: '13900000031',
    })
  ).id
})

test('opens from the list, keeps its tab in the address and goes back to the search', async ({
  page,
}) => {
  await login(page)
  await page.goto('./#/students')
  await page.getByPlaceholder('姓名、手机号或编号', { exact: true }).fill(studentName)
  await page.getByRole('link', { name: studentName }).click()
  await expect(page).toHaveURL(new RegExp(`#/students/${studentId}$`))
  await expect(page.locator('.detail-title')).toContainText(studentName)
  await expect(page.locator('.detail-title')).toContainText(`编号 ${studentId}`)
  await expect(activeTab(page)).toHaveText('概况')
  await expect(page.locator('.t-card', { hasText: '学员档案' })).toBeVisible()
  await expect(page.locator('.t-card', { hasText: '已上课' })).toContainText('0 节')
  await expect(page.locator('.t-card', { hasText: '已上课' })).toContainText('没有缺席')

  await tab(page, '订单').click()
  await expect(page).toHaveURL(new RegExp(`#/students/${studentId}\\?tab=orders$`))
  await expect(page.getByText('还没有订单')).toBeVisible()
  await page.reload()
  await expect(activeTab(page)).toHaveText('订单')

  await tab(page, '课后点评').click()
  await expect(page.getByText('还没有课后点评')).toBeVisible()
  await tab(page, '课时包').click()
  await expect(page.getByText('没有课时包')).toBeVisible()

  // The list comes back with the search it had.
  await page.locator('.breadcrumb').getByRole('link', { name: '学员' }).click()
  await expect(page.getByPlaceholder('姓名、手机号或编号', { exact: true })).toHaveValue(
    studentName,
  )
  await expect(page.getByRole('link', { name: studentName })).toBeVisible()

  // Coming to 学员 from the menu later opens the plain list.
  await page.locator('.admin-aside').getByRole('link', { name: '今日' }).click()
  await page.locator('.admin-aside').getByRole('link', { name: '学员', exact: true }).click()
  await expect(page.getByPlaceholder('姓名、手机号或编号', { exact: true })).toHaveValue('')
})

test('the drawer opens the full page', async ({ page }) => {
  await login(page)
  await page.goto(`./#/students?id=${studentId}`)
  await page.locator('.t-drawer').getByRole('link', { name: '打开详情' }).click()
  await expect(page).toHaveURL(new RegExp(`#/students/${studentId}$`))
  await expect(page.locator('.t-drawer:visible')).toHaveCount(0)
  await expect(page.locator('.detail-title')).toContainText(studentName)
})

test('前台 sees no 订单 tab, and a link to it opens 概况', async ({ page }) => {
  await login(page, desk.username, password)
  await page.goto(`./#/students/${studentId}?tab=orders`)
  await expect(page.locator('.detail-title')).toContainText(studentName)
  await expect(tab(page, '订单')).toHaveCount(0)
  await expect(activeTab(page)).toHaveText('概况')
  await expect(page).toHaveURL(new RegExp(`#/students/${studentId}$`))
})

test('an unknown student says so', async ({ page }) => {
  await login(page)
  await page.goto('./#/students/99999999')
  await expect(page.getByText('学员不存在')).toBeVisible()
  await expect(page.locator('.breadcrumb').getByRole('link', { name: '学员' })).toBeVisible()
})

test('今日 adds a student at the desk and opens their page', async ({ page }) => {
  await login(page)
  await page.goto('./#/checkin')
  await expect(page.getByRole('button', { name: '代约' })).toBeVisible()
  await page.getByRole('button', { name: '前台建档' }).click()
  const d = page.locator('.t-dialog:visible')
  await d.getByPlaceholder('上课学员姓名').fill(`散客${run}`)
  await d.getByPlaceholder('11 位手机号').fill(`139${String(Date.now()).slice(-8)}`)
  await d.getByRole('button', { name: '建档' }).click()
  await expect(page).toHaveURL(/#\/students\/\d+$/)
  await expect(page.locator('.detail-title')).toContainText(`散客${run}`)
})

test('the menu calls the front desk page 今日', async ({ page }) => {
  await login(page)
  await expect(page.locator('.admin-aside').getByRole('link', { name: '今日' })).toBeVisible()
  await expect(page.locator('.admin-aside').getByText('前台签到')).toHaveCount(0)
})
