// Drives the student flows end to end against a local API seeded with `pnpm --filter @rs/api
// db:seed`: trial booking with payment, cancel and refund, a package purchase, a package booking,
// and losing a slot to another student between picking it and paying. Saves a screenshot of each
// screen to screenshots/flows/.
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { closeMiniProgram, type MiniProgram, openMiniProgram } from './launch'
import { expectStudent, switchStudent } from './session'
import { qaTheme, resetTheme, startTheme } from './theme'

const api = (process.env.API_BASE_URL ?? 'http://localhost:8787').replace(/\/+$/, '')
const projectPath = fileURLToPath(new URL('../../../apps/miniprogram', import.meta.url))
const outDir = fileURLToPath(new URL('../screenshots/flows', import.meta.url))
mkdirSync(outDir, { recursive: true })

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
  return { status: res.status, json: text ? JSON.parse(text) : null }
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
      // A page that just opened may not answer data() until it has finished loading.
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

/**
 * Calls a method on the current page without waiting for it. Page.callMethod fails on async
 * methods ("No context found for objectId"), so this goes through evaluate instead.
 */
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
  // Clears a forced theme an earlier run may have left, or applies QA_THEME.
  await startTheme(miniProgram)
  const student = `qa_${Date.now()}`
  await switchStudent(miniProgram, student)
  await autoConfirmModals()

  await step('home shows banners, notice and lessons', async () => {
    await miniProgram.reLaunch('/pages/booking/index')
    const home = await waitForPage('pages/booking/index')
    const data = await home.data()
    check(data.state === 'ready', `home state ${data.state}: ${data.error}`)
    check((data.lessonTypes as unknown[]).length >= 2, 'expected the seeded lesson types')
    check((data.banners as unknown[]).length >= 1, 'expected the seeded banners')
    await screenshot('home')
  })

  let trialBookingId = 0
  await step('book and pay for a trial lesson', async () => {
    const home = await waitForPage('pages/booking/index')
    const types = (await home.data('lessonTypes')) as { id: number; isTrial: boolean }[]
    const trialIndex = types.findIndex((t) => t.isTrial)
    check(trialIndex >= 0, 'no trial lesson on the home page')
    await tap(home, '.lesson', trialIndex)
    const book = await waitForPage('pages/book/index', (d) => d.slotsState === 'ready')
    // 首页 may use the catalog cached before the switch, so this page is the first to sign in.
    await expectStudent(miniProgram, student)
    await screenshot('book-trial')
    // Two days out is always past the 24-hour free-cancel deadline, so the refund is in full.
    await tap(book, '.day', 2)
    await waitForPage(
      'pages/book/index',
      (d) => d.slotsState === 'ready' && Number(d.availableCount) > 0,
    )
    const slots = (await book.data('slots')) as { available: boolean }[]
    await tap(
      book,
      '.slot',
      slots.findIndex((s) => s.available),
    )
    const confirm = await waitForPage('pages/confirm/index')
    const data = await confirm.data()
    check(data.payWith === 'wechat' && data.isTrial, 'trial should be paid by WeChat Pay')
    check(data.needName && data.needPhone && data.showAgreement, 'new student should see the form')
    await screenshot('confirm-trial')
    await invoke('submit')
    await sleep(300)
    check(
      (await miniProgram.currentPage())?.path === 'pages/confirm/index',
      'submitting without the form filled in should stay on the page',
    )
    await invoke('onName', { detail: { value: '测试学员' } })
    await invoke('onPhone', { detail: { value: '13800138000' } })
    await invoke('onAgree', { detail: { checked: true } })
    await screenshot('confirm-trial-filled')
    await invoke('submit')
    const detail = await waitForPage(
      'pages/booking-detail/index',
      (d) => (d.booking as { status?: string } | null)?.status === 'confirmed',
    )
    trialBookingId = ((await detail.data('booking')) as { id: number }).id
    // The icon font loads late on the first booking-detail page.
    await sleep(1500)
    await screenshot('trial-confirmed')
  })

  await step('trial limit stops a second trial', async () => {
    const token = (await miniProgram.callWxMethod('getStorageSync', 'token')) as string
    const catalog = await call('GET', '/catalog', undefined, token)
    const trial = catalog.json.lessonTypes.find((t: { isTrial: boolean }) => t.isTrial)
    const date = new Date(Date.now() + 8 * 3600_000 + 3 * 86400_000).toISOString().slice(0, 10)
    const slots = await call(
      'GET',
      `/slots?date=${date}&lessonTypeId=${trial.id}`,
      undefined,
      token,
    )
    const slot = slots.json.find((s: { available: boolean }) => s.available)
    check(slot, 'no trial slot to try')
    const res = await call(
      'POST',
      '/bookings',
      { coachId: slot.coachId, startsAt: slot.startsAt, lessonTypeId: trial.id },
      token,
    )
    check(res.json?.error?.code === 'trial_used', `expected trial_used, got ${res.status}`)
  })

  await step('lessons tab lists the booking', async () => {
    await miniProgram.switchTab('/pages/lessons/index')
    const lessons = await waitForPage('pages/lessons/index', (d) => d.state === 'ready')
    const rows = (await lessons.data('lessons')) as { id: number }[]
    check(
      rows.some((r) => r.id === trialBookingId),
      'trial booking missing from 即将开始',
    )
    await screenshot('lessons-upcoming')
  })

  await step('cancel the trial and get a refund', async () => {
    await miniProgram.navigateTo(`/pages/booking-detail/index?id=${trialBookingId}`)
    await waitForPage('pages/booking-detail/index')
    await invoke('cancel')
    const done = await waitForPage(
      'pages/booking-detail/index',
      (d) => (d.booking as { status?: string } | null)?.status === 'cancelled',
    )
    const data = await done.data()
    check(String(data.refund).includes('¥49'), `expected a ¥49 refund, got "${data.refund}"`)
    await screenshot('trial-cancelled')
  })

  await step('buy a 10-lesson package', async () => {
    await miniProgram.navigateTo('/pages/packages/index')
    const packages = await waitForPage('pages/packages/index')
    await screenshot('packages')
    const products = (await packages.data('products')) as { id: number; lessonCount: number }[]
    const ten = products.find((p) => p.lessonCount === 10)
    check(ten, 'seeded 10-lesson package missing')
    await invoke('buy', { currentTarget: { dataset: { id: ten.id } } })
    const mine = await waitForPage('pages/my-packages/index', (d) => d.state === 'ready')
    const rows = (await mine.data('packages')) as { remaining: number; active: boolean }[]
    check(
      rows.some((p) => p.active && p.remaining === 10),
      'new package should have 10 lessons',
    )
    await screenshot('my-packages')
  })

  await step('book a private lesson with the package', async () => {
    const token = (await miniProgram.callWxMethod('getStorageSync', 'token')) as string
    const catalog = await call('GET', '/catalog', undefined, token)
    const lesson = catalog.json.lessonTypes.find((t: { isTrial: boolean }) => !t.isTrial)
    const li = catalog.json.coaches.find((c: { name: string }) => c.name === '李静')
    await miniProgram.reLaunch(`/pages/book/index?lessonTypeId=${lesson.id}&coachId=${li.id}`)
    const book = await waitForPage('pages/book/index', (d) => d.slotsState === 'ready')
    await tap(book, '.day', 3)
    await waitForPage(
      'pages/book/index',
      (d) => d.slotsState === 'ready' && Number(d.availableCount) > 0,
    )
    await screenshot('book-private')
    const slots = (await book.data('slots')) as { available: boolean }[]
    await tap(
      book,
      '.slot',
      slots.findIndex((s) => s.available),
    )
    const confirm = await waitForPage('pages/confirm/index')
    const data = await confirm.data()
    check(data.payWith === 'package' && data.pkg, 'package should be chosen by default')
    check(!data.showAgreement && !data.needName, 'returning student should not see the form again')
    await screenshot('confirm-package')
    await invoke('submit')
    const detail = await waitForPage(
      'pages/booking-detail/index',
      (d) => (d.booking as { status?: string } | null)?.status === 'confirmed',
    )
    check(String((await detail.data()).payment).includes('课时包'), 'should be paid by package')
    await screenshot('package-booking')
  })

  await step('another student takes the slot before this one pays', async () => {
    const token = (await miniProgram.callWxMethod('getStorageSync', 'token')) as string
    const catalog = await call('GET', '/catalog', undefined, token)
    const lesson = catalog.json.lessonTypes.find((t: { isTrial: boolean }) => !t.isTrial)
    await miniProgram.reLaunch(`/pages/book/index?lessonTypeId=${lesson.id}`)
    const book = await waitForPage('pages/book/index', (d) => d.slotsState === 'ready')
    await tap(book, '.day', 4)
    await waitForPage(
      'pages/book/index',
      (d) => d.slotsState === 'ready' && Number(d.availableCount) > 0,
    )
    await miniProgram.pageScrollTo(10000)
    await screenshot('book-all-coaches-bottom')
    await miniProgram.pageScrollTo(0)
    type Time = { coachId: number; startsAt: string; available: boolean }
    const slots = (await book.data('slots')) as Time[]
    const index = slots.findIndex((s) => s.available)
    const slot = slots[index]
    check(slot, 'no slot to race for')
    await tap(book, '.slot', index)
    await waitForPage('pages/confirm/index')
    const rival = await call('POST', '/auth/student', { code: 'dev:qa_rival' })
    const policies = await call('GET', '/policies')
    await call('POST', '/me/consent', { version: policies.json.version }, rival.json.token)
    const taken = await call(
      'POST',
      '/bookings',
      {
        coachId: slot.coachId,
        startsAt: slot.startsAt,
        lessonTypeId: lesson.id,
        payWith: 'wechat',
      },
      rival.json.token,
    )
    check(taken.status === 201, `rival booking failed: ${JSON.stringify(taken.json)}`)
    await invoke('submit')
    // The page explains the time is gone and goes back to the time picker, which no longer offers it.
    const back = await waitForPage('pages/book/index', (d) => d.slotsState === 'ready')
    const after = (await back.data('slots')) as Time[]
    check(
      !after.some((s) => s.coachId === slot.coachId && s.startsAt === slot.startsAt && s.available),
      'the taken time should not be offered',
    )
    await screenshot('slot-taken')
    await call('POST', `/bookings/${taken.json.bookingId}/cancel`, undefined, rival.json.token)
  })

  await step('profile', async () => {
    await miniProgram.switchTab('/pages/profile/index')
    const profile = await waitForPage('pages/profile/index', (d) => Boolean(d.name))
    check((await profile.data('name')) === '测试学员', 'name from the confirm form should be saved')
    await screenshot('profile')
    await miniProgram.navigateTo('/pages/profile-edit/index')
    await waitForPage('pages/profile-edit/index', (d) => Boolean(d.name))
    await screenshot('profile-edit')
    await miniProgram.navigateBack()
    for (const kind of ['agreement', 'privacy']) {
      await miniProgram.navigateTo(`/pages/policy/index?kind=${kind}`)
      const policy = await waitForPage('pages/policy/index')
      check(
        ((await policy.data('lines')) as unknown[]).length > 0,
        `${kind} text should not be empty`,
      )
      await screenshot(kind)
      await miniProgram.navigateBack()
    }
  })

  await step('account deletion', async () => {
    // This student still has lessons and packages, so deletion is refused with the reasons.
    await miniProgram.navigateTo('/pages/account-delete/index')
    const blocked = await waitForPage('pages/account-delete/index')
    check(
      ((await blocked.data('blockers')) as string[]).length > 0,
      'a student with lessons should see why deletion is refused',
    )
    await screenshot('account-delete-blocked')

    // A fresh student can delete, and the next login is a new, empty account.
    await switchStudent(miniProgram, `${student}_gone`)
    await miniProgram.redirectTo('/pages/account-delete/index')
    const page = await waitForPage('pages/account-delete/index')
    await expectStudent(miniProgram, `${student}_gone`)
    check(((await page.data('blockers')) as string[]).length === 0, 'nothing should block')
    await screenshot('account-delete')
    const token = (await miniProgram.callWxMethod('getStorageSync', 'token')) as string
    await invoke('confirmDelete')
    await waitForPage('pages/booking/index')
    check((await call('GET', '/me', undefined, token)).status === 401, 'old session should be gone')
    await switchStudent(miniProgram, student)
  })

  if (errors.length > 0) throw new Error(`Runtime errors:\n${errors.join('\n')}`)
  console.log('all flows passed')
} finally {
  await miniProgram.restoreWxMethod('showModal').catch(() => {})
  try {
    // A forced theme would otherwise stay set for the next run.
    if (qaTheme()) await resetTheme(miniProgram)
  } finally {
    await closeMiniProgram(miniProgram)
  }
}
