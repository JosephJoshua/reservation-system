import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import type { CatalogDto, CreateBookingResponse, SlotDto } from '@rs/shared'
import { ADMIN_PASSWORD, call, dialog, editForm, field, login, student, useCrop } from './helpers'

// Bugs found by exploratory QA of the admin app, each kept as a regression test.
test.describe.configure({ mode: 'serial' })

const run = Date.now().toString(36)
const lessonName = `回归课${run}`
const coachName = `回归教练${run}`
const productName = `回归卡${run}`
const studentName = `回归${run}`
const shots = join(import.meta.dirname, '../../test-results/qa-shots')
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const venueDate = (days: number) =>
  new Date(Date.now() + days * 86_400_000 + 8 * 3_600_000).toISOString().slice(0, 10)

let admin = ''
let studentToken = ''
let studentId = 0
let coachId = 0
let lessonTypeId = 0

/** Counts requests matching `part` while `fn` runs, plus a short tail for late ones. */
async function countRequests(page: Page, part: string, fn: () => Promise<void>) {
  let n = 0
  const onRequest = (r: { url(): string; method(): string }) => {
    if (r.method() !== 'GET' && r.url().includes(part)) n++
  }
  page.on('request', onRequest)
  await fn()
  await page.waitForTimeout(500)
  page.off('request', onRequest)
  return n
}

test('sets up a lesson, coach, package on sale and a student', async ({ request }) => {
  admin = (
    await call<{ token: string }>(request, 'POST', '/admin/login', undefined, {
      username: 'admin',
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
  coachId = (
    await call<{ id: number }>(request, 'POST', '/admin/coaches', admin, {
      name: coachName,
      lessonTypeIds: [lessonTypeId],
    })
  ).id
  await call(request, 'POST', '/admin/package-products', admin, {
    name: productName,
    lessonTypeId,
    lessonCount: 10,
    price: 280000,
    validityDays: 180,
    salePrice: 250000,
    saleStartsAt: new Date(Date.now() - 3_600_000).toISOString(),
    saleEndsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  })
  studentToken = await student(request, `qa-${run}`)
  const me = await call<{ id: number }>(request, 'PUT', '/me', studentToken, {
    name: studentName,
    phone: '13900000009',
  })
  studentId = me.id
})

test('a double click on 确认收款 records one sale at the running sale price', async ({
  page,
  request,
}) => {
  await login(page)
  await page.goto(`./#/students?id=${studentId}`)
  await page.getByRole('button', { name: '前台售卖' }).click()
  await field(dialog(page), '课时包').locator('.t-select').click()
  await page.locator('.t-select-option', { hasText: productName }).click()
  await expect(field(dialog(page), '实收金额').locator('input')).toHaveValue('2500.00')
  const sales = await countRequests(page, '/offline-sale', () =>
    dialog(page).getByRole('button', { name: '确认收款' }).dblclick(),
  )
  expect(sales).toBe(1)
  const detail = await call<{ packages: unknown[] }>(
    request,
    'GET',
    `/admin/students/${studentId}`,
    admin,
  )
  expect(detail.packages).toHaveLength(1)
})

test('a retry after a lost sale response records the sale once', async ({ page, request }) => {
  await login(page)
  await page.goto(`./#/students?id=${studentId}`)
  await page.getByRole('button', { name: '前台售卖' }).click()
  await field(dialog(page), '课时包').locator('.t-select').click()
  await page.locator('.t-select-option', { hasText: productName }).click()
  // The first sale reaches the server, but its answer is lost on the way back.
  let sent = 0
  await page.route('**/api/admin/packages/offline-sale', async (route) => {
    if (++sent > 1) return route.continue()
    await route.fetch()
    await route.abort('connectionreset')
  })
  await dialog(page).getByRole('button', { name: '确认收款' }).click()
  await expect(page.getByText('网络异常，请检查网络后重试')).toBeVisible()
  await dialog(page).getByRole('button', { name: '确认收款' }).click()
  await expect(page.getByText('已记录')).toBeVisible()
  expect(sent).toBe(2)
  const detail = await call<{ packages: unknown[] }>(
    request,
    'GET',
    `/admin/students/${studentId}`,
    admin,
  )
  expect(detail.packages).toHaveLength(2)
})

test('back closes a student opened from the list', async ({ page }) => {
  await login(page)
  await page.goto('./#/students')
  await page.getByPlaceholder('姓名或手机号', { exact: true }).fill(studentName)
  // The full list may still be showing until the search answers.
  await expect(page.getByRole('button', { name: '查看' })).toHaveCount(1)
  await page.getByRole('button', { name: '查看' }).click()
  await expect(page).toHaveURL(new RegExp(`#/students\\?id=${studentId}$`))
  await expect(page.locator('.t-drawer')).toContainText(studentName)
  await page.goBack()
  await expect(page.locator('.t-drawer--open')).toHaveCount(0)

  await page.goto('./#/students?id=99999999')
  await expect(page.locator('.t-drawer')).toContainText('学员不存在')
})

test('the schedule fits the screen and 排班 saves once on a double click', async ({ page }) => {
  await login(page)
  await page.setViewportSize({ width: 1024, height: 700 })
  await page.goto('./#/schedule')
  await page.getByPlaceholder('搜索教练').fill(coachName)
  // The board scrolls on its own; the page and its header stay put.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1024)
  await expect(page.getByRole('button', { name: '退出登录' })).toBeInViewport()
  await page.screenshot({ path: `${shots}/schedule-1024.png` })

  await page.goto('./#/coaches')
  await page
    .getByRole('row')
    .filter({ hasText: coachName })
    .getByRole('button', { name: '排班' })
    .click()
  for (const day of ['周一', '周二', '周三', '周四', '周五', '周六', '周日']) {
    await dialog(page)
      .locator('.week-day', { hasText: day })
      .getByRole('button', { name: '添加' })
      .click()
  }
  const saves = await countRequests(page, `/admin/coaches/${coachId}/hours`, () =>
    dialog(page).getByRole('button', { name: '保存每周时间' }).dblclick(),
  )
  expect(saves).toBe(1)
  await expect(page.locator('.t-message', { hasText: '已保存每周时间' })).toBeVisible()
})

test('a venue cancel on a booking the student already cancelled closes and refreshes', async ({
  page,
  request,
}) => {
  const catalog = await call<CatalogDto>(request, 'GET', '/catalog', studentToken)
  const lesson = catalog.lessonTypes.find((t) => t.name === lessonName)
  if (!lesson) throw new Error('setup missing')
  // 排班 above opened 09:00 to 12:00 every day from today.
  const open: { coachId: number; startsAt: string }[] = []
  // From two days out, so the student's own cancel stays free whatever the time of day.
  for (let day = 2; day <= 8 && open.length < 2; day++) {
    const slots = await call<SlotDto[]>(
      request,
      'GET',
      `/slots?date=${venueDate(day)}&coachId=${coachId}&lessonTypeId=${lesson.id}`,
      studentToken,
    )
    // One a day, so the two lessons never overlap.
    const t = slots.find((s) => s.available)
    if (t) open.push({ coachId, startsAt: t.startsAt })
  }
  const [first, second] = open
  if (!first || !second) throw new Error('no times')
  const booked: CreateBookingResponse[] = []
  for (const slot of [first, second]) {
    const b = await call<CreateBookingResponse>(request, 'POST', '/bookings', studentToken, {
      ...slot,
      lessonTypeId: lesson.id,
      payWith: 'wechat',
    })
    await call(request, 'POST', `/dev/fake-pay/${b.orderId}`)
    booked.push(b)
  }

  await login(page)
  await page.goto('./#/bookings')
  await page.locator('.toolbar .t-select').nth(1).click()
  await page.locator('.t-select-option', { hasText: coachName }).click()
  const rows = page.getByRole('row').filter({ hasText: studentName })
  await expect(rows).toHaveCount(2)

  // A reason typed and abandoned does not carry over to another booking.
  await rows.nth(0).getByRole('button', { name: '取消' }).click()
  await dialog(page).locator('textarea').fill('不要带到下一条')
  await dialog(page).getByRole('button', { name: '返回' }).click()
  await rows.nth(1).getByRole('button', { name: '取消' }).click()
  await expect(dialog(page).locator('textarea')).toHaveValue('')

  // The student cancels both while the dialog is open.
  await dialog(page).locator('textarea').fill('教练临时有事')
  for (const b of booked) {
    // The first open slot can be inside the free cancel window, depending on the time of day.
    await call(request, 'POST', `/bookings/${b.bookingId}/cancel`, studentToken, {
      acceptLate: true,
    })
  }
  await dialog(page).getByRole('button', { name: '确认取消' }).click()
  await expect(page.getByText('该预约已取消')).toBeVisible()
  await expect(dialog(page)).toHaveCount(0)
  await expect(rows.filter({ hasText: /学员(逾时)?取消/ })).toHaveCount(2)
})

test('a banner title typed before the image survives the upload', async ({ page }) => {
  await login(page)
  await page.goto('./#/banners')
  await page.getByRole('button', { name: '新建轮播图' }).click()
  await field(editForm(page), '标题').locator('input').fill('双十一')
  await editForm(page)
    .locator('input[type=file]')
    .setInputFiles({
      name: 'banner.png',
      mimeType: 'image/png',
      buffer: Buffer.from(PNG_1X1, 'base64'),
    })
  await useCrop(page)
  await expect(editForm(page).locator('img.banner-thumb')).toBeVisible()
  await expect(field(editForm(page), '标题').locator('input')).toHaveValue('双十一')
  await expect(editForm(page).getByRole('button', { name: '更换图片' })).toBeVisible()
})

test('a settings save from a stale tab is refused and keeps what was typed', async ({
  page,
  context,
}) => {
  await login(page)
  const other = await context.newPage()
  for (const p of [page, other]) {
    await p.goto('./#/banners')
    await expect(p.locator('.t-card', { hasText: '首页公告' })).toBeVisible()
  }
  const notice = (p: Page) =>
    field(p.locator('.t-card', { hasText: '首页公告' }), '公告').locator('input')
  await notice(page).fill(`第一个标签页${run}`)
  await page.locator('.save-bar').getByRole('button', { name: '保存' }).click()
  await expect(page.getByText('已保存')).toBeVisible()

  await notice(other).fill(`第二个标签页${run}`)
  await other.locator('.save-bar').getByRole('button', { name: '保存' }).click()
  await expect(other.getByText('已被其他人修改，请刷新后再改')).toBeVisible()
  await expect(notice(other)).toHaveValue(`第二个标签页${run}`)
  await page.reload()
  await expect(notice(page)).toHaveValue(`第一个标签页${run}`)
})

test('a lesson edit from a stale tab is refused and keeps what was typed', async ({
  page,
  context,
}) => {
  await login(page)
  const other = await context.newPage()
  const description = (p: Page) => field(editForm(p), '简介').locator('textarea')
  const save = (p: Page) =>
    p.getByRole('region', { name: '保存修改' }).getByRole('button', { name: '保存' }).click()
  for (const p of [page, other]) {
    await p.goto('./#/courses')
    await p
      .locator('tbody tr', { hasText: lessonName })
      .getByRole('button', { name: '编辑' })
      .click()
    await expect(description(p)).toBeVisible()
  }
  await description(page).fill(`第一个标签页${run}`)
  await save(page)
  await expect(page.getByText('已保存')).toBeVisible()

  await description(other).fill(`第二个标签页${run}`)
  await save(other)
  await expect(other.getByText('已被其他人修改，请刷新后再改')).toBeVisible()
  await expect(description(other)).toHaveValue(`第二个标签页${run}`)
  // Saving again can't go over the other change; loading it replaces what was typed.
  await save(other)
  await expect(other.getByText('课程已被其他人修改，请先载入最新内容')).toBeVisible()
  await other.getByRole('button', { name: '载入最新内容' }).click()
  await expect(description(other)).toHaveValue(`第一个标签页${run}`)
  await expect(other.getByRole('region', { name: '保存修改' })).toHaveCount(0)
})

test('an expired session says so on the login page', async ({ page }) => {
  await login(page)
  await page.evaluate(() => {
    for (const k of Object.keys(localStorage)) localStorage.setItem(k, 'expired')
  })
  await page.goto('./#/bookings')
  await expect(page.getByText('登录已过期，请重新登录')).toBeVisible()
  await page.getByPlaceholder('登录名').fill('admin')
  await page.getByPlaceholder('密码').fill(ADMIN_PASSWORD)
  await page.getByRole('button', { name: '登录' }).click()
  await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible()
  await page.getByRole('button', { name: '退出登录' }).click()
  await expect(page.getByText('登录已过期，请重新登录')).toHaveCount(0)
})

test('on a phone the menu is a drawer, lists fit the screen and dialog actions sit at the bottom', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page)
  const openMenu = page.locator('.admin-menu-drawer.t-drawer--open')
  // The second tap is on the page already shown, which must close the menu too.
  for (const item of ['预约', '预约']) {
    await page.getByRole('button', { name: '菜单' }).click()
    await expect(openMenu).toHaveCount(1)
    await openMenu.getByText(item, { exact: true }).click()
    await expect(openMenu).toHaveCount(0)
    await expect(page.locator('.admin-header')).toContainText(item)
  }
  for (const route of ['bookings', 'students', 'orders', 'schedule', 'settings']) {
    await page.goto(`./#/${route}`)
    await page.waitForLoadState('networkidle')
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  }
  await page.goto('./#/schedule')
  await page.getByRole('button', { name: '排小班课' }).click()
  const confirm = dialog(page).locator('.t-dialog__footer .t-button--theme-primary')
  // Polled, since the sheet zooms in.
  await expect
    .poll(async () => {
      const box = await confirm.boundingBox()
      return box ? [box.y + box.height > 844 - 80, box.width > 120] : null
    })
    .toEqual([true, true])
})
