import { expect, test } from '@playwright/test'
import type { BookingDto, CreateBookingResponse } from '@rs/shared'
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
const lessonName = `改约课${run}`
const coachName = `改约教练${run}`
const studentName = `改约${run}`
// Eight days ahead at the venue, inside the booking window and past the free-cancel deadline.
const day = venueDateKey(new Date(Date.now() + 8 * 86_400_000))
const at = (hour: number) => venueInstant(day, hour * 60).toISOString()

let token = ''
let bookingId = 0

test('sets up a booked lesson through the API', async ({ request }) => {
  const admin = (
    await call<{ token: string }>(request, 'POST', '/admin/login', undefined, {
      username: 'admin',
      password: ADMIN_PASSWORD,
    })
  ).token
  const lesson = await call<{ id: number }>(request, 'POST', '/admin/lesson-types', admin, {
    name: lessonName,
    durationMinutes: 60,
    price: 20000,
  })
  const coach = await call<{ id: number }>(request, 'POST', '/admin/coaches', admin, {
    name: coachName,
    lessonTypeIds: [lesson.id],
  })
  await addExtraTimes(
    request,
    admin,
    coach.id,
    [10, 11, 14].map((h) => ({ startsAt: at(h), endsAt: at(h + 1) })),
  )
  token = await student(request, `move-${run}`)
  await call(request, 'PUT', '/me', token, { name: studentName, phone: '13800000003' })
  const booked = await call<CreateBookingResponse>(request, 'POST', '/bookings', token, {
    coachId: coach.id,
    startsAt: at(10),
    lessonTypeId: lesson.id,
  })
  await call(request, 'POST', `/dev/fake-pay/${booked.orderId}`, token)
  bookingId = booked.bookingId
})

test('moves the lesson from the bookings page', async ({ page, request }) => {
  await login(page)
  await page.goto('./#/bookings')
  const row = page.getByRole('row').filter({ hasText: studentName })
  await expect(row).toContainText('10:00-11:00')
  await row.getByRole('button', { name: '改约' }).click()

  const times = field(dialog(page), '新时间')
  // The coach's 加班 runs 10:00 to 12:00 and 14:00 to 15:00; the lesson's own time is not offered.
  await expect(times.locator('.slot-picks .t-button')).toHaveText(['10:30', '11:00', '14:00'])
  await times.locator('.slot-picks .t-button', { hasText: '14:00' }).click()
  await expect(dialog(page)).toContainText('订阅了通知的学员和教练会收到改约消息')
  await page.screenshot({ path: 'test-results/move-dialog-light.png' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForTimeout(300)
  await page.screenshot({ path: 'test-results/move-dialog-dark.png' })
  await page.emulateMedia({ colorScheme: 'light' })
  // A double click moves it once; the second is a no-op on the same time.
  await dialog(page).getByRole('button', { name: '确认改约' }).dblclick()
  await expect(dialog(page)).toHaveCount(0)
  await expect(row).toContainText('14:00-15:00')
  await expect(row).toContainText('原定')

  const booking = await call<BookingDto>(request, 'GET', `/bookings/${bookingId}`, token)
  expect(booking).toMatchObject({ startsAt: at(14), movedFrom: at(10), status: 'confirmed' })
})

test('logs the move once in the action log', async ({ page }) => {
  await login(page)
  await page.goto('./#/actions')
  const row = page.getByRole('row').filter({ hasText: coachName }).filter({ hasText: '场馆改约' })
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('场馆改约')
  await expect(row).toContainText('10:00')
  await expect(row).toContainText('改到')
  await expect(row).toContainText('14:00')
  await expect(row).toContainText(studentName)
})

test('says when a day has no free time', async ({ page }) => {
  await login(page)
  await page.goto('./#/bookings')
  const row = page.getByRole('row').filter({ hasText: studentName })
  await row.getByRole('button', { name: '改约' }).click()
  // The day after has no time for this coach.
  const next = venueDateKey(new Date(Date.parse(at(12)) + 86_400_000))
  const times = field(dialog(page), '新时间')
  await pickDate(page, times.locator('.t-date-picker'), next)
  await expect(times.locator('.t-date-picker input')).toHaveValue(next)
  await expect(times).toContainText('这天排班里没有空闲时间')
  await expect(dialog(page).locator('.t-dialog__footer .t-button--theme-primary')).toHaveClass(
    /t-is-disabled/,
  )
  await dialog(page).getByRole('button', { name: '返回' }).click()
})

test('sets how often students may move a lesson', async ({ page, request }) => {
  await login(page)
  await page.goto('./#/settings')
  await typeNumber(field(page, '学员改约').locator('input'), '2')
  await page.getByRole('button', { name: '保存' }).first().click()
  await expect(page.getByText('已保存')).toBeVisible()
  // The lesson keeps the allowance it was booked with; the venue's move does not count against it.
  const booking = await call<BookingDto>(request, 'GET', `/bookings/${bookingId}`, token)
  expect(booking.movesLeft).toBe(1)
  await typeNumber(field(page, '学员改约').locator('input'), '1')
  await page.getByRole('button', { name: '保存' }).first().click()
})
