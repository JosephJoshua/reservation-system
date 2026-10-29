import { createRequire } from 'node:module'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import type { CoachLoginResponse, CreateBookingResponse, ScheduleViewDto } from '@rs/shared'
import { addVenueDays, venueDateKey, venueInstant } from '@rs/shared'
import { ADMIN_PASSWORD, API, call, dialog, listFilter, login, pickDate, student } from './helpers'

// The admin side of the coach mode: binding, 排班, attendance and the monthly report.
test.describe.configure({ mode: 'serial' })

const run = Date.now().toString(36)
const coachName = `教练${run}`
const lessonName = `私教${run}`
const shots = join(import.meta.dirname, '../../test-results/coach-shots')

/**
 * Moves a booking and its slot into the past, so it can be marked; the e2e API runs on real time.
 * Returns the new start, which falls on yesterday's venue date just after midnight.
 */
function moveIntoPast(bookingId: number) {
  const require = createRequire(join(import.meta.dirname, '../../../../apps/api/package.json'))
  const Database = require('better-sqlite3')
  const db = new Database(join(import.meta.dirname, '../../../../apps/api/data/e2e.db'))
  // Not before the venue's midnight: the bookings page starts at today, so a lesson moved into
  // yesterday would not be listed when this runs just after midnight.
  const venueMidnight = Date.parse(
    `${new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10)}T00:00:00+08:00`,
  )
  const start = Math.max(Date.now() - 2 * 3_600_000, venueMidnight)
  // Ended, so the report counts it.
  const end = Math.max(start + 1000, Math.min(start + 3_600_000, Date.now() - 1000))
  db.prepare('update bookings set starts_at = ?, ends_at = ? where id = ?').run(
    start,
    end,
    bookingId,
  )
  db.prepare(
    'update slots set starts_at = ?, ends_at = ? where id = (select slot_id from bookings where id = ?)',
  ).run(start, end, bookingId)
  db.close()
  return start
}

async function both(page: Page, name: string) {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.screenshot({ path: `${shots}/${name}-light.png`, fullPage: true })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForTimeout(200)
  await page.screenshot({ path: `${shots}/${name}-dark.png`, fullPage: true })
  await page.emulateMedia({ colorScheme: 'light' })
}

let lessonTypeId = 0
let coachId = 0
let coachToken = ''
let bookingId = 0
// The admin pages default to today's dates; pinned to the lesson's day so it is always listed.
let lessonTime = 0

test('binds a coach to WeChat with a code', async ({ page, request }) => {
  const admin = (
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

  await login(page)
  await page.goto('./#/coaches')
  const row = page.getByRole('row').filter({ hasText: coachName })
  await expect(row).toContainText('未绑定')
  await row.getByRole('button', { name: '绑定', exact: true }).click()
  await dialog(page).getByRole('button', { name: '生成绑定码' }).click()
  const shown = ((await dialog(page).locator('.bind-code').textContent()) ?? '').replace(/\s/g, '')
  expect(shown).toMatch(/^[A-Z2-9]{8}$/)
  await both(page, 'bind-code')

  const res = await request.post(`${API}/coach/bind`, {
    data: { code: `dev:coach-${run}`, bindCode: shown.toLowerCase() },
  })
  expect(res.ok()).toBeTruthy()
  coachToken = ((await res.json()) as CoachLoginResponse).token

  await dialog(page).locator('.t-dialog__close').click()
  await expect(row).toContainText('已绑定')
})

test('sets weekly hours and a 请假 for the coach', async ({ page, request }) => {
  await login(page)
  await page.goto('./#/coaches')
  await page
    .getByRole('row')
    .filter({ hasText: coachName })
    .getByRole('button', { name: '排班' })
    .click()
  const monday = dialog(page).locator('.week-day', { hasText: '周一' })
  await monday.getByRole('button', { name: '添加' }).click()
  const times = monday.locator('.t-time-picker input')
  await expect(times).toHaveCount(2)
  await expect(times.nth(0)).toHaveValue('09:00')
  await expect(times.nth(1)).toHaveValue('12:00')

  // A second window starts an hour after the first; moved to overlap it, it cannot be saved.
  await monday.getByRole('button', { name: '添加' }).click()
  await expect(times.nth(2)).toHaveValue('13:00')
  await times.nth(2).click()
  await times.nth(2).press('ControlOrMeta+a')
  await times.nth(2).pressSequentially('11:00')
  await page.locator('.t-popup:visible').getByRole('button', { name: '确定' }).click()
  await expect(dialog(page).locator('.danger-text')).toHaveText('同一天的时间段不能重叠')
  await expect(dialog(page).locator('.t-dialog__footer .t-button--theme-primary')).toHaveClass(
    /t-is-disabled/,
  )
  await both(page, 'hours-invalid')
  await monday.getByRole('button', { name: '删除' }).nth(1).click()
  await expect(dialog(page).locator('.danger-text')).toHaveCount(0)

  await dialog(page).getByRole('button', { name: '保存每周时间' }).click()
  await expect(page.locator('.t-message', { hasText: '已保存每周时间' })).toBeVisible()
  const saved = await call<ScheduleViewDto>(request, 'GET', '/coach/hours', coachToken)
  expect(saved.periods.at(-1)?.hours).toEqual([{ weekday: 1, startMinute: 540, endMinute: 720 }])

  // A whole-day 请假 a week from now.
  const day = venueDateKey(new Date(Date.now() + 7 * 86_400_000))
  const form = dialog(page).locator('.exception-form')
  await pickDate(page, form.locator('.t-date-picker').first(), day)
  await pickDate(page, form.locator('.t-date-picker').nth(1), day)
  await form.getByPlaceholder('备注（选填）').fill('比赛')
  await form.getByRole('button', { name: '添加请假' }).dblclick()
  const leave = dialog(page).locator('.exception-row', { hasText: '比赛' })
  await expect(leave).toHaveCount(1)
  await expect(leave).toContainText('全天')
  await both(page, 'hours')
  const view = await call<ScheduleViewDto>(request, 'GET', '/coach/hours', coachToken)
  expect(view.exceptions).toMatchObject([
    {
      kind: 'off',
      startsAt: venueInstant(day, 0).toISOString(),
      endsAt: venueInstant(day, 24 * 60).toISOString(),
      note: '比赛',
    },
  ])
  await leave.getByRole('button', { name: '取消' }).click()
  await page.locator('.t-popconfirm').getByRole('button', { name: '取消' }).click()
  await expect(leave).toHaveCount(0)
})

test('marks attendance and shows the coach note on bookings', async ({ page, request }) => {
  await call(request, 'PUT', '/coach/hours', coachToken, {
    hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      weekday,
      startMinute: 20 * 60,
      endMinute: 21 * 60,
    })),
  })
  // 20:00 the first day that is more than four hours away.
  const today = venueDateKey(new Date())
  const startsAt = [0, 1, 2]
    .map((d) => venueInstant(addVenueDays(today, d), 20 * 60))
    .find((t) => t.getTime() > Date.now() + 4 * 3_600_000)
  if (!startsAt) throw new Error('no free time')
  const token = await student(request, `coach-e2e-${run}`)
  await call(request, 'PUT', '/me', token, { name: '王小明', phone: '13800138000' })
  const booked = await call<CreateBookingResponse>(request, 'POST', '/bookings', token, {
    coachId,
    startsAt: startsAt.toISOString(),
    lessonTypeId,
  })
  if (booked.orderId) await call(request, 'POST', `/dev/fake-pay/${booked.orderId}`, token)
  bookingId = booked.bookingId
  await call(request, 'PUT', `/coach/lessons/${bookingId}/note`, coachToken, {
    note: '正手很稳，下次练发球',
  })
  lessonTime = moveIntoPast(bookingId)

  await page.clock.setFixedTime(lessonTime)
  await login(page)
  await page.goto('./#/bookings')
  await listFilter(page, '教练').click()
  await page.locator('.t-select-option', { hasText: coachName }).click()
  const row = page.getByRole('row').filter({ hasText: '王小明' })
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('备注：正手很稳，下次练发球')
  await row.locator('.t-select').click()
  await page.locator('.t-select-option', { hasText: '缺席' }).click()
  await expect(page.locator('.t-message')).toContainText('已更新签到')
  await both(page, 'bookings')
  const lesson = await call<{ attendance: string }>(
    request,
    'GET',
    `/coach/lessons/${bookingId}`,
    coachToken,
  )
  expect(lesson.attendance).toBe('no_show')
  await row.locator('.t-select').click()
  await page.locator('.t-select-option', { hasText: '到课' }).click()
  await expect(row.locator('.t-select input')).toHaveValue('到课')
})

test('shows the monthly report and exports it', async ({ page }) => {
  await page.clock.setFixedTime(lessonTime)
  await login(page)
  await page.goto('./#/reports')
  await page.getByText('月报与课时费', { exact: true }).click()
  const row = page.getByRole('row').filter({ hasText: coachName })
  await expect(row).toContainText('1')
  const monthly = page.locator('.stat-grid').filter({ hasText: '净收入' })
  await expect(monthly).toBeVisible()
  // The coach has no category yet, so the lesson has no pay rate.
  await expect(monthly).toContainText('教练课时费')
  await expect(row).toContainText('1 节未设课时费')
  // The lesson's month is still running, so its pay cannot be confirmed yet.
  await expect(page.getByText('这个月还没结束')).toBeVisible()
  await expect(page.locator('.t-button.t-is-disabled', { hasText: '确认本月' })).toBeVisible()
  await both(page, 'reports')
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出 CSV' }).click()
  const file = await download
  expect(file.suggestedFilename()).toMatch(/^report-\d{4}-\d{2}\.csv$/)
  const text = await (await file.createReadStream()).toArray()
  const csv = Buffer.concat(text).toString('utf8')
  expect(csv.startsWith('﻿')).toBe(true)
  // The lesson is shorter than an hour when this runs just after midnight.
  expect(csv).toMatch(new RegExp(`${coachName},1,[\\d.]+,1,0,0,0,0`))
})

test("shows the lesson on today's overview and in the business stats", async ({ page }) => {
  await page.clock.setFixedTime(lessonTime)
  await login(page)
  const today = page.locator('.t-card').filter({ hasText: '今日课程' }).last()
  const lesson = today.locator('.today-item').filter({ hasText: coachName })
  await expect(lesson).toContainText(lessonName)
  // Read-only on the overview; 签到 is marked on 今日.
  await expect(lesson.locator('.t-tag')).toHaveText('到课')
  await expect(today.getByRole('link', { name: '去今日签到' })).toHaveAttribute('href', '#/checkin')
  await both(page, 'overview')

  await page.goto('./#/reports')
  await expect(page.locator('.kpi-grid')).toContainText('课消')
  const coaches = page.locator('.t-card').filter({ hasText: '教练排班占用' })
  await expect(coaches.locator('.viz-meter').filter({ hasText: coachName })).toBeVisible()
  await expect(page.locator('.viz-heat-cell:not(.viz-heat-none)').first()).toBeVisible()
  // The same numbers as a table.
  const trend = page.locator('.t-card').filter({ hasText: '收入趋势' })
  await trend.getByRole('button', { name: '数据' }).click()
  await expect(trend.locator('th', { hasText: '课消' })).toBeVisible()
  await page.getByText('近7天', { exact: true }).click()
  await expect(trend.locator('tbody tr')).toHaveCount(7)
  await both(page, 'stats')
})
