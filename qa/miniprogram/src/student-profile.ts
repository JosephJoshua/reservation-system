// Drives 学员档案 on the coach lesson page against a local API seeded with
// `pnpm --filter @rs/api db:seed`: an empty profile, one the venue filled in, the longest one the
// admin allows, a refresh after the venue changes it, and the student's own lesson page, which
// must not show any of it. One lesson is moved into the past in the API's SQLite file to count, so
// set QA_DB to it. Saves a screenshot of each screen to screenshots/student-profile/. Run it once
// with DevTools in light and once in dark, or force the theme with QA_THEME.
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { venueDateKey } from '@rs/shared'
import automator from 'miniprogram-automator'
import { qaTheme, resetTheme, startTheme } from './theme'

const api = (process.env.API_BASE_URL ?? 'http://localhost:8787').replace(/\/+$/, '')
const adminPassword = process.env.ADMIN_PASSWORD ?? 'admin'
const dbPath = process.env.QA_DB
if (!dbPath) throw new Error('set QA_DB to the API database file, to move lessons into the past')
const forcedTheme = qaTheme()
const projectPath = fileURLToPath(new URL('../../../apps/miniprogram', import.meta.url))
const outDir = fileURLToPath(new URL('../screenshots/student-profile', import.meta.url))
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

/** Moves a booking and its slot to the hour before last, so it counts as a lesson taken. */
function moveIntoPast(bookingId: number) {
  const apiDir = fileURLToPath(new URL('../../../apps/api/', import.meta.url))
  const Database = createRequire(`${apiDir}package.json`)('better-sqlite3')
  const db = new Database(dbPath)
  const start = Date.now() - 2 * 3_600_000
  const end = Date.now() - 3_600_000
  db.prepare('update bookings set starts_at = ?, ends_at = ? where id = ?').run(
    start,
    end,
    bookingId,
  )
  db.prepare(
    'update slots set starts_at = ?, ends_at = ? where id = (select slot_id from bookings where id = ?)',
  ).run(start, end, bookingId)
  db.close()
}

async function signIn(login: string) {
  await miniProgram.callWxMethod('setStorageSync', 'devLogin', login)
  for (const key of ['token', 'coachToken'])
    await miniProgram.callWxMethod('removeStorageSync', key)
}

// Page data is read whole: data('x') reads a null as undefined.
interface ProfileView {
  chips: { text: string; trait: boolean }[]
  note: string
  empty: boolean
  counts: string
}

const NOTE = '左膝旧伤，避免大步移动。\n目标：下个月区赛。'

try {
  await startTheme(miniProgram)
  const run = Date.now().toString(36)
  const admin = (await call('POST', '/admin/login', { username: 'admin', password: adminPassword }))
    .token as string
  const coaches = (await call('GET', '/admin/coaches', undefined, admin)) as {
    id: number
    bound: boolean
  }[]
  const [coach] = coaches
  check(coach, 'seed the API first: a coach is needed')
  const lessonTypes = (await call('GET', '/admin/lesson-types', undefined, admin)) as {
    id: number
    isTrial: boolean
  }[]
  const lesson = lessonTypes.find((t) => !t.isTrial)
  check(lesson, 'no lesson type')

  // A student with two paid lessons; the first is moved into the past and marked attended.
  const studentLogin = `qa_sp_${run}`
  const token = (await call('POST', '/auth/student', { code: `dev:${studentLogin}` })).token
  const { version } = await call('GET', '/policies')
  await call('POST', '/me/consent', { version }, token)
  await call('PUT', '/me', { name: '周小川', phone: '13900139003' }, token)
  const studentId = (await call('GET', '/me', undefined, token)).id as number
  const booked: number[] = []
  for (let days = 2; days < 12 && booked.length < 2; days++) {
    const slots = (await call(
      'GET',
      `/slots?date=${venueDate(Date.now() + days * DAY)}&coachId=${coach.id}&lessonTypeId=${lesson.id}`,
      undefined,
      token,
    )) as { id: number; available: boolean }[]
    const slot = slots.find((s) => s.available)
    if (!slot) continue
    const res = await call(
      'POST',
      '/bookings',
      { slotId: slot.id, lessonTypeId: lesson.id, payWith: 'wechat' },
      token,
    )
    if (res.orderId) await call('POST', `/dev/fake-pay/${res.orderId}`)
    booked.push(res.bookingId)
  }
  const [past, bookingId] = booked
  check(past && bookingId, 'the coach needs two free slots in the next ten days')
  moveIntoPast(past)
  await call('PUT', `/admin/bookings/${past}/attendance`, { attendance: 'attended' }, admin)

  let page: Page | undefined
  const profileOf = async () => (await page?.data())?.profile as ProfileView | null

  await step('an empty profile says so and still counts lessons', async () => {
    if (coach.bound) await call('DELETE', `/admin/coaches/${coach.id}/binding`, undefined, admin)
    const { code } = await call('POST', `/admin/coaches/${coach.id}/bind-code`, {}, admin)
    await signIn(`qa_sp_coach_${run}`)
    await miniProgram.reLaunch('/coach/bind/index')
    await waitForPage('coach/bind/index', () => true)
    await invoke('onCode', { detail: { value: code } })
    await invoke('submit')
    await waitForPage('coach/index/index', (d) => d.state === 'ready')
    await miniProgram.navigateTo(`/coach/lesson/index?id=${bookingId}`)
    page = await waitForPage('coach/lesson/index', (d) => d.state === 'ready')
    const profile = await profileOf()
    check(profile?.empty, 'the profile should be empty')
    check(profile.counts === '在本馆上课 1 次', `counts: ${profile.counts}`)
    check((await page.$('.profile-empty')) !== null, 'should say nothing is filled in')
    await screenshot('empty')
  })

  await step('the venue fills it in and a pull-down refresh shows it', async () => {
    await call(
      'PUT',
      `/admin/students/${studentId}/profile`,
      { level: 'intermediate', grip: 'penhold', tags: ['反手弱', '备赛'], note: NOTE },
      admin,
    )
    await invoke('onPullDownRefresh')
    page = await waitForPage('coach/lesson/index', (d) => !(d.profile as ProfileView).empty)
    const profile = await profileOf()
    check(
      profile?.chips.map((c) => c.text).join(',') === '中级,直拍,反手弱,备赛',
      `chips: ${JSON.stringify(profile?.chips)}`,
    )
    check(profile.note === NOTE, 'should show the note')
    check((await page.$('.profile-empty')) === null, 'should not say it is empty')
    await screenshot('filled')
  })

  await step('the longest profile wraps without breaking the page', async () => {
    await call(
      'PUT',
      `/admin/students/${studentId}/profile`,
      {
        level: 'advanced',
        grip: 'shakehand',
        tags: Array.from({ length: 8 }, (_, i) => `很长的标签名字第${i + 1}个`.slice(0, 10)),
        note: `${'正手连续拉球稳定性需要加强'.repeat(30)}${'a'.repeat(110)}`.slice(0, 500),
      },
      admin,
    )
    await call('PUT', `/admin/bookings/${past}/attendance`, { attendance: 'no_show' }, admin)
    await invoke('load')
    page = await waitForPage(
      'coach/lesson/index',
      (d) => (d.profile as ProfileView).chips.length === 10,
    )
    const profile = await profileOf()
    check(profile?.counts === '在本馆上课 0 次，缺席 1 次', `counts: ${profile?.counts}`)
    await screenshot('long')
    await miniProgram.pageScrollTo(400)
    await screenshot('long-scrolled')
  })

  await step('the student sees none of it on their own lesson', async () => {
    await signIn(studentLogin)
    await miniProgram.reLaunch(`/pages/booking-detail/index?id=${bookingId}`)
    const detail = await waitForPage('pages/booking-detail/index', (d) => d.state !== 'loading')
    const text = JSON.stringify(await detail.data())
    check(!text.includes('正手连续拉球') && !text.includes('很长的标签'), 'the profile leaked')
    await screenshot('student-detail')
  })

  await call('DELETE', `/admin/coaches/${coach.id}/binding`, undefined, admin)
  if (errors.length > 0) throw new Error(`Runtime errors:\n${errors.join('\n')}`)
  console.log('all student profile checks passed')
} finally {
  for (const key of ['devLogin', 'token', 'coachToken']) {
    await miniProgram.callWxMethod('removeStorageSync', key).catch(() => {})
  }
  try {
    if (forcedTheme) await resetTheme(miniProgram)
  } finally {
    await miniProgram.close()
  }
}
