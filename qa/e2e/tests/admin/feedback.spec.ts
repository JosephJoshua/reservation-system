import { createRequire } from 'node:module'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import type { BookingDto, CoachLoginResponse, CreateBookingResponse } from '@rs/shared'
import { venueDateKey, venueInstant } from '@rs/shared'
import { ADMIN_PASSWORD, API, addExtraTimes, call, listFilter, login, student } from './helpers'

// 课后点评 as the venue sees it: the list, photos, hiding and the action log entry.

test.describe.configure({ mode: 'serial' })

const run = Date.now().toString(36)
const coachName = `点评教练${run}`
const studentName = `点评${run}`
const text = `正手进步很大，下次练反手拉球。${run}`
const shots = join(import.meta.dirname, '../../test-results/feedback-shots')
const day = venueDateKey(new Date(Date.now() + 8 * 86_400_000))
// A tiny valid PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

let studentToken = ''
let coachToken = ''
let bookingId = 0

/** Moves a booked lesson to the last two hours, so attendance and feedback are open. */
function moveIntoPast(id: number) {
  const require = createRequire(join(import.meta.dirname, '../../../../apps/api/package.json'))
  const Database = require('better-sqlite3')
  const db = new Database(join(import.meta.dirname, '../../../../apps/api/data/e2e.db'))
  const start = Date.now() - 2 * 3_600_000
  const end = Date.now() - 3_600_000
  db.prepare('update bookings set starts_at = ?, ends_at = ? where id = ?').run(start, end, id)
  db.prepare(
    'update slots set starts_at = ?, ends_at = ? where id = (select slot_id from bookings where id = ?)',
  ).run(start, end, id)
  db.close()
}

async function both(page: Page, name: string) {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.screenshot({ path: `${shots}/${name}-light.png`, fullPage: true })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForTimeout(200)
  await page.screenshot({ path: `${shots}/${name}-dark.png`, fullPage: true })
  await page.emulateMedia({ colorScheme: 'light' })
}

test('a coach writes feedback with a photo through the API', async ({ request }) => {
  const admin = (
    await call<{ token: string }>(request, 'POST', '/admin/login', undefined, {
      username: 'admin',
      password: ADMIN_PASSWORD,
    })
  ).token
  const lesson = await call<{ id: number }>(request, 'POST', '/admin/lesson-types', admin, {
    name: `点评课${run}`,
    durationMinutes: 60,
    price: 20000,
  })
  const coach = await call<{ id: number }>(request, 'POST', '/admin/coaches', admin, {
    name: coachName,
    lessonTypeIds: [lesson.id],
  })
  const startsAt = venueInstant(day, 10 * 60).toISOString()
  await addExtraTimes(request, admin, coach.id, [
    { startsAt, endsAt: venueInstant(day, 11 * 60).toISOString() },
  ])
  const { code } = await call<{ code: string }>(
    request,
    'POST',
    `/admin/coaches/${coach.id}/bind-code`,
    admin,
    {},
  )
  coachToken = (
    await call<CoachLoginResponse>(request, 'POST', '/coach/bind', undefined, {
      code: `dev:feedback-coach-${run}`,
      bindCode: code,
    })
  ).token
  studentToken = await student(request, `feedback-${run}`)
  await call(request, 'PUT', '/me', studentToken, { name: studentName, phone: '13800000004' })
  const booked = await call<CreateBookingResponse>(request, 'POST', '/bookings', studentToken, {
    coachId: coach.id,
    startsAt,
    lessonTypeId: lesson.id,
  })
  await call(request, 'POST', `/dev/fake-pay/${booked.orderId}`)
  bookingId = booked.bookingId
  moveIntoPast(bookingId)
  await call(request, 'PUT', `/coach/lessons/${bookingId}/attendance`, coachToken, {
    attendance: 'attended',
  })
  const uploaded = await request.post(`${API}/coach/lessons/${bookingId}/photos`, {
    headers: { Authorization: `Bearer ${coachToken}` },
    multipart: { file: { name: 'a.png', mimeType: 'image/png', buffer: PNG } },
  })
  expect(uploaded.status()).toBe(201)
  const { url } = await uploaded.json()
  await call(request, 'PUT', `/coach/lessons/${bookingId}/feedback`, coachToken, {
    text,
    photos: [url],
  })
  const seen = await call<BookingDto>(request, 'GET', `/bookings/${bookingId}`, studentToken)
  expect(seen.feedback).toMatchObject({ text, photos: [url] })
})

test('lists the feedback and hides it from the student', async ({ page, request }) => {
  await login(page)
  await page.goto('./#/feedback')
  await listFilter(page.locator('.t-tab-panel:visible'), '教练').click()
  await page.locator('.t-select-option', { hasText: coachName }).click()
  const row = page.locator('.t-tab-panel:visible').getByRole('row').filter({ hasText: studentName })
  await expect(row).toHaveCount(1)
  await expect(row).toContainText(text)
  await expect(row).toContainText('学员可见')
  await expect(row.locator('.feedback-photos img')).toHaveCount(1)
  await expect
    .poll(() =>
      row.locator('.feedback-photos img').evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBe(1)
  await both(page, 'feedback')

  // A double click hides it once.
  await row.getByRole('button', { name: '隐藏' }).dblclick()
  await expect(row).toContainText('已隐藏')
  const hidden = await call<BookingDto>(request, 'GET', `/bookings/${bookingId}`, studentToken)
  expect(hidden.feedback).toBeNull()

  await row.getByRole('button', { name: '恢复' }).click()
  await expect(row).toContainText('学员可见')
  const back = await call<BookingDto>(request, 'GET', `/bookings/${bookingId}`, studentToken)
  expect(back.feedback?.text).toBe(text)
})

test('logs hiding and showing once each', async ({ page }) => {
  await login(page)
  await page.goto('./#/actions')
  const rows = page.getByRole('row').filter({ hasText: coachName })
  await expect(rows.filter({ hasText: '隐藏点评' })).toHaveCount(1)
  await expect(rows.filter({ hasText: '恢复点评' })).toHaveCount(1)
  await expect(rows.first()).toContainText(studentName)
})

test('reads well on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page)
  await page.goto('./#/feedback')
  await expect(page.getByText(text)).toBeVisible()
  await both(page, 'feedback-phone')
})

test('shows hidden feedback the coach then deleted, with nothing to restore', async ({
  page,
  request,
}) => {
  await login(page)
  await page.goto('./#/feedback')
  await listFilter(page.locator('.t-tab-panel:visible'), '教练').click()
  await page.locator('.t-select-option', { hasText: coachName }).click()
  const row = page.locator('.t-tab-panel:visible').getByRole('row').filter({ hasText: studentName })
  await row.getByRole('button', { name: '隐藏' }).click()
  await expect(row).toContainText('已隐藏')
  // Hiding takes effect at once; 撤销 in the message shows it again.
  await page
    .locator('.t-message', { hasText: '已隐藏，学员看不到这条点评' })
    .getByRole('button', { name: '撤销' })
    .click()
  await expect(page.getByText('已撤销')).toBeVisible()
  await expect(row).not.toContainText('已隐藏')
  await row.getByRole('button', { name: '隐藏' }).click()
  await expect(row).toContainText('已隐藏')
  await call(request, 'DELETE', `/coach/lessons/${bookingId}/feedback`, coachToken)
  await page.reload()
  await listFilter(page.locator('.t-tab-panel:visible'), '教练').click()
  await page.locator('.t-select-option', { hasText: coachName }).click()
  await expect(row).toContainText('教练已删除')
  await expect(row).not.toContainText(text)
  await expect(row.getByRole('button')).toHaveCount(0)
  await both(page, 'feedback-deleted')
})
