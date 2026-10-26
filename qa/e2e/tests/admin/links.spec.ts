// 点击跳转: the searchable picker for where a banner or the home notice goes in the mini program.
import { expect, test } from '@playwright/test'
import type { HomeDto } from '@rs/shared'
import { ADMIN_PASSWORD, call, editForm, field, login, saveEdit } from './helpers'

const run = Date.now().toString(36)
const coachName = `跳转教练${run}`
const bannerTitle = `跳转${run}`

test('picks a coach for a banner by searching, and Esc closes only the list', async ({
  page,
  request,
}) => {
  const { token } = await call<{ token: string }>(request, 'POST', '/admin/login', undefined, {
    username: 'admin',
    password: ADMIN_PASSWORD,
  })
  await call(request, 'POST', '/admin/coaches', token, { name: coachName, title: '一级教练' })
  await call(request, 'POST', '/admin/banners', token, {
    imageUrl: '/api/uploads/none.png',
    title: bannerTitle,
  })

  await login(page)
  await page.goto('./#/banners')
  const row = page.locator('tr', { hasText: bannerTitle })
  await expect(row).toContainText('无')
  await row.getByRole('button', { name: '编辑' }).click()
  const picker = field(editForm(page), '点击跳转')
  await picker.locator('.t-select').click()
  await page.keyboard.type(run)
  // Only the coach group is left; the other groups have no match.
  await expect(page.locator('.t-select-option')).toHaveText([`${coachName} · 一级教练`])
  await page.keyboard.press('Escape')
  await expect(page.locator('.t-select-option:visible')).toHaveCount(0)
  await expect(page.locator('.edit-page')).toBeVisible()
  await picker.locator('.t-select').click()
  await page.keyboard.type(coachName)
  await page.locator('.t-select-option', { hasText: coachName }).click()
  await expect(picker).toContainText(`学员点击后打开${coachName}的教练介绍页`)
  await saveEdit(page)
  await expect(row).toContainText(`教练：${coachName}`)

  const home = await call<HomeDto>(request, 'GET', '/home')
  const banner = home.banners.find((b) => b.title === bannerTitle)
  expect(banner?.linkKind).toBe('coach')
})

test('the home notice can link to a page', async ({ page, request }) => {
  await login(page)
  await page.goto('./#/banners')
  const card = page.locator('.t-card', { hasText: '首页公告' })
  await field(card, '公告').locator('input').fill(`公告${run}`)
  await field(card, '点击跳转').locator('.t-select').click()
  await page.locator('.t-select-option', { hasText: '预约须知' }).click()
  await expect(card).toContainText('学员点击后打开预约须知全文')
  await page.locator('.save-bar').getByRole('button', { name: '保存' }).click()
  await expect(page.getByText('已保存')).toBeVisible()
  const home = await call<HomeDto>(request, 'GET', '/home')
  expect(home.noticeLink).toEqual({ linkKind: 'booking_policy', linkId: null })
})
