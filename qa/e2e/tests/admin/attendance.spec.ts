import { createRequire } from 'node:module'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import type { BookingDto, CreateBookingResponse } from '@rs/shared'
import { venueDateKey, venueInstant } from '@rs/shared'
import { ADMIN_PASSWORD, addExtraTimes, call, login, student } from './helpers'

// 前台签到: the front desk's list, marks with who made them, a student scan and the 签到码.

test.describe.configure({ mode: 'serial' })

const run = Date.now().toString(36)
const coachName = `签到教练${run}`
const names = { under: `上课中${run}`, soon: `快开始${run}`, later: `稍后${run}` }
const shots = join(import.meta.dirname, '../../test-results/attendance-shots')
const day = venueDateKey(new Date(Date.now() + 8 * 86_400_000))
const MIN = 60_000
// Minutes from now each lesson starts: under way, open for arrivals, not yet open.
const starts = { under: -10, soon: 20, later: 40 }
const tokens: Record<string, string> = {}
const ids: Record<string, number> = {}

function moveTo(id: number, startMs: number) {
  const require = createRequire(join(import.meta.dirname, '../../../../apps/api/package.json'))
  const Database = require('better-sqlite3')
  const db = new Database(join(import.meta.dirname, '../../../../apps/api/data/e2e.db'))
  db.prepare('update bookings set starts_at = ?, ends_at = ? where id = ?').run(
    startMs,
    startMs + 60 * MIN,
    id,
  )
  db.prepare(
    'update slots set starts_at = ?, ends_at = ? where id = (select slot_id from bookings where id = ?)',
  ).run(startMs, startMs + 60 * MIN, id)
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

const row = (page: Page, name: string) => page.getByRole('row').filter({ hasText: name })

test('three students book lessons around now', async ({ request }) => {
  const now = Date.now()
  // All three lessons must fall on today's venue date for the list to show them.
  test.skip(
    venueDateKey(new Date(now + (starts.under - 1) * MIN)) !==
      venueDateKey(new Date(now + starts.later * MIN)),
    'too close to midnight at the venue',
  )
  const admin = (
    await call<{ token: string }>(request, 'POST', '/admin/login', undefined, {
      username: 'admin',
      password: ADMIN_PASSWORD,
    })
  ).token
  const lesson = await call<{ id: number }>(request, 'POST', '/admin/lesson-types', admin, {
    name: `签到课${run}`,
    durationMinutes: 60,
    price: 20000,
  })
  const coach = await call<{ id: number }>(request, 'POST', '/admin/coaches', admin, {
    name: coachName,
    lessonTypeIds: [lesson.id],
  })
  const keys = Object.keys(names) as (keyof typeof names)[]
  const spans = keys.map((_, i) => ({
    startsAt: venueInstant(day, (10 + i) * 60).toISOString(),
    endsAt: venueInstant(day, (11 + i) * 60).toISOString(),
  }))
  await addExtraTimes(request, admin, coach.id, spans)
  for (const [i, key] of keys.entries()) {
    tokens[key] = await student(request, `attendance-${key}-${run}`)
    await call(request, 'PUT', '/me', tokens[key], {
      name: names[key],
      phone: `1390000000${i}`,
    })
    const booked = await call<CreateBookingResponse>(request, 'POST', '/bookings', tokens[key], {
      coachId: coach.id,
      startsAt: spans[i]?.startsAt,
      lessonTypeId: lesson.id,
    })
    await call(request, 'POST', `/dev/fake-pay/${booked.orderId}`, tokens[key])
    ids[key] = booked.bookingId
    moveTo(booked.bookingId, now + starts[key] * MIN)
  }
})

test('the front desk checks students in and corrects marks', async ({ page, request }) => {
  test.skip(!ids.soon, 'no lessons booked')
  await login(page)
  await page.goto('./#/checkin')
  await page.getByPlaceholder('搜索学员姓名、手机号或教练').fill(coachName)
  await expect(page.getByRole('row').filter({ hasText: coachName })).toHaveCount(3)

  await expect(row(page, names.later)).toContainText('起可签到')
  await expect(row(page, names.later).getByRole('button')).toHaveCount(0)
  await expect(row(page, names.soon).getByRole('button', { name: '签到' })).toBeVisible()
  await expect(row(page, names.soon).getByRole('button', { name: '缺席' })).toHaveCount(0)
  await expect(row(page, names.under).getByRole('button', { name: '缺席' })).toBeVisible()
  await both(page, 'list')

  // A double click checks in once and logs once.
  await row(page, names.soon).getByRole('button', { name: '签到' }).dblclick()
  await expect(row(page, names.soon)).toContainText('到课')
  await expect(row(page, names.soon)).toContainText('前台')
  await expect(row(page, names.soon).getByRole('button', { name: '撤销' })).toBeVisible()

  await row(page, names.under).getByRole('button', { name: '缺席' }).click()
  await expect(row(page, names.under)).toContainText('缺席')
  await row(page, names.under).getByRole('button', { name: '撤销' }).click()
  await expect(row(page, names.under)).toContainText('未签到')

  // The student scans the venue code; the list picks it up.
  const scanned = await call<unknown[]>(request, 'POST', '/check-in', tokens.under, {
    code: 'http://localhost:5173/checkin',
  })
  expect(scanned).toHaveLength(1)
  await page.reload()
  await page.getByPlaceholder('搜索学员姓名、手机号或教练').fill(names.under)
  await expect(row(page, names.under)).toContainText('学员扫码')
  const seen = await call<BookingDto>(request, 'GET', `/bookings/${ids.under}`, tokens.under)
  expect(seen).toMatchObject({ attendance: 'attended', canCheckIn: false })

  // Filters and an empty search.
  await page.getByPlaceholder('搜索学员姓名、手机号或教练').fill(`不存在${run}`)
  await expect(page.getByText('没有符合条件的学员')).toBeVisible()
  await page.getByPlaceholder('搜索学员姓名、手机号或教练').fill(coachName)
  const filters = page.locator('.toolbar .t-radio-group')
  await filters.getByText('已签到', { exact: true }).click()
  await expect(page.getByRole('row').filter({ hasText: coachName })).toHaveCount(2)
  await filters.getByText(/^未签到/).click()
  await expect(page.getByRole('row').filter({ hasText: coachName })).toHaveCount(1)
  await filters.getByText('全部', { exact: true }).click()

  await page.goto('./#/actions')
  await expect(page.getByText(`${names.soon}`).first()).toBeVisible()
  const logged = page.getByRole('row').filter({ hasText: names.soon }).filter({ hasText: '到课' })
  await expect(logged).toHaveCount(1)
})

test('shows the 签到码 and the settings', async ({ page }) => {
  await login(page)
  await page.goto('./#/checkin')
  await page.getByRole('button', { name: '签到码' }).click()
  const qr = page.locator('.checkin-qr svg')
  await expect(qr).toBeVisible()
  await both(page, 'code')
  await page.getByRole('button', { name: '关闭' }).click()

  await page.goto('./#/settings')
  await expect(page.getByText('学员扫码签到')).toBeVisible()
  await expect(page.getByText('教练点名')).toBeVisible()
})

test('fits a phone', async ({ page }) => {
  test.skip(!ids.soon, 'no lessons booked')
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page)
  await page.goto('./#/checkin')
  await page.getByPlaceholder('搜索学员姓名、手机号或教练').fill(coachName)
  await expect(page.getByText(names.later)).toBeVisible()
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
  await both(page, 'phone')
})
