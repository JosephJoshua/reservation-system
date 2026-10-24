// Drives 改约 end to end against a local API seeded with `pnpm --filter @rs/api db:seed`: a
// student moves a paid lesson (with a double tap), sees a time they cannot take refused, and runs
// out of moves; then the coach moves the lesson in coach mode. Saves a screenshot of each screen
// to screenshots/moves/. Run it once with DevTools in light and once in dark, or force the theme
// with QA_THEME.
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
const outDir = fileURLToPath(new URL('../screenshots/moves', import.meta.url))
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

interface Booking {
  id: number
  startsAt: string
  canMove: boolean
  movesLeft: number
  movedFrom: string | null
}

try {
  await startTheme(miniProgram)
  const run = Date.now().toString(36)
  const admin = (await call('POST', '/admin/login', { username: 'admin', password: adminPassword }))
    .token as string
  const settings = await call('GET', '/admin/settings', undefined, admin)
  await call(
    'PUT',
    '/admin/settings',
    { ...settings, booking: { ...settings.booking, studentMoves: 1 } },
    admin,
  )
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

  // A student with a paid lesson three days out, past the free-cancel deadline's reach.
  const studentLogin = `qa_move_${run}`
  const token = (await call('POST', '/auth/student', { code: `dev:${studentLogin}` })).token
  const { version } = await call('GET', '/policies')
  await call('POST', '/me/consent', { version }, token)
  await call('PUT', '/me', { name: '周一鸣', phone: '13900139001' }, token)
  const day = venueDate(Date.now() + 3 * DAY)
  const free = async (coachId: number) =>
    (
      (await call(
        'GET',
        `/slots?date=${day}&coachId=${coachId}&lessonTypeId=${lesson.id}`,
        undefined,
        token,
      )) as { id: number; startsAt: string; available: boolean }[]
    ).filter((s) => s.available)
  const mine = await free(coach.id)
  check(mine.length >= 3, `coach needs three free slots on ${day}`)
  const book = async (slotId: number) => {
    const res = await call(
      'POST',
      '/bookings',
      { slotId, lessonTypeId: lesson.id, payWith: 'wechat' },
      token,
    )
    if (res.orderId) await call('POST', `/dev/fake-pay/${res.orderId}`)
    return res.bookingId as number
  }
  const first = mine[0]
  check(first, 'no free slot')
  const bookingId = await book(first.id)
  // A time when the other coach is free too: once the move page shows it, the student books the
  // other coach then, so moving there is refused as a clash.
  const theirs = await free(other.id)
  const clash = mine.slice(1).find((s) => theirs.some((t) => t.startsAt === s.startsAt))
  const clashing = theirs.find((t) => t.startsAt === clash?.startsAt)

  await switchStudent(miniProgram, studentLogin)
  await autoConfirmModals()

  await step('the lesson offers 改约', async () => {
    await miniProgram.reLaunch(`/pages/booking-detail/index?id=${bookingId}`)
    const detail = await waitForPage('pages/booking-detail/index', (d) => d.booking !== null)
    await expectStudent(miniProgram, studentLogin)
    const booking = (await detail.data('booking')) as Booking
    check(booking.canMove && booking.movesLeft === 1, 'a new paid lesson should be movable once')
    await sleep(1500)
    await screenshot('detail-before')
  })

  await step('the move page opens on the lesson’s own day and coach', async () => {
    await invokeTwice('move')
    const move = await waitForPage('pages/move/index', (d) => d.slotsState === 'ready')
    const pages = (await miniProgram.evaluate(() => getCurrentPages().length)) as number
    check(pages === 2, `a double tap should open one move page, got ${pages} pages`)
    const data = await move.data()
    check(data.date === day, `should open on ${day}, got ${data.date}`)
    check(data.coachId === coach.id, 'should open on the lesson’s coach')
    const slots = data.slots as { current: boolean }[]
    check(
      slots.some((s) => s.current),
      'the lesson’s own time should be marked 当前',
    )
    await screenshot('move')
  })

  if (clash && clashing) {
    await step('a time the student became busy at is refused and greyed out', async () => {
      const move = await waitForPage('pages/move/index', (d) => d.slotsState === 'ready')
      const slots = (await move.data('slots')) as { id: number; available: boolean }[]
      const index = slots.findIndex((s) => s.id === clash.id)
      check(slots[index]?.available, 'the clash time should still show as free')
      // Booked elsewhere, as from another phone, after the page loaded.
      await book(clashing.id)
      await tap(move, '.slot', index)
      await sleep(300)
      check(
        ((await move.data('picked')) as { id: number } | null)?.id === clash.id,
        'the clash time should be picked',
      )
      await invoke('submit')
      const after = await waitForPage('pages/move/index', (d) =>
        (d.slots as { id: number; refused: boolean }[]).some((s) => s.refused),
      )
      // data('picked') reads a null as undefined.
      check((await after.data()).picked === null, 'the refused time should be unpicked')
      await screenshot('move-refused')
    })
  } else {
    console.log('  (no overlapping slot with the second coach; skipped the clash step)')
  }

  let movedTo = ''
  await step('a double tap on 确认改约 moves the lesson once', async () => {
    const move = await waitForPage('pages/move/index', (d) => d.slotsState === 'ready')
    const slots = (await move.data('slots')) as {
      id: number
      startsAt: string
      available: boolean
    }[]
    const index = slots.findIndex((s) => s.available)
    const target = slots[index]
    check(target, 'no free time to move to')
    movedTo = target.startsAt
    await tap(move, '.slot', index)
    await screenshot('move-picked')
    await invokeTwice('submit')
    const detail = await waitForPage(
      'pages/booking-detail/index',
      (d) => (d.booking as Booking | null)?.startsAt === movedTo,
    )
    check(Boolean((await detail.data()).movedFrom), 'the old time should show as 原定时间')
    const booking = (await call('GET', `/bookings/${bookingId}`, undefined, token)) as Booking
    check(booking.startsAt === movedTo && booking.movesLeft === 0, 'moved once, none left')
    await screenshot('detail-moved')
  })

  await step('no moves left: 改约 is gone', async () => {
    const detail = await waitForPage('pages/booking-detail/index')
    check(((await detail.data('booking')) as Booking).canMove === false, 'should not move again')
    await miniProgram.navigateTo(`/pages/move/index?id=${bookingId}`)
    const move = await waitForPage('pages/move/index', (d) => d.state === 'error')
    await screenshot('move-none-left')
    check(String(await move.data('error')).includes('不能改约'), 'should say it cannot move')
  })

  await step('the coach moves the lesson in coach mode', async () => {
    if (coach.bound) await call('DELETE', `/admin/coaches/${coach.id}/binding`, undefined, admin)
    const { code } = await call('POST', `/admin/coaches/${coach.id}/bind-code`, {}, admin)
    await switchStudent(miniProgram, `qa_move_coach_${run}`)
    await miniProgram.reLaunch('/coach/bind/index')
    await waitForPage('coach/bind/index', () => true)
    await invoke('onCode', { detail: { value: code } })
    await invoke('submit')
    await waitForPage('coach/index/index', (d) => d.state === 'ready')

    await miniProgram.navigateTo(`/coach/lesson/index?id=${bookingId}`)
    await waitForPage('coach/lesson/index', (d) => d.state === 'ready')
    await screenshot('coach-lesson')
    await invokeTwice('move')
    const move = await waitForPage('coach/move/index', (d) => d.state === 'ready')
    const days = (await move.data('days')) as { key: string; free: number }[]
    const dayWithFree = days.find((d) => d.free > 0)
    check(dayWithFree, 'the coach has no free time to move to')
    await invoke('pickDate', { currentTarget: { dataset: { key: dayWithFree.key } } })
    await sleep(300)
    await screenshot('coach-move')
    const slots = (await move.data('slots')) as { startsAt: string }[]
    await tap(move, '.slot', 0)
    await screenshot('coach-move-picked')
    await invokeTwice('submit')
    const lesson = await waitForPage(
      'coach/lesson/index',
      (d) =>
        d.state === 'ready' &&
        (d.lesson as { startsAt: string } | null)?.startsAt === slots[0]?.startsAt,
    )
    check(Boolean((await lesson.data()).movedFrom), 'the coach should see the old time too')
    await screenshot('coach-lesson-moved')
    await call('DELETE', `/admin/coaches/${coach.id}/binding`, undefined, admin)
  })

  if (errors.length > 0) throw new Error(`Runtime errors:\n${errors.join('\n')}`)
  console.log('all move flows passed')
} finally {
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
