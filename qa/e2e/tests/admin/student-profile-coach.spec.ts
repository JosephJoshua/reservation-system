import { createRequire } from 'node:module'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import {
  type CoachLessonDto,
  type CoachLoginResponse,
  type CreateBookingResponse,
  venueDateKey,
  venueInstant,
  versionOf,
} from '@rs/shared'
import { ADMIN_PASSWORD, API, addExtraTimes, call, login, student } from './helpers'

// 学员档案 kept by coaches, as the admin student page shows it: who saved it last, and the
// student's 课后点评 from every coach.

test.describe.configure({ mode: 'serial' })

const run = Date.now().toString(36)
const coachName = `档案教练${run}`
const studentName = `教练档案${run}`
const shots = join(import.meta.dirname, '../../test-results/student-profile-coach')
const day = venueDateKey(new Date(Date.now() + 9 * 86_400_000))
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const EMPTY = { level: null, grip: null, tags: [], note: '' }

let admin = ''
let coachToken = ''
let studentId = 0
const lessons: number[] = []

/** Moves a booked lesson to end `hoursAgo` hours ago, so attendance and feedback are open. */
function moveIntoPast(id: number, hoursAgo: number) {
  const require = createRequire(join(import.meta.dirname, '../../../../apps/api/package.json'))
  const Database = require('better-sqlite3')
  const db = new Database(join(import.meta.dirname, '../../../../apps/api/data/e2e.db'))
  const end = Date.now() - hoursAgo * 3_600_000
  const start = end - 3_600_000
  db.prepare('update bookings set starts_at = ?, ends_at = ? where id = ?').run(start, end, id)
  db.prepare(
    'update slots set starts_at = ?, ends_at = ? where id = (select slot_id from bookings where id = ?)',
  ).run(start, end, id)
  db.close()
}

async function both(page: Page, name: string) {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForTimeout(200)
    await page.screenshot({ path: `${shots}/${name}-${scheme}.png`, fullPage: true })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

test('a coach fills in the profile and writes feedback through the API', async ({ request }) => {
  admin = (
    await call<{ token: string }>(request, 'POST', '/admin/login', undefined, {
      username: 'admin',
      password: ADMIN_PASSWORD,
    })
  ).token
  const lesson = await call<{ id: number }>(request, 'POST', '/admin/lesson-types', admin, {
    name: `档案课${run}`,
    durationMinutes: 60,
    price: 20000,
  })
  const coach = await call<{ id: number }>(request, 'POST', '/admin/coaches', admin, {
    name: coachName,
    lessonTypeIds: [lesson.id],
  })
  const spans = [9, 11, 13, 15].map((hour) => ({
    startsAt: venueInstant(day, hour * 60).toISOString(),
    endsAt: venueInstant(day, (hour + 1) * 60).toISOString(),
  }))
  await addExtraTimes(request, admin, coach.id, spans)
  const { code } = await call<{ code: string }>(
    request,
    'POST',
    `/admin/coaches/${coach.id}/bind-code`,
    admin,
    {},
  )
  coachToken = (
    await call<CoachLoginResponse>(request, 'POST', '/coach/bind', undefined, {
      code: `dev:profile-coach-${run}`,
      bindCode: code,
    })
  ).token
  const token = await student(request, `profile-coach-${run}`)
  await call(request, 'PUT', '/me', token, { name: studentName, phone: '13700137002' })
  studentId = (await call<{ id: number }>(request, 'GET', '/me', token)).id
  for (const { startsAt } of spans) {
    const booked = await call<CreateBookingResponse>(request, 'POST', '/bookings', token, {
      coachId: coach.id,
      startsAt,
      lessonTypeId: lesson.id,
    })
    await call(request, 'POST', `/dev/fake-pay/${booked.orderId}`)
    lessons.push(booked.bookingId)
  }
  // Three lessons in the past, a day apart, the oldest first; the last stays ahead.
  for (const [i, id] of lessons.slice(0, 3).entries()) {
    moveIntoPast(id, 1 + (2 - i) * 24)
    await call(request, 'PUT', `/coach/lessons/${id}/attendance`, coachToken, {
      attendance: 'attended',
    })
    const photos: string[] = []
    if (i === 2) {
      const uploaded = await request.post(`${API}/coach/lessons/${id}/photos`, {
        headers: { Authorization: `Bearer ${coachToken}` },
        multipart: { file: { name: 'a.png', mimeType: 'image/png', buffer: PNG } },
      })
      photos.push((await uploaded.json()).url)
    }
    await call(request, 'PUT', `/coach/lessons/${id}/feedback`, coachToken, {
      text: `第 ${i + 1} 节：${'正手连续拉球更稳了，'.repeat(i === 0 ? 20 : 1)}${run}`,
      photos,
    })
  }

  const saved = await request.put(`${API}/coach/lessons/${lessons[3]}/profile`, {
    headers: { Authorization: `Bearer ${coachToken}`, 'If-Match': versionOf(EMPTY) },
    data: { level: 'elementary', grip: 'shakehand', tags: ['发球好'], note: '反手要多练' },
  })
  expect(saved.status()).toBe(200)
  const lesson3 = (await saved.json()) as CoachLessonDto
  expect(lesson3.profile).toMatchObject({
    feedbackCount: 3,
    updatedBy: { kind: 'coach', name: coachName },
  })
})

test('shows who saved the profile and the feedback, newest first', async ({ page }) => {
  await login(page)
  await page.goto(`./#/students?id=${studentId}`)
  const card = page.locator('.t-card').filter({ hasText: '学员档案' })
  await expect(card.locator('.t-tag')).toHaveText(['初级', '横拍', '发球好'])
  await expect(card).toContainText(`${coachName}（教练） 修改于`)

  const feedback = page.locator('.t-card').filter({ hasText: '课后点评（3）' })
  const items = feedback.locator('.feedback-cell')
  await expect(items).toHaveCount(3)
  await expect(items.first()).toContainText(`第 3 节`)
  await expect(items.first()).toContainText(coachName)
  await expect(items.first().locator('img')).toHaveCount(1)
  await expect(items.last()).toContainText('第 1 节')
  await both(page, 'drawer')

  // Staff can still change it, and then they are the last to have saved it.
  await card.getByRole('button', { name: '编辑' }).click()
  const d = page.locator('.t-dialog').filter({ hasText: '编辑学员档案' })
  await d.locator('textarea').fill('反手要多练，备赛')
  await d.getByRole('button', { name: '保存' }).click()
  await expect(d).toHaveCount(0)
  await expect(card).toContainText('管理员 修改于')
})

test('a coach save on top of the venue change is refused', async ({ request }) => {
  const res = await request.put(`${API}/coach/lessons/${lessons[3]}/profile`, {
    headers: {
      Authorization: `Bearer ${coachToken}`,
      'If-Match': versionOf({
        level: 'elementary',
        grip: 'shakehand',
        tags: ['发球好'],
        note: '反手要多练',
      }),
    },
    data: { level: 'advanced', grip: 'shakehand', tags: ['发球好'], note: '反手要多练' },
  })
  expect(res.status()).toBe(409)
  expect((await res.json()).error.code).toBe('edited_elsewhere')
  const detail = await call<{ profile: { level: string; note: string } }>(
    request,
    'GET',
    `/admin/students/${studentId}`,
    admin,
  )
  expect(detail.profile).toMatchObject({ level: 'elementary', note: '反手要多练，备赛' })
})
