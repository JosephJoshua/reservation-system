import { expect, type Page, test } from '@playwright/test'
import { ADMIN_PASSWORD, call, field, login, student } from './helpers'

// ⌘K, J / K through lists, and switches in lists that take effect at once with 撤销.
test.describe.configure({ mode: 'serial' })

const run = Date.now().toString(36)
const studentName = `快捷${run}`
const productName = `快捷包${run}`
let studentId = 0

const menu = (page: Page) => page.locator('.command-menu .t-dialog')
const search = (page: Page) => page.getByRole('combobox', { name: '快捷菜单' })
const openMenu = async (page: Page) => {
  // The keys work once the signed-in header is up.
  await expect(page.getByRole('button', { name: '快捷菜单' })).toBeVisible()
  await page.keyboard.press('ControlOrMeta+k')
  await expect(search(page)).toBeFocused()
}

test('sets up a student and a package', async ({ request }) => {
  const admin = (
    await call<{ token: string }>(request, 'POST', '/admin/login', undefined, {
      username: 'admin',
      password: ADMIN_PASSWORD,
    })
  ).token
  const token = await student(request, `menu-${run}`)
  studentId = (
    await call<{ id: number }>(request, 'PUT', '/me', token, {
      name: studentName,
      phone: '13900000071',
    })
  ).id
  const lesson = await call<{ id: number }>(request, 'POST', '/admin/lesson-types', admin, {
    name: `快捷课${run}`,
    durationMinutes: 60,
    price: 20000,
  })
  await call(request, 'POST', '/admin/package-products', admin, {
    name: productName,
    lessonTypeId: lesson.id,
    lessonCount: 5,
    price: 100000,
    validityDays: 90,
  })
})

test('⌘K goes to a page, a part of 设置 or a student', async ({ page }) => {
  await login(page)
  await openMenu(page)
  // Everything is listed before anything is typed.
  await expect(page.getByRole('option', { name: /^课时包/ })).toBeVisible()
  await expect(page.getByRole('option', { name: '外观：深色' })).toBeAttached()
  await search(page).fill('课时包')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/#\/products$/)
  await expect(menu(page)).toBeHidden()

  await openMenu(page)
  await search(page).fill('签到')
  // Arrows move the choice; 今日 comes first, then the 签到 part of 设置.
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('option', { selected: true })).toContainText('设置 · 签到')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/#\/settings\?section=attendance$/)

  await openMenu(page)
  await search(page).fill(studentName)
  await expect(page.getByRole('option', { name: new RegExp(`^${studentName}`) })).toBeVisible()
  await page.getByRole('option', { name: new RegExp(`^${studentName}`) }).click()
  await expect(page).toHaveURL(new RegExp(`#/students/${studentId}$`))

  await openMenu(page)
  await search(page).fill(`没有这个${run}`)
  await expect(menu(page)).toContainText('没有找到学员')
  await page.keyboard.press('Escape')
  await expect(menu(page)).toBeHidden()
})

test('⌘K starts 代约 and switches to dark', async ({ page }) => {
  await login(page)
  await openMenu(page)
  await search(page).fill('代约')
  await page.keyboard.press('Enter')
  await expect(page.locator('.t-dialog__header', { hasText: /^代约$/ })).toBeVisible()
  await expect(menu(page)).toBeHidden()
  await page.keyboard.press('Escape')

  await openMenu(page)
  await search(page).fill('深色')
  await page.keyboard.press('Enter')
  await expect(page.locator('html')).toHaveAttribute('theme-mode', 'dark')
  await openMenu(page)
  await search(page).fill('跟随系统')
  await page.keyboard.press('Enter')
  await expect(page.locator('html')).toHaveAttribute('theme-mode', 'light')
})

test('⌘K asks before leaving unsaved changes', async ({ page }) => {
  await login(page)
  await page.goto('./#/settings')
  await field(page, '电话').locator('input').fill(`010-${run}`)
  await openMenu(page)
  await search(page).fill('订单')
  await page.keyboard.press('Enter')
  await expect(page.getByText('放弃未保存的修改？')).toBeVisible()
  await page.getByRole('button', { name: '继续编辑' }).click()
  await expect(page).toHaveURL(/#\/settings/)
})

test('on 设置, ⌘K scrolls to a section and keeps the unsaved edit without asking', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await login(page)
  await page.goto('./#/settings')
  await field(page, '电话').locator('input').fill(`020-${run}`)
  await openMenu(page)
  await search(page).fill('课时费')
  await page.getByRole('option', { name: '设置 · 课时费' }).click()
  await expect(page.getByText('放弃未保存的修改？')).toHaveCount(0)
  await expect(page.locator('.t-card__title', { hasText: '课时费' })).toBeInViewport()
  await expect(page).toHaveURL(/#\/settings\?section=pay$/)
  await expect(field(page, '电话').locator('input')).toHaveValue(`020-${run}`)

  // 设置 itself, from a section of it, goes to the top without asking.
  await openMenu(page)
  await search(page).fill('设置')
  await expect(page.getByRole('option', { selected: true })).toHaveText(/^设置系统$/)
  await page.keyboard.press('Enter')
  await expect(page.getByText('放弃未保存的修改？')).toHaveCount(0)
  await expect(page).toHaveURL(/#\/settings$/)
  await expect(field(page, '电话').locator('input')).toHaveValue(`020-${run}`)
  // The edit is still guarded when leaving for real.
  await page.getByRole('link', { name: '订单' }).click()
  await expect(page.getByText('放弃未保存的修改？')).toBeVisible()
  await page.getByRole('button', { name: '继续编辑' }).click()
  await expect(page).toHaveURL(/#\/settings$/)
})

test('the forward button asks too, and goes forward once left', async ({ page }) => {
  await login(page)
  await page.goto('./#/settings')
  await page.goto('./#/orders')
  await page.goBack()
  await expect(page).toHaveURL(/#\/settings$/)
  await field(page, '电话').locator('input').fill(`030-${run}`)
  await page.goForward()
  await expect(page.getByText('放弃未保存的修改？')).toBeVisible()
  await page.getByRole('button', { name: '放弃修改' }).click()
  await expect(page).toHaveURL(/#\/orders$/)
  await expect(page.locator('.admin-title-text')).toHaveText('订单')
  // The pass to leave was used up: a new edit is asked about again.
  await page.goBack()
  await expect(page).toHaveURL(/#\/settings$/)
  await field(page, '电话').locator('input').fill(`031-${run}`)
  await page.getByRole('link', { name: '订单' }).click()
  await expect(page.getByText('放弃未保存的修改？')).toBeVisible()
})

test('⌘K gives the focus back after an item that stays on the page', async ({ page }) => {
  await login(page)
  await page.goto('./#/products')
  await page.getByRole('button', { name: '导出' }).focus()
  await openMenu(page)
  await search(page).fill('深色')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: '导出' })).toBeFocused()
  await openMenu(page)
  await search(page).fill('跟随系统')
  await page.keyboard.press('Enter')

  // Esc closes it with the focus outside the field too.
  await openMenu(page)
  await menu(page).locator('.command-hint').click()
  await page.keyboard.press('Escape')
  await expect(menu(page)).toBeHidden()
})

test('⌘K waits while a dialog is open, and gives the focus back when closed', async ({ page }) => {
  await login(page)
  await page.goto('./#/coaches?tab=categories')
  await page.getByRole('button', { name: '新建类别' }).click()
  await expect(page.locator('.t-dialog__header', { hasText: '新建类别' })).toBeVisible()
  await page.keyboard.press('ControlOrMeta+k')
  await expect(menu(page)).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.locator('.t-dialog__header', { hasText: '新建类别' })).toBeHidden()

  await page.getByRole('button', { name: '新建类别' }).focus()
  await openMenu(page)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: '新建类别' })).toBeFocused()
})

test('J and K move through the students and Enter opens one', async ({ page }) => {
  await login(page)
  await page.goto('./#/students')
  const box = page.getByPlaceholder('姓名或手机号', { exact: true })
  await box.fill(studentName)
  await expect(page.locator('.t-table tbody tr')).toHaveCount(1)
  await expect(page.getByRole('link', { name: studentName })).toBeVisible()
  // Typed into the search, J is a letter.
  await box.press('j')
  await expect(box).toHaveValue(`${studentName}j`)
  await box.fill(studentName)
  await expect(page.getByRole('link', { name: studentName })).toBeVisible()
  await box.blur()
  await page.keyboard.press('j')
  await expect(page.locator('tr.row-cursor')).toContainText(studentName)
  await page.keyboard.press('Escape')
  await expect(page.locator('tr.row-cursor')).toHaveCount(0)
  await page.keyboard.press('k')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`#/students/${studentId}$`))
})

test('a package goes off sale at once and 撤销 puts it back', async ({ page }) => {
  await login(page)
  await page.goto('./#/products')
  const row = page.locator('tr', { hasText: productName })
  const onSale = row.getByRole('switch')
  await expect(onSale).toHaveAttribute('aria-checked', 'true')
  await onSale.click()
  const message = page.locator('.t-message', { hasText: `已下架：${productName}` })
  await expect(message).toBeVisible()
  await expect(onSale).toHaveAttribute('aria-checked', 'false')
  await message.getByRole('button', { name: '撤销' }).click()
  await expect(page.getByText('已撤销')).toBeVisible()
  await expect(onSale).toHaveAttribute('aria-checked', 'true')
  await page.reload()
  await expect(page.locator('tr', { hasText: productName }).getByRole('switch')).toHaveAttribute(
    'aria-checked',
    'true',
  )
})

test('the menu button is left out on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page)
  await expect(page.getByRole('button', { name: '快捷菜单' })).toHaveCount(0)
})
