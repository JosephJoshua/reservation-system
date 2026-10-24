import { expect, test } from '@playwright/test'
import type { CatalogDto, CreateBookingResponse, PackageDto, SlotDto } from '@rs/shared'
import { call, dialog, field, login, student, typeNumber } from './helpers'

// One venue setup driven through the admin UI, then used by students through the API.
test.describe.configure({ mode: 'serial' })

const run = Date.now().toString(36)
const lessonName = `私教${run}`
const coachName = `教练${run}`
const productName = `十次卡${run}`
const categoryName = `高级${run.slice(-4)}`

test('sets up a lesson, a coach category with its own price, a package and slots', async ({
  page,
}) => {
  await login(page)

  await page.goto('./#/catalog')
  await page.getByRole('button', { name: '新建课程' }).click()
  await field(dialog(page), '名称').locator('input').fill(lessonName)
  await typeNumber(field(dialog(page), '标准价').locator('input'), '200')
  await dialog(page).getByRole('button', { name: '保存' }).click()
  await expect(page.getByRole('cell', { name: lessonName })).toBeVisible()

  await page.getByRole('button', { name: '新建类别' }).click()
  await field(dialog(page), '名称').locator('input').fill(categoryName)
  const price = field(dialog(page), '价格').locator('.nowrap').filter({ hasText: lessonName })
  await price.locator('.t-checkbox', { hasText: /^单独定价$/ }).click()
  await typeNumber(price.locator('.t-input-number input'), '300')
  await dialog(page).getByRole('button', { name: '保存' }).click()
  await expect(page.getByRole('cell', { name: `${lessonName} ¥300` })).toBeVisible()

  await page.getByRole('button', { name: '新建教练' }).click()
  await field(dialog(page), '姓名').locator('input').fill(coachName)
  await field(dialog(page), '类别').locator('.t-select').click()
  await page.locator('.t-select-option', { hasText: categoryName }).click()
  await dialog(page)
    .locator('.t-checkbox', { hasText: new RegExp(`^${lessonName}$`) })
    .click()
  await dialog(page).getByRole('button', { name: '保存' }).click()
  await expect(
    page
      .locator('.t-card')
      .filter({ hasText: '新建教练' })
      .getByRole('cell', { name: `${lessonName} ¥300` }),
  ).toBeVisible()

  await page.goto('./#/products')
  await page.getByRole('button', { name: '新建课时包' }).click()
  await field(dialog(page), '名称').locator('input').fill(productName)
  await field(dialog(page), '课程').locator('.t-select').click()
  await page.locator('.t-select-option', { hasText: lessonName }).click()
  await typeNumber(field(dialog(page), '价格').locator('input'), '2800')
  await dialog(page)
    .locator('.t-checkbox', { hasText: /^设置限时价$/ })
    .click()
  await typeNumber(field(dialog(page), '限时价').locator('.t-input-number input'), '2500')
  await dialog(page).getByRole('button', { name: '保存' }).click()
  const row = page.getByRole('row').filter({ hasText: productName })
  await expect(row).toContainText('¥2500')
  await expect(row.locator('.strike')).toHaveText('¥2800')

  await page.goto('./#/schedule')
  await page.locator('.toolbar .t-select').click()
  await page.locator('.t-select-option', { hasText: coachName }).click()
  await page.getByRole('button', { name: '下一周' }).click()
  await page.getByRole('button', { name: '批量排课' }).click()
  await dialog(page).getByRole('button', { name: '创建 35 个时段' }).click()
  await expect(page.locator('.slot-chip')).toHaveCount(35)
})

test('shows a paid booking and refunds it in full when the venue cancels', async ({
  page,
  request,
}) => {
  const token = await student(request, `pay-${run}`)
  await call(request, 'PUT', '/me', token, { name: '王小明', phone: '13800000001' })
  const catalog = await call<CatalogDto>(request, 'GET', '/catalog', token)
  const lesson = catalog.lessonTypes.find((t) => t.name === lessonName)
  const coach = catalog.coaches.find((c) => c.name === coachName)
  if (!lesson || !coach) throw new Error('setup missing')
  expect(coach.lessons[0]?.price.price).toBe(30000)

  const date = new Date(Date.now() + 8 * 86_400_000 + 8 * 3_600_000).toISOString().slice(0, 10)
  const slots = await call<SlotDto[]>(
    request,
    'GET',
    `/slots?date=${date}&coachId=${coach.id}&lessonTypeId=${lesson.id}`,
    token,
  )
  const slot = slots.find((s) => s.available)
  if (!slot) throw new Error('no slot')
  const booking = await call<CreateBookingResponse>(request, 'POST', '/bookings', token, {
    slotId: slot.id,
    lessonTypeId: lesson.id,
  })
  expect(booking.status).toBe('pending_payment')
  await call(request, 'POST', `/dev/fake-pay/${booking.orderId}`)

  await login(page)
  await page.goto('./#/bookings')
  const row = page.getByRole('row').filter({ hasText: '王小明' }).filter({ hasText: coachName })
  await expect(row).toContainText('已预约')
  await expect(row).toContainText('¥300')

  await row.getByRole('button', { name: '取消' }).click()
  await dialog(page).locator('textarea').fill('教练临时有事')
  await dialog(page).getByRole('button', { name: '确认取消' }).click()
  await expect(row).toContainText('场馆取消')
  await expect(row).toContainText('已退款 ¥300')
})

test('records a front-desk sale and approves a package refund', async ({ page, request }) => {
  const token = await student(request, `pkg-${run}`)
  await call(request, 'PUT', '/me', token, { name: `前台${run}`, phone: '13800000002' })

  await login(page)
  await page.goto('./#/students')
  await page.getByPlaceholder('姓名或手机号').fill(`前台${run}`)
  await page.getByRole('button', { name: '搜索' }).click()
  await page.getByRole('button', { name: '查看' }).click()
  await page.getByRole('button', { name: '前台售卖' }).click()
  await field(dialog(page), '课时包').locator('.t-select').click()
  await page.locator('.t-select-option', { hasText: productName }).click()
  await typeNumber(field(dialog(page), '实收金额').locator('input'), '2400')
  await dialog(page).getByRole('button', { name: '确认收款' }).click()
  const pkgRow = page.locator('.t-drawer').getByRole('row').filter({ hasText: productName })
  await expect(pkgRow).toContainText('10/10')
  await expect(pkgRow).toContainText('¥2400')

  await pkgRow.getByRole('button', { name: '加课时' }).click()
  await dialog(page).locator('textarea').fill('补课')
  await dialog(page).getByRole('button', { name: '确认' }).click()
  await expect(pkgRow).toContainText('11/11')

  const [pkg] = await call<PackageDto[]>(request, 'GET', '/packages', token)
  await call(request, 'POST', `/packages/${pkg?.id}/refund-request`, token)

  await page.goto('./#/refunds')
  await page.reload()
  const refundRow = page.getByRole('row').filter({ hasText: `前台${run}` })
  await expect(refundRow).toContainText('建议 ¥2400')
  // The gifted lesson counts in the total.
  await expect(refundRow).toContainText('剩 11/11 节')
  await refundRow.getByRole('button', { name: '同意' }).click()
  await typeNumber(field(dialog(page), '退款金额').locator('input'), '2000')
  await expect(dialog(page)).toContainText('当面退还')
  await dialog(page).getByRole('button', { name: '确认退款' }).click()
  await expect(refundRow).toHaveCount(0)

  // Offline money waits until the desk says it was handed back.
  await page.locator('.t-select').first().click()
  await page.locator('.t-select-option', { hasText: '待提交/待退还' }).click()
  await expect(refundRow).toContainText('待线下退还')
  await refundRow.getByRole('button', { name: '已退还' }).click()
  await page.locator('.t-popconfirm').getByRole('button', { name: '已退还' }).click()
  await expect(refundRow).toHaveCount(0)

  const [after] = await call<PackageDto[]>(request, 'GET', '/packages', token)
  expect(after).toMatchObject({
    status: 'refunded',
    lessonsRemaining: 0,
    refund: { amount: 200000, status: 'succeeded' },
  })
})
