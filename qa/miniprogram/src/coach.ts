// Drives the coach mode end to end against a local API seeded with `pnpm --filter @rs/api db:seed`:
// binding with a code from the admin, the schedule, a lesson with a note and attendance, weekly
// hours and a day off, and cancelling a lesson. Saves a screenshot of each screen to
// screenshots/coach/. Set QA_DB to the API's database file so a lesson can be moved into the past
// for attendance; the API runs on real time.
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import automator from 'miniprogram-automator'

const api = (process.env.API_BASE_URL ?? 'http://localhost:8787').replace(/\/+$/, '')
const adminPassword = process.env.ADMIN_PASSWORD ?? 'admin'
const dbPath = process.env.QA_DB
const projectPath = fileURLToPath(new URL('../../../apps/miniprogram', import.meta.url))
const outDir = fileURLToPath(new URL('../screenshots/coach', import.meta.url))
mkdirSync(outDir, { recursive: true })

type MiniProgram = Awaited<ReturnType<typeof automator.launch>>
type Page = NonNullable<Awaited<ReturnType<MiniProgram['currentPage']>>>

declare function getCurrentPages(): unknown[]

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const DAY = 86_400_000
const venueDate = (ms: number) => new Date(ms + 8 * 3_600_000).toISOString().slice(0, 10)

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

/**
 * Moves a booking and its slot to start an hour ago, so attendance can be marked. Never before the
 * venue's midnight, so the lesson stays on today's schedule just after midnight too.
 */
function moveIntoPast(bookingId: number) {
  check(dbPath, 'set QA_DB to the API database file to test attendance')
  const require = createRequire(new URL('../../../apps/api/package.json', import.meta.url))
  const Database = require('better-sqlite3')
  const db = new Database(dbPath)
  const now = Date.now()
  const start = Math.max(now - 3_600_000, Date.parse(`${venueDate(now)}T00:00:00+08:00`))
  db.prepare('update bookings set starts_at = ?, ends_at = ? where id = ?').run(
    start,
    start + 3_600_000,
    bookingId,
  )
  db.prepare(
    'update slots set starts_at = ?, ends_at = ? where id = (select slot_id from bookings where id = ?)',
  ).run(start, start + 3_600_000, bookingId)
  db.close()
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

/** Answers every native modal with confirm, and with `content` for editable ones. */
async function answerModals(content: string) {
  await miniProgram.mockWxMethod(
    'showModal',
    function (this: unknown, options: Record<string, unknown>, text: string) {
      const res = { confirm: true, cancel: false, content: text, errMsg: 'showModal:ok' }
      if (typeof options.success === 'function') options.success(res)
      if (typeof options.complete === 'function') options.complete(res)
      return Promise.resolve(res)
    },
    content,
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

try {
  const run = Date.now().toString(36)
  const admin = (await call('POST', '/admin/login', { password: adminPassword })).token as string
  const coaches = (await call('GET', '/admin/coaches', undefined, admin)) as {
    id: number
    name: string
    bound: boolean
  }[]
  const coach = coaches[0]
  check(coach, 'seed the API first: no coaches')
  if (coach.bound) await call('DELETE', `/admin/coaches/${coach.id}/binding`, undefined, admin)
  const { code } = await call('POST', `/admin/coaches/${coach.id}/bind-code`, {}, admin)
  // Start from no weekly hours and no days off, so the script can run again on the same database.
  const before = await call('GET', `/admin/coaches/${coach.id}/hours`, undefined, admin)
  await call('PUT', `/admin/coaches/${coach.id}/hours`, { hours: [] }, admin)
  for (const day of before.daysOff as string[]) {
    await call('DELETE', `/admin/coaches/${coach.id}/days-off/${day}`, undefined, admin)
  }

  // Two students with lessons: one two days out, one moved to an hour ago.
  const lessonTypes = (await call('GET', '/admin/lesson-types', undefined, admin)) as {
    id: number
    isTrial: boolean
    durationMinutes: number
  }[]
  const lesson = lessonTypes.find((t) => !t.isTrial && t.durationMinutes === 60)
  check(lesson, 'no 60-minute lesson type')
  const book = async (name: string, days: number) => {
    const token = (await call('POST', '/auth/student', { code: `dev:${name}` })).token
    await call(
      'PUT',
      '/me',
      { name: name.startsWith('qa_a') ? '林小雨' : '陈子轩', phone: '13900139000' },
      token,
    )
    const slots = (await call(
      'GET',
      `/slots?date=${venueDate(Date.now() + days * DAY)}&coachId=${coach.id}&lessonTypeId=${lesson.id}`,
      undefined,
      token,
    )) as { id: number; available: boolean }[]
    const slot = slots.find((s) => s.available)
    check(slot, `no free slot ${days} days out`)
    const res = await call(
      'POST',
      '/bookings',
      { slotId: slot.id, lessonTypeId: lesson.id, payWith: 'wechat' },
      token,
    )
    if (res.orderId) await call('POST', `/dev/fake-pay/${res.orderId}`)
    return res.bookingId as number
  }
  const future = await book(`qa_a_${run}`, 2)
  const past = await book(`qa_b_${run}`, 3)
  moveIntoPast(past)

  // Let the launch login finish first, or it can write its own token back after we clear it. The
  // token is cleared before waiting, so a token left by an earlier run does not end the wait early.
  await miniProgram.callWxMethod('removeStorageSync', 'token')
  for (let i = 0; i < 20 && !(await miniProgram.callWxMethod('getStorageSync', 'token')); i++) {
    await sleep(250)
  }
  await sleep(500)
  await miniProgram.callWxMethod('setStorageSync', 'devLogin', `qa_coach_${run}`)
  await miniProgram.callWxMethod('removeStorageSync', 'token')
  await miniProgram.callWxMethod('removeStorageSync', 'coachToken')

  await step('a new user sees only the quiet coach entry on 我的', async () => {
    await miniProgram.reLaunch('/pages/profile/index')
    const profile = await waitForPage('pages/profile/index', (d) => d.meLoaded === true)
    check((await profile.data('isCoach')) === false, 'should not be a coach yet')
    await miniProgram.pageScrollTo(10000)
    await screenshot('profile-before')
    await tap(profile, '.coach-link')
  })

  await step('binds with the code from the admin', async () => {
    const bind = await waitForPage('coach/bind/index', () => true)
    await screenshot('bind')
    await invoke('onCode', { detail: { value: 'abc' } })
    check((await bind.data('code')) === 'ABC', 'code should be upper-cased')
    await invoke('onCode', {
      detail: { value: `${code.slice(0, 4).toLowerCase()} ${code.slice(4)}` },
    })
    check((await bind.data('code')) === code, 'spaces should be dropped')
    await screenshot('bind-filled')
    await invoke('submit')
  })

  await step('the schedule shows today with the past lesson to mark', async () => {
    const home = await waitForPage('coach/index/index', (d) => d.state === 'ready')
    const slots = (await home.data('slots')) as { kind: string; bookingId: number; tag: string }[]
    const row = slots.find((s) => s.bookingId === past)
    check(row?.tag === '待签到', `past lesson should wait for attendance, got ${row?.tag}`)
    await screenshot('schedule-today')
  })

  await step('marks attendance on the past lesson', async () => {
    const home = await waitForPage('coach/index/index', (d) => d.state === 'ready')
    const slots = (await home.data('slots')) as { bookingId: number }[]
    await tap(
      home,
      '.row',
      slots.findIndex((s) => s.bookingId === past),
    )
    const page = await waitForPage('coach/lesson/index', (d) => d.state === 'ready')
    check(
      ((await page.data('lesson')) as { canMarkAttendance: boolean }).canMarkAttendance,
      'should be markable',
    )
    await screenshot('lesson-to-mark')
    await invoke('mark', { currentTarget: { dataset: { value: 'attended' } } })
    await waitForPage(
      'coach/lesson/index',
      (d) => (d.lesson as { attendance: string | null }).attendance === 'attended',
    )
    await screenshot('lesson-attended')
    await invoke('mark', { currentTarget: { dataset: { value: 'attended' } } })
    await waitForPage(
      'coach/lesson/index',
      (d) => (d.lesson as { attendance: string | null }).attendance === null,
    )
    await invoke('mark', { currentTarget: { dataset: { value: 'no_show' } } })
    await waitForPage(
      'coach/lesson/index',
      (d) => (d.lesson as { attendance: string | null }).attendance === 'no_show',
    )
    await miniProgram.navigateBack()
    const back = await waitForPage('coach/index/index', (d) => d.state === 'ready')
    await sleep(800)
    const rows = (await back.data('slots')) as { bookingId: number; tag: string }[]
    check(
      rows.find((s) => s.bookingId === past)?.tag === '缺席',
      'list should show 缺席 after going back',
    )
  })

  await step('opens the future lesson and writes a note', async () => {
    const home = await waitForPage('coach/index/index', (d) => d.state === 'ready')
    const days = (await home.data('days')) as { key: string; lessons: number }[]
    const target = venueDate(Date.now() + 2 * DAY)
    await tap(
      home,
      '.day',
      days.findIndex((d) => d.key === target),
    )
    await sleep(300)
    await screenshot('schedule-future-day')
    const slots = (await home.data('slots')) as { bookingId: number }[]
    await tap(
      home,
      '.row',
      slots.findIndex((s) => s.bookingId === future),
    )
    const page = await waitForPage('coach/lesson/index', (d) => d.state === 'ready')
    check(
      !((await page.data('lesson')) as { canMarkAttendance: boolean }).canMarkAttendance,
      'future lesson is not markable',
    )
    await invoke('onNote', { detail: { value: '反手拉球发力不够，下节课多练' } })
    await screenshot('lesson-note-dirty')
    await invoke('saveNote')
    await waitForPage('coach/lesson/index', (d) => d.noteDirty === false && d.savingNote === false)
    const saved = await call(
      'GET',
      `/admin/bookings?from=${new Date(Date.now() - DAY).toISOString()}`,
      undefined,
      admin,
    )
    check(
      saved.some(
        (b: { id: number; coachNote: string }) => b.id === future && b.coachNote.startsWith('反手'),
      ),
      'note should reach the admin',
    )
    await screenshot('lesson-note-saved')
  })

  await step('cancels the future lesson with a reason', async () => {
    await answerModals('教练临时外出比赛')
    await invoke('cancel')
    const page = await waitForPage(
      'coach/lesson/index',
      (d) => (d.lesson as { status: string }).status === 'cancelled',
    )
    check(
      String(await page.data('cancelReason')).includes('教练临时外出比赛'),
      'reason should show',
    )
    await screenshot('lesson-cancelled')
    await miniProgram.restoreWxMethod('showModal')
  })

  await step('sets weekly hours and a day off', async () => {
    await miniProgram.navigateTo('/coach/hours/index')
    const page = await waitForPage('coach/hours/index', (d) => d.state === 'ready')
    await screenshot('hours-empty')
    await invoke('openAdd', { currentTarget: { dataset: { weekday: 2 } } })
    await sleep(400)
    await invoke('onStart', { detail: { value: '14:00' } })
    await invoke('onEnd', { detail: { value: '17:30' } })
    await screenshot('hours-add-sheet')
    check(String(await page.data('addHint')).includes('3 节课'), 'hint should count 3 lessons')
    await invoke('confirmAdd')
    await invoke('openAdd', { currentTarget: { dataset: { weekday: 2 } } })
    await invoke('onStart', { detail: { value: '16:00' } })
    await invoke('onEnd', { detail: { value: '18:00' } })
    check(
      String(await page.data('addHint')) === '同一天的时间段不能重叠',
      'overlap should be explained',
    )
    check((await page.data('addInvalid')) === true, '添加 should be disabled on overlap')
    await invoke('onPopup', { detail: { visible: false } })
    await invoke('openAdd', { currentTarget: { dataset: { weekday: 6 } } })
    await invoke('onStart', { detail: { value: '09:00' } })
    await invoke('onEnd', { detail: { value: '12:00' } })
    await invoke('confirmAdd')
    await screenshot('hours-dirty')
    await invoke('save')
    await waitForPage('coach/hours/index', (d) => d.dirty === false && d.saving === false)
    const token = (await miniProgram.callWxMethod('getStorageSync', 'coachToken')) as string
    const saved = await call('GET', '/coach/hours', undefined, token)
    check(saved.hours.length === 2, `expected 2 windows, got ${saved.hours.length}`)

    const dayOff = venueDate(Date.now() + 5 * DAY)
    await answerModals('')
    await invoke('addDayOff', { detail: { value: dayOff } })
    await waitForPage('coach/hours/index', (d) => (d.daysOff as unknown[]).length === 1)
    await miniProgram.pageScrollTo(10000)
    await screenshot('hours-day-off')
    await miniProgram.restoreWxMethod('showModal')
    await invoke('removeDayOff', { currentTarget: { dataset: { key: dayOff } } })
    await waitForPage('coach/hours/index', (d) => (d.daysOff as unknown[]).length === 0)
  })

  await step('a bound coach finds the workbench on 我的', async () => {
    await miniProgram.reLaunch('/pages/profile/index')
    const profile = await waitForPage('pages/profile/index', (d) => d.meLoaded === true)
    check((await profile.data('isCoach')) === true, 'profile should know this user is a coach')
    await screenshot('profile-coach')
  })

  await step('an unbound coach is sent back to binding', async () => {
    await call('DELETE', `/admin/coaches/${coach.id}/binding`, undefined, admin)
    await miniProgram.reLaunch('/coach/index/index')
    await waitForPage('coach/bind/index', () => true)
  })

  if (errors.length > 0) throw new Error(`Runtime errors:\n${errors.join('\n')}`)
  console.log('all coach flows passed')
} finally {
  await miniProgram.restoreWxMethod('showModal').catch(() => {})
  // The next run, or a person opening DevTools, starts from a normal student login.
  for (const key of ['devLogin', 'token', 'coachToken']) {
    await miniProgram.callWxMethod('removeStorageSync', key).catch(() => {})
  }
  await miniProgram.close()
}
