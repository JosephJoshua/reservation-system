import { expect, type Page, test } from '@playwright/test'
import type { CreateBookingResponse, VenueSettings } from '@rs/shared'
import { venueDateKey, venueInstant } from '@rs/shared'
import { ADMIN_PASSWORD, call, dialog, field, login, student, typeNumber } from './helpers'

test.describe.configure({ mode: 'serial' })

const run = Date.now().toString(36)
const lessonName = `球台课${run}`
const coachNames = [1, 2, 3, 4].map((i) => `球台教练${i}${run}`)
// Twelve days ahead at 06:00, a time no other spec books, so a limit of three is reached only here.
const day = venueDateKey(new Date(Date.now() + 12 * 86_400_000))
const at = (minute: number) => venueInstant(day, minute).toISOString()

let admin = ''

/** Picks `day` in the 代约 dialog's date picker, which takes no typing. */
async function pickDay(page: Page) {
  await dialog(page).locator('.t-date-picker input').click()
  const panel = page.locator('.t-date-picker__panel:visible')
  if (day.slice(0, 7) !== venueDateKey(new Date()).slice(0, 7)) {
    await panel.locator('.t-pagination-mini__next').click()
  }
  await panel
    .locator('.t-date-picker__cell:not(.t-date-picker__cell--additional)', {
      hasText: new RegExp(`^${Number(day.slice(8))}$`),
    })
    .click()
}

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
  const slotIds: number[] = []
  for (const name of coachNames) {
    const coach = await call<{ id: number }>(request, 'POST', '/admin/coaches', admin, {
      name,
      lessonTypeIds: [lesson.id],
    })
    const { ids } = await call<{ ids: number[] }>(request, 'POST', '/admin/slots', admin, {
      slots: [{ coachId: coach.id, startsAt: at(6 * 60), endsAt: at(7 * 60) }],
    })
    slotIds.push(...ids)
  }
  for (const [i, slotId] of slotIds.slice(0, 3).entries()) {
    const token = await student(request, `tables-${i}-${run}`)
    const booked = await call<CreateBookingResponse>(request, 'POST', '/bookings', token, {
      slotId,
      lessonTypeId: lesson.id,
    })
    await call(request, 'POST', `/dev/fake-pay/${booked.orderId}`)
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
  await page.getByRole('button', { name: '保存设置' }).click()
  await expect(page.getByText('已保存')).toBeVisible()
  await page.reload()
  await expect(input).toHaveValue('3')
  await input.scrollIntoViewIfNeeded()
  await page.screenshot({ path: 'test-results/tables-setting-light.png' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForTimeout(300)
  await page.screenshot({ path: 'test-results/tables-setting-dark.png' })
})

test('the schedule shows the fourth coach full and offers no 代约', async ({ page }) => {
  await login(page)
  await page.goto('./#/schedule')
  await page.locator('.t-select').first().click()
  await page.locator('.t-select-option', { hasText: coachNames[3] }).click()
  const heading = page.locator('h4', { hasText: day.slice(5) })
  for (let i = 0; i < 3 && !(await heading.isVisible()); i++) {
    await page.getByRole('button', { name: '下一周' }).click()
    await page.waitForTimeout(300)
  }
  const chip = page.locator('.slot-chip', { hasText: '06:00-07:00' })
  await expect(chip).toContainText('球台已满')
  await chip.click()
  await expect(dialog(page)).toContainText('还没有预约，但这个时段的球台已满')
  await expect(dialog(page).getByRole('button', { name: '代约' })).toHaveCount(0)
  await page.waitForTimeout(300)
  await page.screenshot({ path: 'test-results/tables-schedule-light.png' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForTimeout(300)
  await page.screenshot({ path: 'test-results/tables-schedule-dark.png' })
})

test('the 代约 picker leaves out the full time', async ({ page }) => {
  await login(page)
  await page.goto('./#/bookings')
  await page.getByRole('button', { name: '代约', exact: true }).click()
  const picker = dialog(page)
  await picker.locator('.t-select').last().click()
  await page.locator('.t-select-option', { hasText: coachNames[3] }).click()
  await pickDay(page)
  await expect(picker.getByText('这天没有可约时段')).toBeVisible()
})
