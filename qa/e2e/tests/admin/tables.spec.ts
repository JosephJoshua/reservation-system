import { expect, test } from '@playwright/test'
import type { CreateBookingResponse, VenueSettings } from '@rs/shared'
import { venueDateKey, venueInstant } from '@rs/shared'
import {
  ADMIN_PASSWORD,
  addExtraTimes,
  call,
  dialog,
  field,
  login,
  pickDate,
  student,
  typeNumber,
} from './helpers'

test.describe.configure({ mode: 'serial' })

const run = Date.now().toString(36)
const lessonName = `球台课${run}`
const coachNames = [1, 2, 3, 4].map((i) => `球台教练${i}${run}`)
// Twelve days ahead at 06:00, a time no other spec books, so a limit of three is reached only here.
const day = venueDateKey(new Date(Date.now() + 12 * 86_400_000))
const at = (minute: number) => venueInstant(day, minute).toISOString()

let admin = ''

async function setTables(request: Parameters<typeof call>[0], tables: number | null) {
  const s = await call<VenueSettings>(request, 'GET', '/admin/settings', admin)
  await call(request, 'PUT', '/admin/settings', admin, { ...s, booking: { ...s.booking, tables } })
}

test.afterAll(async ({ request }) => {
  if (admin) await setTables(request, null)
})

test('sets up three lessons at once through the API', async ({ request }) => {
  admin = (
    await call<{ token: string }>(request, 'POST', '/admin/login', undefined, {
      username: 'admin',
      password: ADMIN_PASSWORD,
    })
  ).token
  await setTables(request, null)
  const lesson = await call<{ id: number }>(request, 'POST', '/admin/lesson-types', admin, {
    name: lessonName,
    durationMinutes: 60,
    price: 20000,
  })
  const coachIds: number[] = []
  for (const name of coachNames) {
    const coach = await call<{ id: number }>(request, 'POST', '/admin/coaches', admin, {
      name,
      lessonTypeIds: [lesson.id],
    })
    await addExtraTimes(request, admin, coach.id, [{ startsAt: at(6 * 60), endsAt: at(7 * 60) }])
    coachIds.push(coach.id)
  }
  for (const [i, coachId] of coachIds.slice(0, 3).entries()) {
    const token = await student(request, `tables-${i}-${run}`)
    const booked = await call<CreateBookingResponse>(request, 'POST', '/bookings', token, {
      coachId,
      startsAt: at(6 * 60),
      lessonTypeId: lesson.id,
    })
    await call(request, 'POST', `/dev/fake-pay/${booked.orderId}`, token)
  }
})

test('the table count keeps odd input in range and empty means no limit', async ({ page }) => {
  await login(page)
  await page.goto('./#/settings')
  const input = field(page, '球台数').locator('input')
  await expect(input).toHaveAttribute('placeholder', '不限')
  for (const [typed, shown] of [
    ['0', '1'],
    ['-5', '1'],
    ['2.7', '2'],
    ['150', '99'],
  ]) {
    await typeNumber(input, typed as string)
    await page.locator('.t-card__title', { hasText: '预约规则' }).click()
    await expect(input).toHaveValue(shown as string)
  }
  await input.click()
  await input.press('ControlOrMeta+a')
  await input.press('Backspace')
  await page.locator('.t-card__title', { hasText: '预约规则' }).click()
  await expect(input).toHaveValue('')

  await typeNumber(input, '3')
  await page.locator('.save-bar').getByRole('button', { name: '保存' }).click()
  await expect(page.getByText('已保存')).toBeVisible()
  await page.reload()
  await expect(input).toHaveValue('3')
  await input.scrollIntoViewIfNeeded()
  await page.screenshot({ path: 'test-results/tables-setting-light.png' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForTimeout(300)
  await page.screenshot({ path: 'test-results/tables-setting-dark.png' })
})

test('the schedule shows the tables full and 代约 offers no table', async ({ page }) => {
  await login(page)
  await page.goto('./#/schedule')
  await pickDate(page, page.locator('.toolbar .t-date-picker'), day)
  await page.getByPlaceholder('搜索教练').fill(coachNames[3] as string)
  await expect(page.locator('.board-table.full', { hasText: '3' })).toHaveCount(2)
  await expect(page.locator('.board-table[title="06:00 用了 3/3 张"]')).toHaveClass(/full/)
  await page.waitForTimeout(300)
  await page.screenshot({ path: 'test-results/tables-schedule-light.png' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForTimeout(300)
  await page.screenshot({ path: 'test-results/tables-schedule-dark.png' })
  await page.emulateMedia({ colorScheme: 'light' })

  // The fourth coach is free at 06:00, but no table is.
  const hour = await page.locator('.board-hour', { hasText: /^06:00$/ }).boundingBox()
  const row = await page
    .locator('.board-row', { hasText: coachNames[3] as string })
    .locator('.board-track')
    .boundingBox()
  if (!hour || !row) throw new Error('board not shown')
  await page.mouse.click(hour.x + 10, row.y + row.height / 2)
  const time = dialog(page).locator('.slot-picks .t-button', { hasText: '06:00' })
  await expect(time).toContainText('球台已满')
  // TDesign draws a disabled button as a div, so it has no disabled state to query.
  await expect(time).toHaveClass(/t-is-disabled/)
  await expect(time).toHaveAttribute('aria-pressed', 'false')
  await expect(dialog(page).locator('.t-dialog__footer .t-button--theme-primary')).toHaveClass(
    /t-is-disabled/,
  )
})
