// Drives the 球台数 limit against a local API seeded with `pnpm --filter @rs/api db:seed`. With
// one table, a time another coach already teaches shows as 已约满 on 选择时间; a booking that
// loses the last table while the student is on 确认预约 is sent back to pick another time; and
// the coach's move page shows that time as 球台已满. Saves a screenshot of each screen to
// screenshots/tables/. Run it once with DevTools in light and once in dark, or force the theme
// with QA_THEME. Restores the venue's table setting afterwards.
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { venueDateKey } from '@rs/shared'
import { closeMiniProgram, type MiniProgram, openMiniProgram } from './launch'
import { qaTheme, resetTheme, startTheme } from './theme'

const api = (process.env.API_BASE_URL ?? 'http://localhost:8787').replace(/\/+$/, '')
const adminPassword = process.env.ADMIN_PASSWORD ?? 'admin'
const forcedTheme = qaTheme()
const projectPath = fileURLToPath(new URL('../../../apps/miniprogram', import.meta.url))
const outDir = fileURLToPath(new URL('../screenshots/tables', import.meta.url))
mkdirSync(outDir, { recursive: true })

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

const miniProgram = await openMiniProgram(projectPath)

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

/** Calls a page method twice in the same tick, as a double tap does. */
async function invokeTwice(method: string) {
  await miniProgram.evaluate((name: string) => {
    const pages = getCurrentPages()
    const page = pages[pages.length - 1] as unknown as Record<string, () => unknown>
    page[name]?.()
    page[name]?.()
  }, method)
}

async function tap(page: Page, selector: string, index = 0) {
  const elements = await page.$$(selector)
  const element = elements[index]
  check(element, `No element ${selector}[${index}] on ${page.path}`)
  await element.tap()
}

async function step(name: string, fn: () => Promise<void>) {
  console.log(`- ${name}`)
  await fn()
}

interface Slot {
  coachId: number
  startsAt: string
  endsAt: string
  available: boolean
}

const admin = (await call('POST', '/admin/login', { username: 'admin', password: adminPassword }))
  .token as string
const original = await call('GET', '/admin/settings', undefined, admin)
const saveTables = async (tables: number | null) => {
  const now = await call('GET', '/admin/settings', undefined, admin)
  await call('PUT', '/admin/settings', { ...now, booking: { ...now.booking, tables } }, admin)
}

try {
  await startTheme(miniProgram)
  const run = Date.now().toString(36)
  const coaches = (await call('GET', '/admin/coaches', undefined, admin)) as {
    id: number
    bound: boolean
  }[]
  const [coach, other] = coaches
  check(coach && other, 'seed the API first: two coaches needed')
  const lessonTypes = (await call('GET', '/admin/lesson-types', undefined, admin)) as {
    id: number
    isTrial: boolean
    durationMinutes: number
  }[]
  const lesson = lessonTypes.find((t) => !t.isTrial && t.durationMinutes === 60)
  check(lesson, 'no 60-minute lesson type')
  await saveTables(1)

  const signUp = async (login: string, name: string) => {
    const token = (await call('POST', '/auth/student', { code: `dev:${login}` })).token as string
    const { version } = await call('GET', '/policies')
    await call('POST', '/me/consent', { version }, token)
    await call('PUT', '/me', { name, phone: '13900139002' }, token)
    return token
  }
  const studentLogin = `qa_tables_${run}`
  const token = await signUp(studentLogin, '吴桌')
  const rival = await signUp(`qa_tables_rival_${run}`, '郑台')
  const book = async (who: string, t: Slot) => {
    const res = await call(
      'POST',
      '/bookings',
      { coachId: t.coachId, startsAt: t.startsAt, lessonTypeId: lesson.id, payWith: 'wechat' },
      who,
    )
    if (res.orderId) await call('POST', `/dev/fake-pay/${res.orderId}`, undefined, token)
    return res.bookingId as number
  }

  // Three times on one day when both coaches are free: the first the rival takes with the other
  // coach before the student looks, the second the rival takes while the student is confirming,
  // the third the student books with the coach to have a lesson the coach can move.
  const day = venueDate(Date.now() + 3 * DAY)
  const free = async (coachId: number) =>
    (
      (await call(
        'GET',
        `/slots?date=${day}&coachId=${coachId}&lessonTypeId=${lesson.id}`,
        undefined,
        token,
      )) as Slot[]
    ).filter((s) => s.available)
  const theirs = await free(other.id)
  // Apart from each other, since with one table a lesson also takes the times overlapping it.
  const shared: Slot[] = []
  for (const s of await free(coach.id)) {
    const last = shared.at(-1)
    if (theirs.some((t) => t.startsAt === s.startsAt) && (!last || s.startsAt >= last.endsAt)) {
      shared.push(s)
    }
  }
  check(shared.length >= 3, `both coaches need three free times in common on ${day}`)
  const [full, lost, own] = shared as [Slot, Slot, Slot]
  const at = (s: Slot) => theirs.find((t) => t.startsAt === s.startsAt) as Slot
  await book(rival, at(full))

  // The first page signs in as whoever devLogin named at launch. Let that finish before switching,
  // or its late token replaces the student's.
  for (let i = 0; i < 40 && !(await miniProgram.callWxMethod('getStorageSync', 'token')); i++) {
    await sleep(250)
  }
  await miniProgram.callWxMethod('setStorageSync', 'devLogin', studentLogin)
  await miniProgram.callWxMethod('removeStorageSync', 'token')
  await autoConfirmModals()

  await step('选择时间 shows the time without a free table as 已约满', async () => {
    await miniProgram.reLaunch(`/pages/book/index?lessonTypeId=${lesson.id}&coachId=${coach.id}`)
    await waitForPage('pages/book/index', (d) => d.state === 'ready')
    const signedIn = (await miniProgram.callWxMethod('getStorageSync', 'token')) as string
    const me = await call('GET', '/me', undefined, signedIn)
    check(me.name === '吴桌', `signed in as ${me.name || 'a new student'}, not the test student`)
    await invoke('pickDate', { currentTarget: { dataset: { key: day } } })
    const page = await waitForPage(
      'pages/book/index',
      (d) => d.slotsState === 'ready' && d.date === day,
    )
    const slots = (await page.data('slots')) as Slot[]
    const shown = slots.find((s) => s.startsAt === full.startsAt)
    check(shown && !shown.available, 'the time the other coach teaches should be full')
    check(
      slots.find((s) => s.startsAt === lost.startsAt)?.available,
      'the next shared time should be free',
    )
    await screenshot('book-full')
  })

  await step('losing the last table on 确认预约 sends the student back', async () => {
    const q = `lessonTypeId=${lesson.id}&coachId=${coach.id}&startsAt=${encodeURIComponent(lost.startsAt)}&endsAt=${encodeURIComponent(lost.endsAt)}`
    await miniProgram.navigateTo(`/pages/confirm/index?${q}`)
    await waitForPage('pages/confirm/index', (d) => d.state === 'ready')
    await screenshot('confirm')
    // Taken by the other coach's student, as from another phone, after the page loaded.
    await book(rival, at(lost))
    await invokeTwice('submit')
    const back = await waitForPage(
      'pages/book/index',
      (d) => d.slotsState === 'ready' && d.date === day,
    )
    const slots = (await back.data('slots')) as Slot[]
    check(
      !slots.find((s) => s.startsAt === lost.startsAt)?.available,
      'the lost time should now be full',
    )
    const mine = (await call('GET', '/bookings', undefined, token)) as unknown[]
    check(mine.length === 0, 'nothing should have been booked')
    await screenshot('book-after-lost')
  })

  await step('the coach sees the full time as 球台已满 when moving a lesson', async () => {
    const bookingId = await book(token, own)
    if (coach.bound) await call('DELETE', `/admin/coaches/${coach.id}/binding`, undefined, admin)
    const { code } = await call('POST', `/admin/coaches/${coach.id}/bind-code`, {}, admin)
    await miniProgram.callWxMethod('setStorageSync', 'devLogin', `qa_tables_coach_${run}`)
    await miniProgram.callWxMethod('removeStorageSync', 'token')
    await miniProgram.callWxMethod('removeStorageSync', 'coachToken')
    await miniProgram.reLaunch('/coach/bind/index')
    await waitForPage('coach/bind/index', () => true)
    await invoke('onCode', { detail: { value: code } })
    await invoke('submit')
    await waitForPage('coach/index/index', (d) => d.state === 'ready')
    await miniProgram.navigateTo(`/coach/move/index?id=${bookingId}`)
    const move = await waitForPage('coach/move/index', (d) => d.state === 'ready')
    await invoke('pickDate', { currentTarget: { dataset: { key: day } } })
    await sleep(300)
    const slots = (await move.data('slots')) as { startsAt: string; full?: boolean }[]
    check(
      slots.find((s) => s.startsAt === full.startsAt)?.full,
      'the full time should be marked 球台已满',
    )
    await screenshot('coach-move-full')
    const index = slots.findIndex((s) => s.startsAt === full.startsAt)
    await tap(move, '.slot', index)
    await sleep(300)
    check(!(await move.data()).picked, 'a full time should not be pickable')
    await call('DELETE', `/admin/coaches/${coach.id}/binding`, undefined, admin)
  })

  if (errors.length > 0) throw new Error(`Runtime errors:\n${errors.join('\n')}`)
  console.log('all table limit flows passed')
} finally {
  await call(
    'PUT',
    '/admin/settings',
    {
      ...(await call('GET', '/admin/settings', undefined, admin)),
      booking: { ...original.booking },
    },
    admin,
  ).catch(() => {})
  await miniProgram.restoreWxMethod('showModal').catch(() => {})
  for (const key of ['devLogin', 'token', 'coachToken']) {
    await miniProgram.callWxMethod('removeStorageSync', key).catch(() => {})
  }
  try {
    if (forcedTheme) await resetTheme(miniProgram)
  } finally {
    await closeMiniProgram(miniProgram)
  }
}
