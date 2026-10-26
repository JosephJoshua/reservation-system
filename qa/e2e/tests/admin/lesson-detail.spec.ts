import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { ADMIN_PASSWORD, addExtraTimes, call, dialog, login, student, tab } from './helpers'

// 课程详情: one lesson opened over the lists or as a page, and 课后点评 as a tab of 预约.
test.describe.configure({ mode: 'serial' })

const run = Date.now().toString(36)
const coachName = `详情教练${run}`
const groupName = `详情小班${run}`
const privateName = `详情私教${run}`
const shots = join(import.meta.dirname, '../../test-results/lesson-detail')
// Two days ahead at the venue.
const venueDate = new Date(Date.now() + 2 * 86_400_000 + 8 * 3_600_000).toISOString().slice(0, 10)
const day = `${Number(venueDate.slice(5, 7))}月${Number(venueDate.slice(8))}日`

let admin = ''
let coach = 0
let singleType = 0
let sessionId = 0
let privateSlot = 0
let privateBooking = 0
const names = ['甲', '乙', '丙'].map((n) => `详情${n}${run}`)
const ids: number[] = []

const drawer = (page: Page) => page.locator('.t-drawer:visible')

async function both(page: Page, name: string) {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForTimeout(200)
    await page.screenshot({ path: `${shots}/${name}-${scheme}.png` })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

test('sets up a group session with two students and a private lesson', async ({ request }) => {
  admin = (
    await call<{ token: string }>(request, 'POST', '/admin/login', undefined, {
      username: 'admin',
      password: ADMIN_PASSWORD,
    })
  ).token
  const group = await call<{ id: number }>(request, 'POST', '/admin/lesson-types', admin, {
    name: groupName,
    durationMinutes: 60,
    price: 8000,
    capacity: 4,
  })
  const single = await call<{ id: number }>(request, 'POST', '/admin/lesson-types', admin, {
    name: privateName,
    durationMinutes: 60,
    price: 20000,
  })
  const coachId = (
    await call<{ id: number }>(request, 'POST', '/admin/coaches', admin, {
      name: coachName,
      lessonTypeIds: [group.id, single.id],
    })
  ).id
  sessionId = (
    await call<{ ids: number[] }>(request, 'POST', '/admin/sessions', admin, {
      lessonTypeId: group.id,
      capacity: 4,
      sessions: [
        {
          coachId,
          startsAt: `${venueDate}T10:00:00+08:00`,
          endsAt: `${venueDate}T11:00:00+08:00`,
        },
      ],
    })
  ).ids[0] as number
  coach = coachId
  singleType = single.id
  await addExtraTimes(request, admin, coachId, [
    { startsAt: `${venueDate}T14:00:00+08:00`, endsAt: `${venueDate}T15:00:00+08:00` },
  ])
  for (const name of names) {
    const token = await student(request, name)
    await call(request, 'PUT', '/me', token, { name, phone: '13700137000' })
    ids.push((await call<{ id: number }>(request, 'GET', '/me', token)).id)
  }
  for (const studentId of ids.slice(0, 2)) {
    await call(request, 'POST', '/admin/bookings', admin, {
      studentId,
      slotId: sessionId,
      lessonTypeId: group.id,
      payWith: 'offline',
      amount: 8000,
      method: 'cash',
    })
  }
  privateBooking = (
    await call<{ bookingId: number }>(request, 'POST', '/admin/bookings', admin, {
      studentId: ids[2],
      coachId,
      startsAt: `${venueDate}T14:00:00+08:00`,
      lessonTypeId: single.id,
      payWith: 'offline',
      amount: 20000,
      method: 'cash',
    })
  ).bookingId
  const [b] = await call<{ slotId: number }[]>(
    request,
    'GET',
    `/admin/bookings?id=${privateBooking}`,
    admin,
  )
  privateSlot = b?.slotId ?? 0
})

/** 预约 for the lesson day, with the class's coach only. */
async function bookingsOfTheDay(page: Page) {
  await page.goto(`./#/bookings?from=${venueDate}&to=${venueDate}`)
  await page.getByPlaceholder('全部教练').click()
  await page.locator('.t-select-option', { hasText: coachName }).click()
}

test('a lesson opens over 预约 with its students, and Esc closes it', async ({ page }) => {
  await login(page)
  await bookingsOfTheDay(page)
  const row = page.getByRole('row').filter({ hasText: names[0] })
  await row.locator('.lesson-link').click()
  await expect(page).toHaveURL(new RegExp(`lesson=${sessionId}`))
  await expect(drawer(page)).toContainText(`${day}`)
  await expect(drawer(page)).toContainText('已报名 2/4 人')
  await expect(
    drawer(page)
      .getByRole('row')
      .filter({ hasText: /详情[甲乙]/ }),
  ).toHaveCount(2)
  await expect(drawer(page).getByRole('link', { name: names[0] })).toHaveAttribute(
    'href',
    `#/students/${ids[0]}`,
  )
  await both(page, 'session-drawer')
  await page.keyboard.press('Escape')
  await expect(drawer(page)).toHaveCount(0)
  await expect(page).not.toHaveURL(/lesson=/)
  // The filters stay in the address.
  await expect(page).toHaveURL(new RegExp(`from=${venueDate}&to=${venueDate}`))
})

test('closing the lesson leaves no extra step for back', async ({ page }) => {
  await login(page)
  await page.goto('./#/overview')
  await bookingsOfTheDay(page)
  await page.getByRole('row').filter({ hasText: names[0] }).locator('.lesson-link').click()
  await expect(drawer(page)).toContainText('已报名')
  await drawer(page).locator('.t-drawer__close-btn').click()
  await expect(drawer(page)).toHaveCount(0)
  await expect(page).toHaveURL(new RegExp(`#/bookings\\?from=${venueDate}`))
  await page.goBack()
  await expect(page).toHaveURL(/#\/overview$/)
})

test('back closes the lesson, and a refresh keeps it open', async ({ page }) => {
  await login(page)
  await bookingsOfTheDay(page)
  await page.getByRole('row').filter({ hasText: names[0] }).locator('.lesson-link').click()
  await expect(drawer(page)).toContainText('已报名 2/4 人')
  await page.reload()
  await expect(drawer(page)).toContainText('已报名 2/4 人')
  await page.goBack()
  await expect(drawer(page)).toHaveCount(0)
  await expect(page.getByRole('row').filter({ hasText: names[0] })).toBeVisible()
})

test('a seat cancelled in the lesson shows in the list behind and in 记录', async ({ page }) => {
  await login(page)
  await bookingsOfTheDay(page)
  await page.getByRole('row').filter({ hasText: names[1] }).locator('.lesson-link').click()
  await drawer(page)
    .getByRole('row')
    .filter({ hasText: names[1] })
    .getByRole('button', { name: '取消' })
    .click()
  await dialog(page).locator('textarea').fill('学员请假')
  await dialog(page).getByRole('button', { name: '确认取消' }).dblclick()
  await expect(drawer(page)).toContainText('已报名 1/4 人')
  await expect(drawer(page).locator('.t-card', { hasText: '记录' })).toContainText('原因：学员请假')
  await page.keyboard.press('Escape')
  await expect(drawer(page)).toHaveCount(0)
  await expect(page.getByRole('row').filter({ hasText: names[1] })).toContainText('场馆取消')
})

test('代约加人 books a seat in the session', async ({ page }) => {
  await login(page)
  await page.goto(`./#/bookings?lesson=${sessionId}`)
  await drawer(page).getByRole('button', { name: '代约加人' }).click()
  const book = dialog(page).last()
  const picker = book.locator('.t-select').first().locator('input')
  await picker.click()
  await picker.pressSequentially(names[2] ?? '')
  await page.locator('.t-select-option', { hasText: names[2] }).click()
  await book.getByRole('button', { name: '确认代约' }).click()
  await expect(page.getByText('已代约')).toBeVisible()
  await expect(drawer(page)).toContainText('已报名 2/4 人')
})

test('a private lesson offers 改约 and 取消, and opens as a page', async ({ page }) => {
  await login(page)
  await page.goto(`./#/bookings?lesson=${privateSlot}`)
  await expect(drawer(page)).toContainText(privateName)
  await expect(drawer(page)).toContainText('已预约')
  await drawer(page).getByRole('button', { name: '改约' }).click()
  await expect(dialog(page).last()).toContainText('确认改约')
  await dialog(page).last().getByRole('button', { name: '返回' }).click()
  await drawer(page).getByRole('link', { name: '打开整页' }).click()
  await expect(page).toHaveURL(new RegExp(`#/lessons/${privateSlot}$`))
  await expect(page.locator('.admin-title-text')).toHaveText('课程详情')
  await expect(page.locator('.nav-item.active')).toHaveText('预约')
  await both(page, 'private-page')
  await page.getByRole('button', { name: '取消' }).click()
  await dialog(page).locator('textarea').fill('教练临时有事')
  await dialog(page).getByRole('button', { name: '确认取消' }).click()
  await expect(page.locator('.lesson-facts')).toContainText('已取消')
  await expect(page.getByRole('button', { name: '改约' })).toHaveCount(0)
})

test('a moved private lesson points to its new time', async ({ page, request }) => {
  const { bookingId } = await call<{ bookingId: number }>(
    request,
    'POST',
    '/admin/bookings',
    admin,
    {
      studentId: ids[0],
      coachId: coach,
      startsAt: `${venueDate}T16:00:00+08:00`,
      lessonTypeId: singleType,
      payWith: 'offline',
      amount: 0,
      anyTime: true,
    },
  )
  const [before] = await call<{ slotId: number }[]>(
    request,
    'GET',
    `/admin/bookings?id=${bookingId}`,
    admin,
  )
  await call(request, 'POST', `/admin/bookings/${bookingId}/move`, admin, {
    coachId: coach,
    startsAt: `${venueDate}T17:00:00+08:00`,
    anyTime: true,
  })
  await login(page)
  await page.goto(`./#/bookings?lesson=${before?.slotId}`)
  await expect(drawer(page)).toContainText('这节课已改约到')
  await drawer(page).getByRole('link', { name: /17:00/ }).click()
  await expect(drawer(page)).toContainText('17:00-18:00')
  await expect(drawer(page).locator('.t-card', { hasText: '记录' })).toContainText('改约')
})

test('the 操作记录 opens the lesson a booking is in', async ({ page }) => {
  await login(page)
  await page.goto('./#/actions')
  await page
    .getByRole('row')
    .filter({ hasText: names[2] })
    .filter({ hasText: privateName })
    .first()
    .getByRole('link')
    .first()
    .click()
  await expect(page).toHaveURL(new RegExp(`#/lessons/${privateSlot}$`))
  await expect(page.locator('.lesson-facts')).toContainText(privateName)
  await page.goBack()
  await expect(page).toHaveURL(/#\/actions$/)
})

test('a lesson that is not there says so', async ({ page }) => {
  await login(page)
  await page.goto('./#/lessons/999999')
  await expect(page.getByText('课程不存在')).toBeVisible()
  await page.goto('./#/lessons?booking=999999')
  await expect(page.getByText('没有找到这个预约')).toBeVisible()
})

test('课后点评 is a tab of 预约, and the old address opens it', async ({ page }) => {
  await login(page)
  await page.goto('./#/feedback')
  await expect(page).toHaveURL(/#\/bookings\?tab=feedback$/)
  await expect(page.locator('.admin-title-text')).toHaveText('预约')
  await expect(page.locator('.t-tab-panel:visible').getByPlaceholder('全部教练')).toBeVisible()
  const menu = page.getByRole('navigation', { name: '主菜单' })
  await expect(menu.getByRole('link', { name: '课后点评' })).toHaveCount(0)
  await tab(page, '预约').click()
  await expect(page).toHaveURL(/#\/bookings\?from=/)
  await both(page, 'bookings-tabs')
})

test('the 日程 board leads to the lesson', async ({ page }) => {
  await login(page)
  await page.goto('./#/schedule')
  for (let i = 0; i < 2; i++) await page.getByRole('button', { name: '后一天' }).click()
  await page.getByPlaceholder('搜索教练').fill(coachName)
  await page.locator('.board-block', { hasText: groupName }).click()
  await dialog(page).getByRole('link', { name: '查看课程详情' }).click()
  await expect(dialog(page)).toHaveCount(0)
  await expect(drawer(page)).toContainText(groupName)
})

test('on a phone the lesson fills the screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page)
  await page.goto(`./#/bookings?lesson=${sessionId}`)
  await expect(drawer(page)).toContainText('已报名')
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
  await both(page, 'session-phone')
})
