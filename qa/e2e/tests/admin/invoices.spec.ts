import { readFileSync } from 'node:fs'
import { type APIRequestContext, expect, test } from '@playwright/test'
import type { PackageDto } from '@rs/shared'
import { ADMIN_PASSWORD, API, call, dialog, listFilter, login, student } from './helpers'

// Students request invoices through the API; the front desk works the queue in the admin.
test.describe.configure({ mode: 'serial' })

const run = Date.now().toString(36)
const productName = `发票卡${run.slice(-5)}`
const personName = `开票${run.slice(-5)}`
const companyName = `某某${run.slice(-5)}科技有限公司`

async function adminToken(request: APIRequestContext) {
  const res = await request.post(`${API}/admin/login`, {
    data: { username: 'admin', password: ADMIN_PASSWORD },
  })
  return (await res.json()).token as string
}

/** A student who bought the package through WeChat Pay, with an invoice requested. */
async function requested(
  request: APIRequestContext,
  name: string,
  title: { kind: string; name: string; taxNumber: string; email: string },
) {
  const token = await student(request, `inv-${name}-${run}`)
  await call(request, 'PUT', '/me', token, { name, phone: '13900000011' })
  const catalog = await call<{ packageProducts: { id: number; name: string }[] }>(
    request,
    'GET',
    '/catalog',
    token,
  )
  const product = catalog.packageProducts.find((p) => p.name === productName)
  if (!product) throw new Error('setup missing')
  const { orderId } = await call<{ orderId: number }>(
    request,
    'POST',
    '/packages/purchase',
    token,
    {
      productId: product.id,
    },
  )
  await call(request, 'POST', `/dev/fake-pay/${orderId}`, token)
  await call(request, 'POST', '/invoices', token, { orderId, ...title })
  return token
}

test('sets up a package for sale', async ({ request }) => {
  const admin = await adminToken(request)
  const lesson = await call<{ id: number }>(request, 'POST', '/admin/lesson-types', admin, {
    name: `发票课${run.slice(-5)}`,
    durationMinutes: 60,
    price: 20000,
  })
  await call(request, 'POST', '/admin/package-products', admin, {
    name: productName,
    lessonTypeId: lesson.id,
    lessonCount: 10,
    price: 180000,
    validityDays: 90,
  })
})

test('uploads an invoice, rejects another, and exports the queue', async ({ page, request }) => {
  await requested(request, personName, {
    kind: 'personal',
    name: personName,
    taxNumber: '',
    email: 'lin@example.com',
  })
  await requested(request, `${personName}B`, {
    kind: 'company',
    name: companyName,
    taxNumber: '91110108ma01abcd2x',
    email: 'finance@example.com',
  })

  await login(page)
  await page.goto('./#/invoices')
  const person = page.getByRole('row').filter({ hasText: personName }).filter({ hasText: '个人' })
  const company = page.getByRole('row').filter({ hasText: companyName })
  await expect(person).toContainText('开票中')
  await expect(person).toContainText('¥1,800')
  // The tax number is upper-cased when it is saved.
  await expect(company).toContainText('91110108MA01ABCD2X')

  await person.getByRole('button', { name: '上传发票' }).click()
  await expect(dialog(page)).toContainText('lin@example.com')
  const confirm = dialog(page).locator('.t-button', { hasText: '确认开票' })
  await expect(confirm).toHaveClass(/t-is-disabled/)
  // Not a PDF: refused before uploading.
  await dialog(page)
    .locator('input[type=file]')
    .setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: Buffer.from('png') })
  await expect(dialog(page)).toContainText('请选择 PDF 文件')
  await expect(confirm).toHaveClass(/t-is-disabled/)
  // Named .pdf but not one: the API refuses it.
  await dialog(page)
    .locator('input[type=file]')
    .setInputFiles({ name: 'fake.pdf', mimeType: 'application/pdf', buffer: Buffer.from('no') })
  await confirm.click()
  await expect(page.locator('.t-message')).toContainText('请上传 PDF 格式的发票')
  await dialog(page)
    .locator('input[type=file]')
    .setInputFiles({
      name: '发票.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.7\n% e2e\n'),
    })
  await confirm.dblclick()
  await expect(dialog(page)).toHaveCount(0)
  await expect(person).toHaveCount(0)

  await company.getByRole('button', { name: '拒绝' }).click()
  await expect(dialog(page).locator('.t-button', { hasText: '确认拒绝' })).toHaveClass(
    /t-is-disabled/,
  )
  await dialog(page).locator('textarea').fill('税号有误')
  await dialog(page).getByRole('button', { name: '确认拒绝' }).click()
  await expect(company).toHaveCount(0)

  await listFilter(page, '状态').click()
  await page.locator('.t-select-option', { hasText: '已开票' }).click()
  await expect(person).toContainText('已开票')
  await expect(person.getByRole('button', { name: '查看' })).toBeVisible()
  await expect(person.getByRole('button', { name: '重新上传' })).toBeVisible()

  await page.getByRole('button', { name: '导出' }).click()
  await expect(dialog(page)).toContainText('状态：已开票')
  const download = page.waitForEvent('download')
  await dialog(page).getByRole('button', { name: '导出' }).click()
  const file = await download
  expect(file.suggestedFilename()).toMatch(/^发票-\d{4}-\d{2}-01-\d{4}-\d{2}-\d{2}\.csv$/)
  const csv = readFileSync(await file.path(), 'utf8')
  expect(csv.startsWith('﻿')).toBe(true)
  expect(csv).toContain(personName)
  expect(csv).not.toContain(companyName)

  await page.goto('./#/actions')
  await expect(page.getByRole('row').filter({ hasText: '导出发票' }).first()).toContainText(
    '状态：已开票',
  )
  await expect(page.getByRole('row').filter({ hasText: '拒绝开票' }).first()).toContainText(
    '税号有误',
  )
})

test('flags a refund on an invoiced order until it is handled', async ({ page, request }) => {
  const name = `${personName}C`
  const token = await requested(request, name, {
    kind: 'personal',
    name,
    taxNumber: '',
    email: 'c@example.com',
  })
  await login(page)
  await page.goto('./#/invoices')
  const row = page.getByRole('row').filter({ hasText: name })
  await row.getByRole('button', { name: '上传发票' }).click()
  await dialog(page)
    .locator('input[type=file]')
    .setInputFiles({ name: 'c.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1') })
  await dialog(page).locator('.t-button', { hasText: '确认开票' }).click()
  await expect(row).toHaveCount(0)

  const [pkg] = await call<PackageDto[]>(request, 'GET', '/packages', token)
  await call(request, 'POST', `/packages/${pkg?.id}/refund-request`, token)

  await page.goto('./#/refunds')
  await expect(page.getByRole('row').filter({ hasText: name })).toContainText('该订单已开票')

  await page.goto('./#/invoices')
  await listFilter(page, '状态').hover()
  await listFilter(page, '状态').locator('.t-input__suffix-clear').click()
  await page.locator('.toolbar .t-checkbox', { hasText: '开票后有退款' }).click()
  await expect(row).toContainText('开票后有退款')
  await row.getByRole('button', { name: '退款已处理' }).click()
  await page.locator('.t-popconfirm').getByRole('button', { name: '已处理' }).click()
  await expect(row).toHaveCount(0)
})
