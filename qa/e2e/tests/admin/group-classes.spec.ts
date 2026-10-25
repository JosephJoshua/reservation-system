// Group classes (小班课): a lesson type for several students, sessions on the schedule, the roster.
import { expect, type Page, test } from '@playwright/test'
import type { BookingDto, CreateBookingResponse, SlotDto } from '@rs/shared'
import { venueDateKey } from '@rs/shared'
import {
  ADMIN_PASSWORD,
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
const lessonName = `小班课${run}`
const coachName = `小班教练${run}`
const shots = 'test-results/group-classes'

let admin = ''
let lessonTypeId = 0
const tokens: string[] = []

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

async function both(page: Page, name: string) {
  await page.screenshot({ path: `${shots}/${name}-light.png` })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${shots}/${name}-dark.png` })
  await page.emulateMedia({ colorScheme: 'light' })
}

/** The sessions of the class on a venue date, as students see them. */
async function sessionsOn(request: Parameters<typeof call>[0], date: string, token: string) {
  return call<SlotDto[]>(request, 'GET', `/slots?date=${date}&lessonTypeId=${lessonTypeId}`, token)
}

/** The first day from tomorrow on that has sessions of the class. */
async function firstSessionDay(request: Parameters<typeof call>[0], token: string) {
  for (let i = 1; i <= 14; i++) {
    const date = venueDateKey(new Date(Date.now() + i * 86_400_000))
    const sessions = await sessionsOn(request, date, token)
    if (sessions.length) return { date, sessions }
  }
  throw new Error('no sessions')
}

/** The 日程 board on tomorrow, the first day with sessions, showing the class's coach only. */
async function openSchedule(page: Page) {
  await page.goto('./#/schedule')
  await page.getByRole('button', { name: '后一天' }).click()
  await page.getByPlaceholder('搜索教练').fill(coachName)
}

/** The class's session on the board, by its headcount such as 2/4 or 已取消. */
const block = (page: Page, state: string) =>
  page.locator('.board-block', { hasText: `${lessonName} ${state}` })

test('creates a group class with a size and a minimum', async ({ page, request }) => {
  admin = (
    await call<{ token: string }>(request, 'POST', '/admin/login', undefined, {
      username: 'admin',
      password: ADMIN_PASSWORD,
    })
  ).token
  await login(page)
  await page.goto('./#/catalog')
  await page.getByRole('button', { name: '新建课程' }).click()
  const form = dialog(page)
  await field(form, '名称').locator('input').fill(lessonName)
  await typeNumber(field(form, '时长').locator('input'), '90')
  await typeNumber(field(form, '标准价').locator('input'), '120')
  await expect(form.locator('.t-checkbox', { hasText: '设置最低开班人数' })).toHaveCount(0)
  await typeNumber(field(form, '上课人数').locator('input').first(), '4')
  await form.locator('.t-checkbox', { hasText: '设置最低开班人数' }).click()
  await expect(form.getByText('到免费取消截止时如果人数不足，整节课会自动取消并退款')).toBeVisible()
  // A group class cannot be a trial.
  await expect(form.locator('.t-checkbox', { hasText: '体验课' })).toHaveClass(/t-is-disabled/)
  await both(page, 'lesson-type-dialog')
  await form.getByRole('button', { name: '保存' }).click()
  await expect(page.getByRole('row').filter({ hasText: lessonName })).toContainText('小班课 · 4 人')

  const types = await call<{ id: number; name: string; capacity: number; minStudents: number }[]>(
    request,
    'GET',
    '/admin/lesson-types',
    admin,
  )
  const created = types.find((t) => t.name === lessonName)
  expect(created).toMatchObject({ capacity: 4, minStudents: 2, durationMinutes: 90 })
  lessonTypeId = created?.id ?? 0
  await call(request, 'POST', '/admin/coaches', admin, {
    name: coachName,
    lessonTypeIds: [lessonTypeId],
  })
})

test('schedules a week of sessions once on a double click and names an overlap', async ({
  page,
}) => {
  await login(page)
  await openSchedule(page)
  await page.getByRole('button', { name: '排小班课' }).click()
  const form = dialog(page)
  await field(form, '教练').locator('.t-select').click()
  await page.locator('.t-select-option', { hasText: coachName }).click()
  await expect(field(form, '课程').locator('input')).toHaveValue(`${lessonName}（90 分钟）`)
  await expect(field(form, '每节人数').locator('input')).toHaveValue('4')
  await field(form, '开始时间').locator('input').fill('10:00, 9:3')
  await expect(form.getByRole('button', { name: '创建 0 节' })).toBeVisible()
  await field(form, '开始时间').locator('input').fill('10:00')
  await both(page, 'create-sessions')
  const creates = await countRequests(page, '/admin/sessions', () =>
    form.getByRole('button', { name: '创建 7 节' }).dblclick(),
  )
  expect(creates).toBe(1)
  await expect(dialog(page)).toHaveCount(0)
  await expect(block(page, '0/4')).toHaveCount(1)
  await both(page, 'schedule-day')

  await page.getByRole('button', { name: '排小班课' }).click()
  await field(dialog(page), '教练').locator('.t-select').click()
  await page.locator('.t-select-option', { hasText: coachName }).click()
  await dialog(page).getByRole('button', { name: '创建 7 节' }).click()
  await expect(page.getByText(/^\d+月\d+日 10:00 与该教练已有的小班课重叠$/)).toBeVisible()
})

test('shows the roster, books at the desk, resizes and cancels a seat', async ({
  page,
  request,
}) => {
  for (const name of ['甲', '乙', '丙']) {
    const t = await student(request, `group-${run}-${name}`)
    await call(request, 'PUT', '/me', t, { name: `学员${name}${run}`, phone: '13800000009' })
    tokens.push(t)
  }
  const [a, b] = tokens
  if (!a || !b) throw new Error('no students')
  const { sessions } = await firstSessionDay(request, a)
  const first = sessions[0]
  if (!first) throw new Error('no session')
  expect(first).toMatchObject({ capacity: 4, seatsLeft: 4 })
  for (const t of [a, b]) {
    const booked = await call<CreateBookingResponse>(request, 'POST', '/bookings', t, {
      slotId: first.id,
      lessonTypeId,
    })
    await call(request, 'POST', `/dev/fake-pay/${booked.orderId}`)
  }

  await login(page)
  await openSchedule(page)
  await block(page, '2/4').click()
  const session = dialog(page)
  await expect(session).toContainText('已报名 2/4 人')
  await expect(session.locator('.roster-row')).toHaveCount(2)
  await expect(session.locator('.roster-row').first()).toContainText(`学员甲${run}`)
  await both(page, 'session-dialog')

  // 代约 the third student into a seat.
  await session.getByRole('button', { name: '代约' }).click()
  const book = dialog(page).last()
  await expect(field(book, '课程')).toContainText(lessonName)
  const picker = field(book, '学员').locator('input')
  await picker.click()
  await picker.pressSequentially(`学员丙${run}`)
  await page.locator('.t-select-option', { hasText: `学员丙${run}` }).click()
  await expect(book.getByText('线下收款（标价 ¥120）')).toBeVisible()
  await book.getByRole('button', { name: '确认代约' }).dblclick()
  await expect(page.getByText('已代约')).toBeVisible()
  await expect(block(page, '3/4')).toBeVisible()

  // Seats never go below the students booked; raising them saves.
  await block(page, '3/4').click()
  const seats = dialog(page).locator('.t-input-number input')
  await typeNumber(seats, '2')
  await expect(dialog(page).getByText('人数需在 3 到 30 之间')).toBeVisible()
  await expect(dialog(page).locator('.t-button', { hasText: '保存' })).toHaveClass(/t-is-disabled/)
  await typeNumber(seats, '6')
  await seats.blur()
  await dialog(page).getByRole('button', { name: '保存' }).click()
  await expect(page.getByText('已修改人数')).toBeVisible()
  await expect(block(page, '3/6')).toBeVisible()

  // Cancelling one seat refunds that student only.
  await block(page, '3/6').click()
  await dialog(page)
    .locator('.roster-row', { hasText: `学员乙${run}` })
    .getByRole('button', { name: '取消' })
    .click()
  await expect(dialog(page)).toContainText(`取消 学员乙${run} 的预约`)
  await dialog(page).locator('textarea').fill('学员请假')
  await dialog(page).getByRole('button', { name: '确认取消并退款' }).click()
  await expect(block(page, '2/6')).toBeVisible()
  const mine = await call<BookingDto[]>(request, 'GET', '/bookings?scope=upcoming', b)
  expect(mine.find((x) => x.lessonType.id === lessonTypeId)).toBeUndefined()
})

test('moves a seat to another session from the bookings page', async ({ page, request }) => {
  await login(page)
  await page.goto('./#/bookings')
  const row = page.getByRole('row').filter({ hasText: `学员甲${run}` })
  await row.getByRole('button', { name: '改约' }).click()
  const move = dialog(page)
  // Tomorrow's session of the same class, at 10:00.
  const { date } = await firstSessionDay(request, tokens[0] ?? '')
  const next = venueDateKey(new Date(Date.parse(`${date}T04:00:00Z`) + 86_400_000))
  const times = field(move, '新时间')
  await pickDate(page, times.locator('.t-date-picker'), next)
  await expect(times.locator('.slot-picks .t-button')).toHaveText(['10:00 剩 4 位'])
  await times.locator('.slot-picks .t-button').click()
  await move.getByRole('button', { name: '确认改约' }).click()
  await expect(page.getByText('已改约')).toBeVisible()
  await expect(row).toContainText('原定')
})

test('calls off a whole session and refunds everyone', async ({ page, request }) => {
  await login(page)
  await openSchedule(page)
  await block(page, '1/6').click()
  await dialog(page).getByRole('button', { name: '取消整节' }).click()
  await expect(dialog(page)).toContainText('取消整节课后，1 位学员都会收到全额退款或退回课时')
  await expect(dialog(page).locator('.t-button', { hasText: '确认取消并退款' })).toHaveClass(
    /t-is-disabled/,
  )
  await dialog(page).locator('textarea').fill('场地维修')
  const cancels = await countRequests(page, '/cancel', () =>
    dialog(page).getByRole('button', { name: '确认取消并退款' }).dblclick(),
  )
  expect(cancels).toBe(1)
  await expect(block(page, '已取消')).toBeVisible()
  await block(page, '已取消').click()
  await expect(dialog(page)).toContainText('已取消：场地维修')
  await expect(dialog(page).getByRole('button', { name: '开放报名' })).toHaveCount(0)
  await both(page, 'session-cancelled')

  const third = tokens[2]
  if (!third) throw new Error('no student')
  const history = await call<BookingDto[]>(request, 'GET', '/bookings?scope=past', third)
  expect(history.find((x) => x.lessonType.id === lessonTypeId)).toMatchObject({
    status: 'cancelled',
    cancelledBy: 'venue',
  })
})
