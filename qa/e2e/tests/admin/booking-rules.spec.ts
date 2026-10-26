// Booking rules per lesson type: a lesson type follows the venue's 默认预约规则 until a rule is set
// on its own, and goes back to it with 恢复默认.
import { expect, type Page, test } from '@playwright/test'
import type { CatalogDto, LessonTypeDto } from '@rs/shared'
import {
  ADMIN_PASSWORD,
  call,
  editForm,
  field,
  login,
  saveEdit,
  student,
  typeNumber,
} from './helpers'

test.describe.configure({ mode: 'serial' })

const run = Date.now().toString(36)
const lessonName = `规则课${run}`
const shots = 'test-results/booking-rules'

let admin = ''
let lessonTypeId = 0

async function both(page: Page, name: string) {
  await page.screenshot({ path: `${shots}/${name}-light.png` })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${shots}/${name}-dark.png` })
  await page.emulateMedia({ colorScheme: 'light' })
}

async function rulesSeenByStudents(request: Parameters<typeof call>[0]) {
  const token = await student(request, `rules-${run}`)
  const catalog = await call<CatalogDto>(request, 'GET', '/catalog', token)
  return catalog.lessonTypes.find((t: LessonTypeDto) => t.id === lessonTypeId)?.rules
}

function lessonRow(page: Page) {
  return page.locator('tbody tr', { hasText: lessonName })
}

async function openEditor(page: Page) {
  await page.goto('./#/courses')
  await lessonRow(page).getByRole('button', { name: '编辑' }).click()
  await expect(editForm(page).getByText('预约规则', { exact: true })).toBeVisible()
}

test.beforeAll(async ({ request }) => {
  const res = await request.post('http://localhost:8787/api/admin/login', {
    data: { username: 'admin', password: ADMIN_PASSWORD },
  })
  admin = (await res.json()).token
  const created = await call<{ id: number }>(request, 'POST', '/admin/lesson-types', admin, {
    name: lessonName,
    durationMinutes: 60,
    price: 10000,
  })
  lessonTypeId = created.id
})

test('a new lesson type follows every default', async ({ page, request }) => {
  await login(page)
  await openEditor(page)
  for (const label of ['可提前预约', '最晚预约', '免费取消', '晚于此时取消', '学员改约']) {
    await expect(field(editForm(page), label)).toContainText('跟随默认')
  }
  await expect(field(editForm(page), '免费取消')).toContainText('开课前 24 小时以上')
  // Nothing changed, so going back to the list asks nothing.
  await page.locator('.breadcrumb').getByRole('link', { name: '课程' }).click()
  await expect(lessonRow(page)).toContainText('默认')
  expect(await rulesSeenByStudents(request)).toMatchObject({ cancelDeadlineHours: 24 })
})

test('sets two rules on their own and shows them in the list and settings', async ({
  page,
  request,
}) => {
  await login(page)
  await openEditor(page)
  const d = editForm(page)
  await field(d, '免费取消').getByRole('button', { name: '单独设置' }).click()
  // Odd input stays in range.
  const hours = field(d, '免费取消').locator('input')
  await typeNumber(hours, '999')
  await d.locator('.form-section-title').click()
  await expect(hours).toHaveValue('336')
  await typeNumber(hours, '48')
  await d.locator('.form-section-title').click()
  await expect(field(d, '免费取消')).toContainText('默认：开课前 24 小时以上')

  await field(d, '晚于此时取消').getByRole('button', { name: '单独设置' }).click()
  await field(d, '晚于此时取消').getByText('按比例退款').click()
  await typeNumber(field(d, '晚于此时取消').locator('.t-input-number input'), '50')
  await d.locator('.form-section-title').click()
  await field(d, '学员改约').scrollIntoViewIfNeeded()
  await both(page, 'editor-own')

  // A rule set on its own, then put back before saving, is not saved.
  await field(d, '学员改约').getByRole('button', { name: '单独设置' }).click()
  await field(d, '学员改约').getByRole('button', { name: '恢复默认' }).click()
  await expect(field(d, '学员改约')).toContainText('跟随默认')

  await saveEdit(page)
  await expect(page.getByText('已保存').last()).toBeVisible()
  await expect(lessonRow(page)).toContainText('单独设置 2 项')
  expect(await rulesSeenByStudents(request)).toEqual({
    advanceDays: 14,
    minNoticeMinutes: 120,
    cancelDeadlineHours: 48,
    lateCancel: { kind: 'partial', percent: 50 },
    studentMoves: 1,
  })

  await page.goto('./#/settings')
  const card = page.locator('.t-card', { hasText: '默认预约规则' })
  await expect(card).toContainText(`${lessonName}（免费取消、逾时取消）`)
  await card.scrollIntoViewIfNeeded()
  await both(page, 'settings')
  await card.getByRole('link', { name: '去修改' }).click()
  await expect(lessonRow(page)).toBeVisible()
})

test('恢复默认 puts every rule back', async ({ page, request }) => {
  await login(page)
  await openEditor(page)
  const d = editForm(page)
  for (const label of ['免费取消', '晚于此时取消']) {
    await field(d, label).getByRole('button', { name: '恢复默认' }).click()
  }
  await saveEdit(page)
  await expect(page.getByText('已保存').last()).toBeVisible()
  await expect(lessonRow(page)).toContainText('默认')
  expect(await rulesSeenByStudents(request)).toMatchObject({
    cancelDeadlineHours: 24,
    lateCancel: { kind: 'forfeit' },
  })
  // Turned off so student-facing specs do not see it.
  await call(request, 'PUT', `/admin/lesson-types/${lessonTypeId}`, admin, {
    name: lessonName,
    durationMinutes: 60,
    price: 10000,
    active: false,
  })
})
