import { expect, type Page, test } from '@playwright/test'
import { ADMIN_PASSWORD, addExtraTimes, call, dialog, login, student, typeNumber } from './helpers'

// Lessons left to sort out: a 加班 removed under a booked lesson, and a coach who stopped.
test.describe.configure({ mode: 'serial' })

const run = Date.now().toString(36)
const coachName = `待处理教练${run}`
const otherName = `停用教练${run}`
// Two days from now at the venue, so the lessons are a while off.
const venueDate = new Date(Date.now() + 2 * 86_400_000 + 8 * 3_600_000).toISOString().slice(0, 10)
const at = (hhmm: string) => `${venueDate}T${hhmm}:00+08:00`
const shots = 'test-results/schedule-conflicts'

let admin = ''
let coachId = 0
let otherId = 0

async function both(page: Page, name: string) {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.screenshot({ path: `${shots}/${name}-light.png` })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${shots}/${name}-dark.png` })
  await page.emulateMedia({ colorScheme: 'light' })
}

test('sets up two coaches with booked lessons', async ({ request }) => {
  admin = (
    await call<{ token: string }>(request, 'POST', '/admin/login', undefined, {
      username: 'admin',
      password: ADMIN_PASSWORD,
    })
  ).token
  const lessonTypeId = (
    await call<{ id: number }>(request, 'POST', '/admin/lesson-types', admin, {
      name: `待处理课${run}`,
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
  otherId = (
    await call<{ id: number }>(request, 'POST', '/admin/coaches', admin, {
      name: otherName,
      lessonTypeIds: [lessonTypeId],
    })
  ).id
  await addExtraTimes(request, admin, coachId, [{ startsAt: at('09:00'), endsAt: at('12:00') }])
  await addExtraTimes(request, admin, otherId, [{ startsAt: at('14:00'), endsAt: at('16:00') }])
  for (const [name, id, time] of [
    [`学员甲${run}`, coachId, '10:00'],
    [`学员乙${run}`, otherId, '14:00'],
  ] as const) {
    const token = await student(request, name)
    await call(request, 'PUT', '/me', token, { name, phone: '13700137002' })
    const booked = await call<{ orderId: number }>(request, 'POST', '/bookings', token, {
      coachId: id,
      startsAt: at(time),
      lessonTypeId,
    })
    await call(request, 'POST', `/dev/fake-pay/${booked.orderId}`, token)
  }
  // The second coach stops; their lesson stays.
  await call(request, 'PUT', `/admin/coaches/${otherId}`, admin, {
    name: otherName,
    lessonTypeIds: [lessonTypeId],
    active: false,
  })
})

test('removing a 加班 lists the lesson left in it, and the board says why', async ({ page }) => {
  await login(page)
  await page.goto('./#/coaches')
  await page
    .getByRole('row')
    .filter({ hasText: coachName })
    .getByRole('button', { name: '排班' })
    .click()
  const extra = dialog(page).locator('.exception-row', { hasText: '加班' })
  await expect(extra).toHaveCount(1)
  await extra.getByRole('button', { name: '取消' }).click()
  await page.locator('.t-popconfirm').getByRole('button', { name: '取消' }).click()
  await expect(page.locator('.t-message', { hasText: '已取消加班' })).toBeVisible()
  const list = dialog(page).locator('.t-alert', { hasText: '不在排班里' })
  await expect(list).toContainText('有 1 节课不在排班里，课程不会自动取消，请改约或取消')
  await expect(list).toContainText(`学员甲${run}`)
  await list.scrollIntoViewIfNeeded()
  await both(page, 'remove-extra')
  await dialog(page).getByRole('button', { name: '关闭' }).click()

  await page.goto('./#/schedule')
  const alert = page.locator('.board-alert')
  await expect(alert).toContainText('需要改约或取消')
  await alert.getByRole('button', { name: '查看' }).click()
  await expect(
    alert.getByRole('button', { name: new RegExp(`${coachName} 学员甲${run} · 不在排班里`) }),
  ).toBeVisible()
  await expect(
    alert.getByRole('button', { name: new RegExp(`${otherName} 学员乙${run} · 教练已停用`) }),
  ).toBeVisible()
  await both(page, 'board')

  // Agreed with the coach: the lesson stays where it is and leaves the list.
  const row = alert.locator('div', { hasText: `学员甲${run} · 不在排班里` }).last()
  await row.getByRole('button', { name: '已与教练确认' }).click()
  await expect(page.locator('.t-popconfirm')).toContainText('课程保留，不再提示')
  // Past the popup's fade-in.
  await page.waitForTimeout(300)
  await both(page, 'keep-outside')
  await page.locator('.t-popconfirm').getByRole('button', { name: '已确认' }).click()
  await expect(page.locator('.t-message', { hasText: '已保留' })).toBeVisible()
  await expect(alert.getByText(`学员甲${run}`)).toHaveCount(0)
  await expect(alert.getByText(`学员乙${run}`)).toBeVisible()
})

test("a session takes no more than its class's 上课人数", async ({ page, request }) => {
  const groupName = `待处理小班${run}`
  const group = await call<{ id: number }>(request, 'POST', '/admin/lesson-types', admin, {
    name: groupName,
    durationMinutes: 60,
    price: 8000,
    capacity: 4,
  })
  await call(request, 'PUT', `/admin/coaches/${coachId}`, admin, {
    name: coachName,
    lessonTypeIds: [group.id],
  })
  await call(request, 'POST', '/admin/sessions', admin, {
    lessonTypeId: group.id,
    capacity: 4,
    sessions: [{ coachId, startsAt: at('17:00'), endsAt: at('18:00') }],
  })
  await login(page)
  await page.goto('./#/schedule')
  await page.getByRole('button', { name: '后一天' }).click()
  await page.getByRole('button', { name: '后一天' }).click()
  await page.getByPlaceholder('搜索教练').fill(coachName)
  await page.locator('.board-block', { hasText: `${groupName} 0/4` }).click()
  const seats = dialog(page).locator('.t-input-number input')
  await typeNumber(seats, '6')
  await expect(dialog(page).getByText('人数需在 2 到 4 之间')).toBeVisible()
  await expect(dialog(page).locator('.t-button', { hasText: '保存' })).toHaveClass(/t-is-disabled/)
  await both(page, 'session-seats')
})
