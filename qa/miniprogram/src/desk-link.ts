// Drives 同步前台记录 against a local API seeded with `pnpm --filter @rs/api db:seed`: the desk adds
// a student and sells them a package, a new WeChat user opens 我的 and the link page, a wrong code,
// the right code from the desk's 小程序码 (opened with ?scene=), a double tap on 同步, then 我的 and
// 我的课时包 showing the desk's records and the 学员编号. Saves a screenshot of each screen to
// screenshots/desk-link/. Run it once with DevTools in light and once in dark, or set QA_THEME.
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import automator from 'miniprogram-automator'
import { qaTheme, resetTheme, startTheme } from './theme'

const api = (process.env.API_BASE_URL ?? 'http://localhost:8787').replace(/\/+$/, '')
const adminPassword = process.env.ADMIN_PASSWORD ?? 'admin'
const projectPath = fileURLToPath(new URL('../../../apps/miniprogram', import.meta.url))
const outDir = fileURLToPath(new URL('../screenshots/desk-link', import.meta.url))
mkdirSync(outDir, { recursive: true })

type MiniProgram = Awaited<ReturnType<typeof automator.launch>>
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
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  const json = text ? JSON.parse(text) : null
  if (res.status >= 400) throw new Error(`${method} ${path} ${res.status} ${text}`)
  return json
}

const miniProgram = await automator.launch({
  projectPath,
  ...(process.env.WECHAT_DEVTOOLS_CLI ? { cliPath: process.env.WECHAT_DEVTOOLS_CLI } : {}),
})

const errors: string[] = []
miniProgram.on('exception', (err: { message: string }) => errors.push(err.message))
miniProgram.on('console', (msg: { type: string; args: unknown[] }) => {
  if (msg.type === 'error') errors.push(msg.args.map(String).join(' '))
})

let shot = 0
async function screenshot(name: string) {
  await sleep(500)
  shot += 1
  await miniProgram.screenshot({ path: `${outDir}/${String(shot).padStart(2, '0')}-${name}.png` })
  console.log(`  screenshot ${name}`)
}

async function waitForPage(
  path: string,
  ready: (data: Record<string, unknown>) => boolean = () => true,
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

/** Calls a page method through evaluate; Page.callMethod fails on async methods. */
async function invoke(method: string, ...args: unknown[]) {
  await miniProgram.evaluate(
    (name: string, params: unknown[]) => {
      const pages = getCurrentPages()
      const page = pages[pages.length - 1] as unknown as Record<
        string,
        (...a: unknown[]) => unknown
      >
      page[name]?.(...params)
    },
    method,
    args,
  )
}

async function step(name: string, fn: () => Promise<void>) {
  console.log(`- ${name}`)
  await fn()
}

try {
  await startTheme(miniProgram)
  const run = Date.now().toString(36)
  const admin = (await call('POST', '/admin/login', { username: 'admin', password: adminPassword }))
    .token as string
  const products = (await call('GET', '/admin/package-products', undefined, admin)) as {
    id: number
    onSale: boolean
    price: number
  }[]
  const product = products.find((p) => p.onSale)
  check(product, 'seed the API first: a package on sale is needed')

  const phone = `139${String(Date.now()).slice(-8)}`
  const desk = await call('POST', '/admin/students', { name: '前台小王', phone }, admin)
  await call(
    'POST',
    '/admin/packages/offline-sale',
    { studentId: desk.id, productId: product.id, amount: product.price, method: 'cash' },
    admin,
  )
  const { code } = await call('POST', `/admin/students/${desk.id}/bind-code`, undefined, admin)

  // A WeChat user who has never opened the mini program.
  await miniProgram.callWxMethod('setStorageSync', 'devLogin', `qa_link_${run}`)
  await miniProgram.callWxMethod('removeStorageSync', 'token')

  await step('我的 offers 同步前台记录 and shows the new 学员编号', async () => {
    await miniProgram.reLaunch('/pages/profile/index')
    await waitForPage('pages/profile/index', (d) => Boolean(d.studentNo))
    await screenshot('profile-before')
  })

  await step('the link page from 我的', async () => {
    await invoke('openLink')
    const page = await waitForPage('pages/link/index')
    check((await page.data()).showAgreement === true, 'a new user must agree first')
    await screenshot('link-empty')
    await invoke('onCode', { detail: { value: 'abcd-efgh' } })
    await invoke('onAgree', { detail: { checked: true } })
    await invoke('submit')
    await sleep(1500)
    await screenshot('link-wrong-code')
    check((await miniProgram.currentPage())?.path === 'pages/link/index', 'stays on a bad code')
  })

  await step('the desk 小程序码 opens the page with the code filled in', async () => {
    await miniProgram.reLaunch(`/pages/link/index?scene=${encodeURIComponent(code)}`)
    const page = await waitForPage('pages/link/index', (d) => d.code === code)
    // Agreed on the previous attempt.
    check((await page.data()).showAgreement === false, 'agreement already recorded')
    await screenshot('link-scanned')
  })

  await step('a double tap on 同步 links once and lands on 我的', async () => {
    await invoke('submit')
    await invoke('submit')
    const page = await waitForPage('pages/profile/index', (d) => d.studentNo === desk.id)
    const data = await page.data()
    check(data.name === '前台小王', `name from the desk, got ${data.name}`)
    check(String(data.remaining).includes('剩余'), 'package lessons shown')
    await screenshot('profile-after')
  })

  await step('the desk package is in 我的课时包', async () => {
    await invoke('openMyPackages')
    await waitForPage('pages/my-packages/index')
    await screenshot('my-packages')
  })

  const detail = await call('GET', `/admin/students/${desk.id}`, undefined, admin)
  check(detail.wechatBound === true, 'the admin shows the student as linked')

  if (errors.length > 0) throw new Error(`Runtime errors:\n${errors.join('\n')}`)
  console.log('all desk link flows passed')
} finally {
  // The next run, or a person opening DevTools, starts from a normal student login.
  for (const key of ['devLogin', 'token']) {
    await miniProgram.callWxMethod('removeStorageSync', key).catch(() => {})
  }
  try {
    if (qaTheme()) await resetTheme(miniProgram)
  } finally {
    await miniProgram.close()
  }
}
