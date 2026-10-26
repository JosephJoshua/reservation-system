import { expect, test } from '@playwright/test'
import { ADMIN_PASSWORD, addExtraTimes, call, editForm, field, login, student } from './helpers'

// How front-desk payments, student cancels and coach changes show up for the desk.
test.describe.configure({ mode: 'serial' })

const run = Date.now().toString(36)
const coachName = `跨功能教练${run}`
const studentName = `跨功能${run}`
// Two days ahead at the venue, so a student cancel is in time.
const venueDate = new Date(Date.now() + 2 * 86_400_000 + 8 * 3_600_000).toISOString().slice(0, 10)

let admin = ''
let token = ''
let studentId = 0
let lessonTypeId = 0
const times: { coachId: number; startsAt: string }[] = []

test('sets up a coach with two lesson times and a student', async ({ request }) => {
  admin = (
    await call<{ token: string }>(request, 'POST', '/admin/login', undefined, {
      username: 'admin',
      password: ADMIN_PASSWORD,
    })
  ).token
  lessonTypeId = (
    await call<{ id: number }>(request, 'POST', '/admin/lesson-types', admin, {
      name: `跨功能课${run}`,
      durationMinutes: 60,
      price: 20000,
    })
  ).id
  const coachId = (
    await call<{ id: number }>(request, 'POST', '/admin/coaches', admin, {
      name: coachName,
      lessonTypeIds: [lessonTypeId],
    })
  ).id
  const spans = [10, 11].map((h) => ({
    startsAt: `${venueDate}T${h}:00:00+08:00`,
    endsAt: `${venueDate}T${h + 1}:00:00+08:00`,
  }))
  await addExtraTimes(request, admin, coachId, spans)
  times.push(...spans.map((s) => ({ coachId, startsAt: s.startsAt })))
  token = await student(request, studentName)
  await call(request, 'PUT', '/me', token, { name: studentName, phone: '13600136000' })
  studentId = (await call<{ id: number }>(request, 'GET', '/me', token)).id
})

test('a cash 代约 the student cancels shows on the overview as owed and clears once handed back', async ({
  page,
  request,
}) => {
  const { bookingId } = await call<{ bookingId: number }>(
    request,
    'POST',
    '/admin/bookings',
    admin,
    {
      studentId,
      ...times[0],
      lessonTypeId,
      payWith: 'offline',
      amount: 20000,
      method: 'cash',
    },
  )
  await call(request, 'POST', `/bookings/${bookingId}/cancel`, token, {})

  await login(page)
  const tile = page.locator('a', { hasText: '待线下退还' })
  // The count shows "-" until the overview loads.
  await expect(tile.locator('.todo-value')).toHaveText(/^\d+$/)
  const owed = Number(await tile.locator('.todo-value').textContent())
  expect(owed).toBeGreaterThan(0)
  await tile.click()
  await expect(page).toHaveURL(/#\/refunds\?status=pending/)
  const row = page.getByRole('row', { name: new RegExp(studentName) })
  await expect(row).toContainText('待线下退还')
  await row.getByRole('button', { name: '已退还' }).click()
  await page.locator('.t-popconfirm').getByRole('button', { name: '已退还' }).dblclick()
  await expect(row).toHaveCount(0)

  await page.goto('./#/overview')
  await expect(page.locator('a', { hasText: '待线下退还' }).locator('.todo-value')).toHaveText(
    String(owed - 1),
  )
})

test('turning a coach with booked lessons off says what happens to them', async ({
  page,
  request,
}) => {
  await call(request, 'POST', '/admin/bookings', admin, {
    studentId,
    ...times[1],
    lessonTypeId,
    payWith: 'offline',
    amount: 0,
  })
  await login(page)
  await page.goto('./#/coaches')
  await page
    .getByRole('row', { name: new RegExp(coachName) })
    .getByText('编辑', { exact: true })
    .click()
  const active = field(editForm(page), '在职')
  await expect(active).not.toContainText('节课未上')
  await active.locator('.t-switch').click()
  await expect(active).toContainText('还有 1 节课未上')
  await active.locator('.t-switch').click()
  await expect(active).not.toContainText('节课未上')
})
