import { expect, test } from '@playwright/test'
import { call, dialog, login, student } from './helpers'

// Unique per run, since the e2e database is kept between runs.
const phone = () => `139${String(Date.now()).slice(-8)}`

test('adds a student at the desk and links their WeChat with the bind code', async ({
  page,
  request,
}) => {
  const number = phone()
  await login(page)
  await page.goto('./#/students')
  await page.getByRole('button', { name: '前台建档' }).click()
  await dialog(page).getByPlaceholder('上课学员姓名').fill('前台学员')
  await dialog(page).getByPlaceholder('11 位手机号').fill(number)
  // A double click adds one student.
  await dialog(page).getByRole('button', { name: '建档', exact: true }).dblclick()
  await expect(page.getByText('未绑定微信。学员可以直接来上课')).toBeVisible()
  const id = Number(new URL(page.url().replace('#', '')).searchParams.get('id'))

  await page.getByRole('button', { name: '绑定微信' }).click()
  const code = ((await page.locator('.bind-code').textContent()) ?? '').replace(/\s/g, '')
  expect(code).toHaveLength(8)

  const token = await student(request, `desk-${number}`)
  await call(request, 'POST', '/me/link', token, { code })
  await expect(dialog(page).getByText('已绑定微信')).toBeVisible({ timeout: 10_000 })
  await dialog(page).getByRole('button', { name: '完成' }).click()
  await expect(page.getByText('未绑定微信。学员可以直接来上课')).toBeHidden()

  const me = await call<{ id: number; name: string }>(request, 'GET', '/me', token)
  expect(me).toMatchObject({ id, name: '前台学员' })
})

test('warns about a phone another student has and flags both', async ({ page }) => {
  const number = phone()
  await login(page)
  await page.goto('./#/students')
  for (const name of ['甲', '乙']) {
    await page.getByRole('button', { name: '前台建档' }).click()
    await dialog(page).getByPlaceholder('上课学员姓名').fill(name)
    await dialog(page).getByPlaceholder('11 位手机号').fill(number)
    if (name === '乙') {
      await expect(dialog(page).getByText('该手机号已是学员')).toBeVisible()
      await dialog(page).getByRole('button', { name: '仍然新建' }).click()
    } else {
      await dialog(page).getByRole('button', { name: '建档', exact: true }).click()
    }
    await expect(page.locator('.t-drawer')).toBeVisible()
    await page.goto('./#/students')
  }
  await expect(page.getByText('手机号与')).toBeHidden()
  await page.getByPlaceholder('姓名或手机号', { exact: true }).fill(number)
  await expect(page.getByText('手机号重复')).toHaveCount(2)
})
