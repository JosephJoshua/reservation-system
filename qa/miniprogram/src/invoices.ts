// Drives invoice requests against a local API seeded with `pnpm --filter @rs/api db:seed`: buys a
// package through the API, requests an invoice from the 发票 page (a wrong tax number first, then a
// double tap on submit), sees it 开票中, gets it rejected and asks again with the saved title, then
// sees it issued on the list, the package page and opens the PDF. Saves screenshots to
// screenshots/invoices/; run it once in light and once in dark mode.
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { closeMiniProgram, type MiniProgram, openMiniProgram } from './launch'
import { expectStudent, switchStudent } from './session'
import { qaTheme, resetTheme, startTheme } from './theme'

const projectPath = fileURLToPath(new URL('../../../apps/miniprogram', import.meta.url))
const outDir = fileURLToPath(new URL('../screenshots/invoices', import.meta.url))
mkdirSync(outDir, { recursive: true })
const api = (process.env.API_BASE_URL ?? 'http://localhost:8787').replace(/\/+$/, '')
const adminPassword = process.env.ADMIN_PASSWORD ?? 'admin'
// QA_THEME=light or dark forces the 外观 setting for this run; unset follows the system.
const forcedTheme = qaTheme()

type Page = NonNullable<Awaited<ReturnType<MiniProgram['currentPage']>>>

// Runs inside the mini program, through evaluate.
declare function getCurrentPages(): unknown[]

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function call(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(`${api}/api${path}`, {
    method,
    headers: {
      ...(body === undefined || body instanceof FormData
        ? {}
        : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  })
  const text = await res.text()
  const json = text ? JSON.parse(text) : null
  if (res.status >= 400) throw new Error(`${method} ${path} ${res.status} ${text}`)
  return json
}

const miniProgram = await openMiniProgram(projectPath)

const errors: string[] = []
miniProgram.on('exception', (err: { message: string }) => errors.push(err.message))
miniProgram.on('console', (msg: { type: string; args: unknown[] }) => {
  if (msg.type === 'error') errors.push(msg.args.map(String).join(' '))
})

let shot = 0
async function screenshot(name: string) {
  await sleep(400)
  shot += 1
  await miniProgram.screenshot({ path: `${outDir}/${String(shot).padStart(2, '0')}-${name}.png` })
  console.log(`  screenshot ${name}`)
}

async function waitForPage(
  path: string,
  ready: (data: Record<string, unknown>) => boolean = (d) => d.state !== 'loading',
  timeout = 15000,
): Promise<Page> {
  const until = Date.now() + timeout
  let last = ''
  while (Date.now() < until) {
    const page = await miniProgram.currentPage()
    last = page?.path ?? ''
    if (page && page.path === path) {
      await sleep(500)
      const data = await page.data().catch(() => null)
      if (data && ready(data)) return page
    }
    await sleep(250)
  }
  throw new Error(`Timed out waiting for ${path} (on ${last})`)
}

/** Calls a method on the current page without waiting for it, as many times as asked. */
async function invoke(method: string, times: number, ...args: unknown[]) {
  await miniProgram.evaluate(
    (name: string, n: number, params: unknown[]) => {
      const pages = getCurrentPages()
      const page = pages[pages.length - 1] as unknown as Record<
        string,
        (...a: unknown[]) => unknown
      >
      for (let i = 0; i < n; i++) page[name]?.(...params)
    },
    method,
    times,
    args,
  )
}

const typed = (value: string) => ({ detail: { value } })

async function step(name: string, fn: () => Promise<void>) {
  console.log(`- ${name}`)
  await fn()
}

const devName = `qa_invoice_${Date.now()}`
try {
  // The same dev login the mini program uses, so the API and the page see one student.
  const { token } = await call('POST', '/auth/student', { code: `dev:${devName}` })
  const { version } = await call('GET', '/policies')
  await call('POST', '/me/consent', { version }, token)
  await call('PUT', '/me', { name: '开票测试', phone: '13800009999' }, token)
  const catalog = await call('GET', '/catalog', undefined, token)
  const product = catalog.packageProducts[0]
  check(product, 'seed the API first: no packages for sale')
  const { orderId } = await call('POST', '/packages/purchase', { productId: product.id }, token)
  await call('POST', `/dev/fake-pay/${orderId}`, undefined, token)
  const admin = (await call('POST', '/admin/login', { username: 'admin', password: adminPassword }))
    .token as string

  // Set on the instance just launched, so the pages below read it. Unset clears a leftover.
  await startTheme(miniProgram)
  await switchStudent(miniProgram, devName)

  await step('the 发票 page lists the paid package', async () => {
    await miniProgram.reLaunch('/pages/profile/index')
    await expectStudent(miniProgram, devName)
    await miniProgram.navigateTo('/pages/invoices/index')
    const page = await waitForPage('pages/invoices/index')
    const orders = (await page.data('orders')) as { orderId: number; link: string }[]
    const row = orders.find((o) => o.orderId === orderId)
    check(row?.link === '开发票', `expected 开发票, got ${row?.link}`)
    await screenshot('list-available')
  })

  await step('a wrong tax number is caught on the form', async () => {
    await miniProgram.navigateTo(`/pages/invoice-request/index?orderId=${orderId}`)
    const page = await waitForPage('pages/invoice-request/index')
    check((await page.data('name')) === '开票测试', 'personal title defaults to the name')
    await screenshot('form-personal')
    // The action sheet cannot be driven, so set the kind as picking 单位 would.
    await page.setData({ kind: 'company', kindLabel: '单位', name: '', taxNumber: '' })
    await invoke('onName', 1, typed('某某科技有限公司'))
    await invoke('onTaxNumber', 1, typed('123'))
    await invoke('onEmail', 1, typed('finance@example.com'))
    await invoke('submit', 1)
    await sleep(500)
    await screenshot('form-bad-tax-number')
    const { orders } = await call('GET', '/invoices', undefined, token)
    check(orders[0].state === 'available', 'nothing should be requested yet')
  })

  await step('a double tap on submit requests one invoice', async () => {
    await invoke('onTaxNumber', 1, typed('91110108ma01abcd2x'))
    await screenshot('form-company')
    await invoke('submit', 2)
    const page = await waitForPage('pages/invoices/index')
    const orders = (await page.data('orders')) as { orderId: number; state: string }[]
    check(orders.find((o) => o.orderId === orderId)?.state === '开票中', 'should be 开票中')
    await screenshot('list-requested')
    const queue = await call('GET', '/admin/invoices?status=requested', undefined, admin)
    const mine = queue.filter((i: { order: { id: number } }) => i.order.id === orderId)
    check(mine.length === 1, `expected one request, got ${mine.length}`)
    check(mine[0].title.taxNumber === '91110108MA01ABCD2X', 'tax number upper-cased')
  })

  await step('a rejected request shows the reason and refills the form', async () => {
    const queue = await call('GET', '/admin/invoices?status=requested', undefined, admin)
    const id = queue.find((i: { order: { id: number } }) => i.order.id === orderId).id
    await call('POST', `/admin/invoices/${id}/reject`, { reason: '税号有误，请核对' }, admin)
    await miniProgram.reLaunch('/pages/profile/index')
    await sleep(800)
    await miniProgram.navigateTo('/pages/invoices/index')
    const page = await waitForPage('pages/invoices/index')
    const orders = (await page.data('orders')) as { orderId: number; note: string }[]
    check(orders.find((o) => o.orderId === orderId)?.note.includes('税号有误'), 'reason shown')
    await screenshot('list-rejected')
    await invoke('open', 1, { currentTarget: { dataset: { id: orderId } } })
    const form = await waitForPage('pages/invoice-request/index')
    check((await form.data('kind')) === 'company', 'last title kind kept')
    check((await form.data('taxNumber')) === '91110108MA01ABCD2X', 'last tax number kept')
    await invoke('submit', 1)
    await waitForPage('pages/invoices/index')
  })

  await step('an issued invoice shows on the list and the package, and opens', async () => {
    const queue = await call('GET', '/admin/invoices?status=requested', undefined, admin)
    const id = queue.find((i: { order: { id: number } }) => i.order.id === orderId).id
    const form = new FormData()
    form.append(
      'file',
      new File([new TextEncoder().encode('%PDF-1.4\n% qa invoice\n')], 'invoice.pdf', {
        type: 'application/pdf',
      }),
    )
    await call('POST', `/admin/invoices/${id}/issue`, form, admin)
    await miniProgram.reLaunch('/pages/profile/index')
    await screenshot('profile-entry')
    await miniProgram.navigateTo('/pages/my-packages/index')
    const pkgs = await waitForPage('pages/my-packages/index')
    const packages = (await pkgs.data('packages')) as { invoice: string; invoiceLink: string }[]
    check(packages[0]?.invoiceLink === '查看发票', `package link ${packages[0]?.invoiceLink}`)
    await screenshot('packages-issued')
    await miniProgram.navigateTo('/pages/invoices/index')
    await waitForPage('pages/invoices/index')
    await screenshot('list-issued')
    // Opens the PDF; DevTools shows it in its own viewer, a phone in WeChat's.
    await invoke('open', 2, { currentTarget: { dataset: { id: orderId } } })
    await sleep(2500)
    await screenshot('pdf')
  })

  check(errors.length === 0, `console errors:\n${errors.join('\n')}`)
  console.log('invoices: ok')
} finally {
  try {
    if (forcedTheme) await resetTheme(miniProgram)
  } finally {
    await closeMiniProgram(miniProgram)
  }
}
