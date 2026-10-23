import { createRequire } from 'node:module'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import type { CoachLoginResponse, CreateBookingResponse, SlotSyncDto } from '@rs/shared'
import { ADMIN_PASSWORD, API, call, dialog, login, student } from './helpers'

// The admin side of the coach mode: binding, weekly hours, attendance and the monthly report.
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
let coachToken = ''
let bookingId = 0
// The admin pages default to today's dates; pinned to the lesson's day so it is always listed.
let lessonTime = 0

test('binds a coach to WeChat with a code', async ({ page, request }) => {
  const admin = (
    await call<{ token: string }>(request, 'POST', '/admin/login', undefined, {
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
  await call(request, 'POST', '/admin/coaches', admin, {
    name: coachName,
    lessonTypeIds: [lessonTypeId],
  })

  await login(page)
  await page.goto('./#/catalog')
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

test('sets weekly hours and a day off for the coach', async ({ page, request }) => {
  await login(page)
  await page.goto('./#/catalog')
  await page
    .getByRole('row')
    .filter({ hasText: coachName })
    .getByRole('button', { name: '可约时间' })
    .click()
  await dialog(page).getByRole('button', { name: '添加时间段' }).click()
  await expect(dialog(page).locator('tbody tr')).toHaveCount(1)
  await expect(dialog(page).locator('tbody tr')).toContainText('3')

  // Two overlapping windows on Monday cannot be saved.
  await dialog(page).getByRole('button', { name: '添加时间段' }).click()
  await expect(dialog(page).locator('.danger-text')).toHaveText('同一天的时间段不能重叠')
  await expect(dialog(page).locator('.t-dialog__footer .t-button--theme-primary')).toHaveClass(
    /t-is-disabled/,
  )
  await both(page, 'hours-invalid')
  await dialog(page).locator('tbody tr').nth(1).getByRole('button', { name: '删除' }).click()
  await expect(dialog(page).locator('.danger-text')).toHaveCount(0)

  await dialog(page).getByRole('button', { name: '保存每周时间' }).click()
  await expect(page.locator('.t-message')).toContainText(/已保存，新增 \d+ 个时段/)

  const saved = await call<{ hours: unknown[]; daysOff: string[] }>(
    request,
    'GET',
    '/coach/hours',
    coachToken,
  )
  expect(saved.hours).toEqual([{ weekday: 1, startMinute: 540, endMinute: 720, lessonMinutes: 60 }])

  // A day off a week from now, typed into the date picker.
  const day = new Date(Date.now() + 7 * 86_400_000 + 8 * 3_600_000).toISOString().slice(0, 10)
  await page
    .getByRole('row')
    .filter({ hasText: coachName })
    .getByRole('button', { name: '可约时间' })
    .click()
  const picker = dialog(page).getByPlaceholder('添加休息日')
  await picker.click()
  await picker.fill(day)
  await page.locator('.t-date-picker__cell--active').click()
  await expect(dialog(page).locator('.t-tag', { hasText: day })).toBeVisible()
  await both(page, 'hours')
  expect(
    (await call<{ daysOff: string[] }>(request, 'GET', '/coach/hours', coachToken)).daysOff,
  ).toEqual([day])
  await dialog(page).locator('.t-tag', { hasText: day }).locator('.t-tag__icon-close').click()
  await expect(dialog(page).locator('.t-tag', { hasText: day })).toHaveCount(0)
})

test('marks attendance and shows the coach note on bookings', async ({ page, request }) => {
  const sync = await call<SlotSyncDto>(request, 'PUT', '/coach/hours', coachToken, {
    hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      weekday,
      startMinute: 20 * 60,
      endMinute: 21 * 60,
      lessonMinutes: 60,
    })),
  })
  expect(sync.created).toBeGreaterThan(0)
  const slots = await call<{ id: number; lesson: unknown; startsAt: string }[]>(
    request,
    'GET',
    `/coach/schedule?from=${new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10)}&to=${new Date(Date.now() + 8 * 3_600_000 + 10 * 86_400_000).toISOString().slice(0, 10)}`,
    coachToken,
  )
  const free = slots.find((s) => !s.lesson && Date.parse(s.startsAt) > Date.now() + 4 * 3_600_000)
  if (!free) throw new Error('no free slot')
  const token = await student(request, `coach-e2e-${run}`)
  await call(request, 'PUT', '/me', token, { name: '王小明', phone: '13800138000' })
  const booked = await call<CreateBookingResponse>(request, 'POST', '/bookings', token, {
    slotId: free.id,
    lessonTypeId,
  })
  if (booked.orderId) await call(request, 'POST', `/dev/fake-pay/${booked.orderId}`)
  bookingId = booked.bookingId
  await call(request, 'PUT', `/coach/lessons/${bookingId}/note`, coachToken, {
    note: '正手很稳，下次练发球',
  })
  lessonTime = moveIntoPast(bookingId)

  await page.clock.setFixedTime(lessonTime)
  await login(page)
  await page.goto('./#/bookings')
  await page.locator('.toolbar .t-select').nth(1).click()
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
  const row = page.getByRole('row').filter({ hasText: coachName })
  await expect(row).toContainText('1')
  await expect(page.locator('.stat-grid')).toContainText('净收入')
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
