import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import type { CatalogDto, CreateBookingResponse, SlotDto } from '@rs/shared'
import { ADMIN_PASSWORD, call, dialog, field, login, student, useCrop } from './helpers'

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

test('batch scheduling sends one request on a double click and names the overlap', async ({
  page,
}) => {
  await login(page)
  await page.setViewportSize({ width: 1024, height: 700 })
  await page.goto('./#/schedule')
  await page.locator('.toolbar .t-select').click()
  await page.locator('.t-select-option', { hasText: coachName }).click()
  // The week grid scrolls on its own; the page and its header stay put.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1024)
  await expect(page.getByRole('button', { name: '退出登录' })).toBeInViewport()
  await page.screenshot({ path: `${shots}/schedule-1024.png` })

  await page.getByRole('button', { name: '下一周' }).click()
  await page.getByRole('button', { name: '批量排课' }).click()
  const creates = await countRequests(page, '/admin/slots', () =>
    dialog(page)
      .getByRole('button', { name: /^创建 \d+ 个时段$/ })
      .dblclick(),
  )
  expect(creates).toBe(1)
  await expect(dialog(page)).toHaveCount(0)

  await page.getByRole('button', { name: '批量排课' }).click()
  await dialog(page)
    .getByRole('button', { name: /^创建 \d+ 个时段$/ })
    .click()
  await expect(page.getByText(/^\d+月\d+日 09:00 与该教练已有时段重叠$/)).toBeVisible()
})

test('batch scheduling counts every day of a long range', async ({ page }) => {
  await login(page)
  await page.goto('./#/schedule')
  await page.getByRole('button', { name: '批量排课' }).click()
  await dialog(page).locator('.t-date-range-picker input').nth(1).click()
  const right = page.locator('.t-date-picker__panel-content').nth(1)
  for (let i = 0; i < 6; i++) await right.locator('.t-pagination-mini__next').click()
  await right
    .locator('.t-date-picker__cell:not(.t-date-picker__cell--additional)', { hasText: /^15$/ })
    .click()
  await dialog(page).locator('.t-dialog__header').click()
  await field(dialog(page), '开始时间').locator('input').fill('23:00')
  // Six months of days used to stop at 120 without saying so.
  const label = await dialog(page)
    .getByRole('button', { name: /^创建 \d+ 个时段$/ })
    .textContent()
  expect(Number(label?.match(/\d+/)?.[0])).toBeGreaterThan(150)
})

test('a venue cancel on a booking the student already cancelled closes and refreshes', async ({
  page,
  request,
}) => {
  const catalog = await call<CatalogDto>(request, 'GET', '/catalog', studentToken)
  const lesson = catalog.lessonTypes.find((t) => t.name === lessonName)
  if (!lesson) throw new Error('setup missing')
  // The batch above filled next week, which starts within the next 1 to 7 days.
  let open: SlotDto[] = []
  for (let day = 1; day <= 13 && open.length < 2; day++) {
    const slots = await call<SlotDto[]>(
      request,
      'GET',
      `/slots?date=${venueDate(day)}&coachId=${coachId}&lessonTypeId=${lesson.id}`,
      studentToken,
    )
    open = open.concat(slots.filter((s) => s.available))
  }
  const [first, second] = open
  if (!first || !second) throw new Error('no slots')
  const booked: CreateBookingResponse[] = []
  for (const slot of [first, second]) {
    const b = await call<CreateBookingResponse>(request, 'POST', '/bookings', studentToken, {
      slotId: slot.id,
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
    await call(request, 'POST', `/bookings/${b.bookingId}/cancel`, studentToken)
  }
  await dialog(page).getByRole('button', { name: '确认取消' }).click()
  await expect(page.getByText('该预约已取消')).toBeVisible()
  await expect(dialog(page)).toHaveCount(0)
  await expect(rows.filter({ hasText: '学员取消' })).toHaveCount(2)
})

test('a banner title typed before the image survives the upload', async ({ page }) => {
  await login(page)
  await page.goto('./#/banners')
  await page.getByRole('button', { name: '新建轮播图' }).click()
  await field(dialog(page), '标题').locator('input').fill('双十一')
  await dialog(page)
    .locator('input[type=file]')
    .setInputFiles({
      name: 'banner.png',
      mimeType: 'image/png',
      buffer: Buffer.from(PNG_1X1, 'base64'),
    })
  await useCrop(page)
  await expect(dialog(page).locator('img.banner-thumb')).toBeVisible()
  await expect(field(dialog(page), '标题').locator('input')).toHaveValue('双十一')
  await expect(dialog(page).getByRole('button', { name: '更换图片' })).toBeVisible()
})

test('a settings save from a stale tab is refused and keeps what was typed', async ({
  page,
  context,
}) => {
  await login(page)
  const other = await context.newPage()
  for (const p of [page, other]) {
    await p.goto('./#/settings')
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
  const description = (p: Page) => field(dialog(p), '简介').locator('textarea')
  for (const p of [page, other]) {
    await p.goto('./#/catalog')
    // The lesson list is the first card; coach rows mention the lesson too.
    await p
      .locator('.t-card')
      .first()
      .locator('tbody tr', { hasText: lessonName })
      .getByRole('button', { name: '编辑' })
      .click()
    await expect(description(p)).toBeVisible()
  }
  await description(page).fill(`第一个标签页${run}`)
  await dialog(page).locator('.t-dialog__confirm').click()
  await expect(page.getByText('已保存')).toBeVisible()

  await description(other).fill(`第二个标签页${run}`)
  await dialog(other).locator('.t-dialog__confirm').click()
  await expect(other.getByText('已被其他人修改，请刷新后再改')).toBeVisible()
  await expect(description(other)).toHaveValue(`第二个标签页${run}`)
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
  await page.locator('.t-select').first().click()
  await page.getByRole('listitem').filter({ hasText: coachName }).click()
  await page.getByRole('button', { name: '批量排课' }).click()
  const confirm = dialog(page).getByRole('button', { name: /创建/ })
  // Polled, since the sheet zooms in.
  await expect
    .poll(async () => {
      const box = await confirm.boundingBox()
      return box ? [box.y + box.height > 844 - 80, box.width > 120] : null
    })
    .toEqual([true, true])
})
