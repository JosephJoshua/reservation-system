import { expect, type Page, test } from '@playwright/test'
import {
  ADMIN_PASSWORD,
  addExtraTimes,
  call,
  dialog,
  field,
  login,
  pickDate,
  pickMethod,
  student,
} from './helpers'

// Clicks on the 日程 board: in 排班, in 请假 and outside 排班, and a time taken during 代约.
test.describe.configure({ mode: 'serial' })

const run = Date.now().toString(36)
const coachName = `日程教练${run}`
const studentName = `日程${run}`
// Tomorrow at the venue.
const venueDate = new Date(Date.now() + 86_400_000 + 8 * 3_600_000).toISOString().slice(0, 10)
const at = (hhmm: string) => `${venueDate}T${hhmm}:00+08:00`

let admin = ''
let coachId = 0
let lessonTypeId = 0
let other = ''

test('sets up a coach with 加班, a lesson and a 请假 tomorrow', async ({ request }) => {
  admin = (
    await call<{ token: string }>(request, 'POST', '/admin/login', undefined, {
      username: 'admin',
      password: ADMIN_PASSWORD,
    })
  ).token
  lessonTypeId = (
    await call<{ id: number }>(request, 'POST', '/admin/lesson-types', admin, {
      name: `日程课${run}`,
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
  await addExtraTimes(request, admin, coachId, [{ startsAt: at('09:00'), endsAt: at('12:00') }])
  await call(request, 'POST', `/admin/coaches/${coachId}/exceptions`, admin, {
    kind: 'off',
    startsAt: at('13:00'),
    endsAt: at('14:00'),
    note: '比赛',
  })
  const token = await student(request, studentName)
  await call(request, 'PUT', '/me', token, { name: studentName, phone: '13700137001' })
  other = await student(request, `日程另一位${run}`)
  await call(request, 'POST', '/bookings', other, {
    coachId,
    startsAt: at('10:00'),
    lessonTypeId,
  })
})

/** Clicks the coach's row at a time of day tomorrow. */
async function clickBoard(page: Page, hhmm: string) {
  const [h, m] = hhmm.split(':').map(Number) as [number, number]
  const hour = await page
    .locator('.board-hour', { hasText: new RegExp(`^${String(h).padStart(2, '0')}:00$`) })
    .boundingBox()
  const row = await page
    .locator('.board-row', { hasText: coachName })
    .locator('.board-track')
    .boundingBox()
  if (!hour || !row) throw new Error('board not shown')
  await page.mouse.click(hour.x + (m / 60) * 72 + 2, row.y + row.height - 6)
}

test('a click in 排班 picks the open time that covers it, never an outside time', async ({
  page,
}) => {
  await login(page)
  await page.goto('./#/schedule')
  await page.getByRole('button', { name: '后一天' }).click()
  await page.getByPlaceholder('搜索教练').fill(coachName)
  // 09:30 runs into the 10:00 lesson, so 09:00 is the time that covers it.
  await clickBoard(page, '09:40')
  const book = dialog(page).last()
  await expect(book.locator('[aria-pressed=true]')).toHaveText('09:00')
  await expect(book.getByText('排班外的时间请先和教练确认', { exact: false })).toHaveCount(0)
  await book.getByRole('button', { name: '返回' }).click()

  // 请假 is not bookable from the board.
  await clickBoard(page, '13:20')
  await expect(page.locator('.t-message', { hasText: '教练这个时间请假' })).toBeVisible()
  await expect(dialog(page)).toHaveCount(0)

  // Outside 排班 is a time to agree with the coach.
  await clickBoard(page, '15:10')
  await expect(
    dialog(page).last().getByText('排班外的时间请先和教练确认', { exact: false }),
  ).toBeVisible()
  await dialog(page).last().getByRole('button', { name: '返回' }).click()
})

test('a time taken while the desk books it leaves the list', async ({ page, request }) => {
  await login(page)
  await page.goto('./#/schedule')
  await page.getByRole('button', { name: '代约' }).click()
  const book = dialog(page).last()
  const picker = field(book, '学员').locator('input')
  await picker.click()
  await picker.pressSequentially(studentName)
  await page.locator('.t-select-option', { hasText: studentName }).click()
  await field(book, '课程').locator('input').click()
  await page.locator('.t-select-option', { hasText: `日程课${run}` }).click()
  const when = field(book, '时间')
  await when.locator('.t-select input').first().click()
  await page.locator('.t-select-option', { hasText: coachName }).click()
  await pickDate(page, when.locator('.t-date-picker'), venueDate)
  await book.getByRole('button', { name: '11:00', exact: true }).click()
  await expect(book.getByText('线下收款（标价 ¥200）')).toBeVisible()
  await pickMethod(page, book)

  await call(request, 'POST', '/bookings', other, { coachId, startsAt: at('11:00'), lessonTypeId })
  await book.getByRole('button', { name: '确认代约' }).dblclick()
  await expect(page.locator('.t-message', { hasText: '该时段已被预约' })).toBeVisible()
  await expect(book.getByRole('button', { name: '11:00', exact: true })).toHaveCount(0)
  await expect(book.locator('[aria-pressed=true]')).toHaveCount(0)
})
