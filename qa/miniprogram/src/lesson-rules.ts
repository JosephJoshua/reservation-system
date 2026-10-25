// Drives booking rules set on a lesson type against a local API seeded with
// `pnpm --filter @rs/api db:seed`. The lesson type gets its own rules (30 days ahead, free cancel
// until 48 hours before, half back after, 2 moves): 选择时间 offers 30 days, 确认预约 states the
// lesson's cancel rule, and a booked lesson keeps that rule on 预约详情 and 改约 after the lesson
// type changes again. Saves a screenshot of each screen to screenshots/lesson-rules/. Run it once
// with DevTools in light and once in dark, or force the theme with QA_THEME. Restores the lesson
// type's rules afterwards.
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { venueDateKey } from '@rs/shared'
import automator from 'miniprogram-automator'
import { expectStudent, switchStudent } from './session'
import { qaTheme, resetTheme, startTheme } from './theme'

const api = (process.env.API_BASE_URL ?? 'http://localhost:8787').replace(/\/+$/, '')
const adminPassword = process.env.ADMIN_PASSWORD ?? 'admin'
const forcedTheme = qaTheme()
const projectPath = fileURLToPath(new URL('../../../apps/miniprogram', import.meta.url))
const outDir = fileURLToPath(new URL('../screenshots/lesson-rules', import.meta.url))
mkdirSync(outDir, { recursive: true })

type MiniProgram = Awaited<ReturnType<typeof automator.launch>>
type Page = NonNullable<Awaited<ReturnType<MiniProgram['currentPage']>>>

// Runs inside the mini program, through evaluate.
declare function getCurrentPages(): unknown[]

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const DAY = 86_400_000
const venueDate = (ms: number) => venueDateKey(new Date(ms))

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

/** Waits until the current page is `path` and its data satisfies `ready`. */
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

/** Native dialogs cannot be tapped from the automator, so every modal is answered "confirm". */
async function autoConfirmModals() {
  await miniProgram.mockWxMethod(
    'showModal',
    function (this: unknown, options: Record<string, unknown>) {
      const res = { confirm: true, cancel: false, errMsg: 'showModal:ok' }
      if (typeof options.success === 'function') options.success(res)
      if (typeof options.complete === 'function') options.complete(res)
      return Promise.resolve(res)
    },
  )
}

/** Calls a page method twice in the same tick, as a double tap does. */
async function invokeTwice(method: string) {
  await miniProgram.evaluate((name: string) => {
    const pages = getCurrentPages()
    const page = pages[pages.length - 1] as unknown as Record<string, () => unknown>
    page[name]?.()
    page[name]?.()
  }, method)
}

async function step(name: string, fn: () => Promise<void>) {
  console.log(`- ${name}`)
  await fn()
}

interface Slot {
  id: number
  coachId: number
  startsAt: string
  endsAt: string
  available: boolean
}

interface LessonType {
  id: number
  name: string
  isTrial: boolean
  capacity: number
  durationMinutes: number
  rules: Record<string, unknown>
}

const admin = (await call('POST', '/admin/login', { username: 'admin', password: adminPassword }))
  .token as string
const lessonTypes = (await call('GET', '/admin/lesson-types', undefined, admin)) as LessonType[]
const lesson = lessonTypes.find((t) => !t.isTrial && t.capacity === 1 && t.durationMinutes === 60)
check(lesson, 'no 60-minute private lesson type')
const setRules = async (rules: Record<string, unknown>) => {
  const now = (await call('GET', '/admin/lesson-types', undefined, admin)) as LessonType[]
  const row = now.find((t) => t.id === lesson.id)
  await call('PUT', `/admin/lesson-types/${lesson.id}`, { ...row, rules }, admin)
}

try {
  await startTheme(miniProgram)
  const run = Date.now().toString(36)
  await setRules({
    advanceDays: 30,
    cancelDeadlineHours: 48,
    lateCancel: { kind: 'partial', percent: 50 },
    studentMoves: 2,
  })
  const coaches = (await call('GET', '/admin/coaches', undefined, admin)) as { id: number }[]
  const coach = coaches[0]
  check(coach, 'seed the API first: a coach is needed')

  const studentLogin = `qa_rules_${run}`
  const token = (await call('POST', '/auth/student', { code: `dev:${studentLogin}` })).token
  const { version } = await call('GET', '/policies')
  await call('POST', '/me/consent', { version }, token)
  await call('PUT', '/me', { name: '冯规则', phone: '13900139003' }, token)
  await switchStudent(miniProgram, studentLogin)
  await autoConfirmModals()

  const day = venueDate(Date.now() + 4 * DAY)
  const slots = (
    (await call(
      'GET',
      `/slots?date=${day}&coachId=${coach.id}&lessonTypeId=${lesson.id}`,
      undefined,
      token,
    )) as Slot[]
  ).filter((s) => s.available)
  const [first] = slots
  check(first, `the coach needs a free time on ${day}`)

  // The app keeps the catalog for a minute and fetched it at launch, before the rules were set.
  await miniProgram.reLaunch('/pages/booking/index')
  await waitForPage('pages/booking/index')
  // Called inside the app: a page handle from waitForPage can go stale across the reload.
  await miniProgram.evaluate(() => {
    const pages = getCurrentPages()
    const page = pages[pages.length - 1] as unknown as { load(fresh: boolean): Promise<void> }
    return page.load(true)
  })
  await sleep(1000)

  await step("选择时间 offers the lesson type's 30 days", async () => {
    await miniProgram.reLaunch(`/pages/book/index?lessonTypeId=${lesson.id}&coachId=${coach.id}`)
    const page = await waitForPage('pages/book/index', (d) => d.state === 'ready')
    await expectStudent(miniProgram, studentLogin)
    const days = (await page.data('days')) as unknown[]
    check(days.length === 31, `expected 31 days (today and 30 more), got ${days.length}`)
    await screenshot('book-days')
  })

  await step("确认预约 states the lesson's own cancel rule", async () => {
    const q = `slotId=${first.id}&lessonTypeId=${lesson.id}&coachId=${coach.id}&startsAt=${encodeURIComponent(first.startsAt)}&endsAt=${encodeURIComponent(first.endsAt)}`
    await miniProgram.navigateTo(`/pages/confirm/index?${q}`)
    const page = await waitForPage('pages/confirm/index', (d) => d.state === 'ready')
    const rule = (await page.data('cancelRule')) as string
    check(
      rule === '开课前 48 小时以上可免费取消；之后再取消，则退还 50% 的费用，但不退课时。',
      `unexpected cancel rule: ${rule}`,
    )
    await screenshot('confirm-rule')
  })

  const booked = await call(
    'POST',
    '/bookings',
    { slotId: first.id, lessonTypeId: lesson.id, payWith: 'wechat' },
    token,
  )
  if (booked.orderId) await call('POST', `/dev/fake-pay/${booked.orderId}`)
  // The venue tightens the lesson type afterwards; the booked lesson keeps what it was booked under.
  await setRules({ advanceDays: 7, cancelDeadlineHours: 2, studentMoves: 0 })

  await step("改约 offers the lesson type's window as it is now", async () => {
    await miniProgram.reLaunch(`/pages/move/index?id=${booked.bookingId}`)
    const page = await waitForPage('pages/move/index', (d) => d.state === 'ready')
    const days = (await page.data('days')) as unknown[]
    check(days.length === 8, `expected 8 days (today and 7 more), got ${days.length}`)
    await screenshot('move-days')
  })

  await step('预约详情 keeps the rule it was booked under', async () => {
    await miniProgram.reLaunch(`/pages/booking-detail/index?id=${booked.bookingId}`)
    const page = await waitForPage('pages/booking-detail/index', (d) => d.state === 'ready')
    const rule = (await page.data('cancelRule')) as string
    check(
      rule.startsWith('开课前 48 小时以上可免费取消；之后再取消，则退还 50% 的费用'),
      `unexpected rule: ${rule}`,
    )
    check(rule.includes('改约 2 次'), `the lesson should keep 2 moves: ${rule}`)
    await screenshot('detail-kept')
    // A double tap: four days out is free under the booked 48 hours, though the lesson type now
    // says 2, and only one refund goes out.
    await invokeTwice('cancel')
    await waitForPage('pages/booking-detail/index', (d) => d.state === 'ready')
    await sleep(1000)
    const after = await call('GET', `/bookings/${booked.bookingId}`, undefined, token)
    check(after.status === 'cancelled' && !after.late, 'cancelling 4 days out should be free')
    check(after.refund, 'a refund should be on its way')
    await screenshot('detail-cancelled')
  })

  await step('改约 is off for a lesson booked once the lesson type allows none', async () => {
    const again = await call(
      'POST',
      '/bookings',
      { slotId: first.id, lessonTypeId: lesson.id, payWith: 'wechat' },
      token,
    ).catch(() => null)
    if (again?.orderId) await call('POST', `/dev/fake-pay/${again.orderId}`)
    check(again, 'booking again under the new rules should work')
    await miniProgram.reLaunch(`/pages/move/index?id=${again.bookingId}`)
    await waitForPage('pages/move/index', (d) => d.state === 'error')
    await screenshot('move-not-allowed')
  })

  if (errors.length > 0) throw new Error(`Runtime errors:\n${errors.join('\n')}`)
  console.log('all lesson type rule flows passed')
} finally {
  await setRules(lesson.rules).catch(() => {})
  await miniProgram.restoreWxMethod('showModal').catch(() => {})
  for (const key of ['devLogin', 'token', 'coachToken']) {
    await miniProgram.callWxMethod('removeStorageSync', key).catch(() => {})
  }
  try {
    if (forcedTheme) await resetTheme(miniProgram)
  } finally {
    await miniProgram.close()
  }
}
