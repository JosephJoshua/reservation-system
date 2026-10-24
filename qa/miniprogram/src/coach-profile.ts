// Drives the coach pages against a local API seeded with `pnpm --filter @rs/api db:seed`: the
// coach list on the home page, a coach's page with category, tags, prices and rich text profile,
// booking from it, the links to it from the booking and confirm pages, and the list of coaches
// shown on the booking page before one is picked. Saves screenshots to
// screenshots/coach-profile/; run it once in light and once in dark mode.
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import automator from 'miniprogram-automator'
import { qaTheme, resetTheme, startTheme } from './theme'

const projectPath = fileURLToPath(new URL('../../../apps/miniprogram', import.meta.url))
const outDir = fileURLToPath(new URL('../screenshots/coach-profile', import.meta.url))
mkdirSync(outDir, { recursive: true })

type MiniProgram = Awaited<ReturnType<typeof automator.launch>>
type Page = NonNullable<Awaited<ReturnType<MiniProgram['currentPage']>>>

// Runs inside the mini program, through evaluate.
declare function getCurrentPages(): unknown[]

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
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

/**
 * Calls a method on the current page without waiting for it. TDesign buttons cannot be found by
 * selector and Page.callMethod fails on page methods, so this goes through evaluate.
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
  await miniProgram.callWxMethod('setStorageSync', 'devLogin', `qa_coach_page_${Date.now()}`)
  await miniProgram.callWxMethod('removeStorageSync', 'token')

  type CoachRow = { id: number; name: string; category: string; title: string }
  let coaches: CoachRow[] = []
  await step('home lists the coaches with category and title', async () => {
    await miniProgram.reLaunch('/pages/booking/index')
    const home = await waitForPage('pages/booking/index')
    coaches = (await home.data('coaches')) as CoachRow[]
    check(coaches.length >= 3, `expected the seeded coaches, got ${coaches.length}`)
    check(coaches[0]?.category === '主教练', 'first coach should be the 主教练')
    await miniProgram.pageScrollTo(600)
    await screenshot('home-coaches')
  })

  await step("a coach's page shows category, tags, prices and profile", async () => {
    const home = await waitForPage('pages/booking/index')
    await tap(home, '.lesson', ((await home.data('lessonTypes')) as unknown[]).length)
    const page = await waitForPage('pages/coach-detail/index')
    const data = await page.data()
    check(data.state === 'ready', `coach page state ${data.state}: ${data.error}`)
    check(data.category === '主教练' && (data.tags as string[]).length === 3, 'category and tags')
    const lessons = data.lessons as { name: string; price: string }[]
    check(lessons.length === 1 && lessons[0]?.price === '¥360', `prices ${JSON.stringify(lessons)}`)
    check(String(data.profile).includes('class="rt-h3"'), 'profile should be rich text')
    check(
      /<img class="rt-img" src="http[^"]+demo-coach-1\.png"/.test(String(data.profile)),
      'image',
    )
    await screenshot('coach-top')
    await miniProgram.pageScrollTo(2000)
    await screenshot('coach-bottom')
  })

  await step(
    'booking from the coach page opens the time picker with the coach picked',
    async () => {
      await waitForPage('pages/coach-detail/index')
      await invoke('pickLesson')
      const book = await waitForPage('pages/book/index', (d) => d.slotsState !== 'loading')
      const data = await book.data()
      check(data.coachId === coaches[0]?.id, 'coach should be picked')
      check((data.picked as CoachRow | null)?.category === '主教练', 'coach line should show')
      await screenshot('book-with-coach')
    },
  )

  await step('the coach line goes to the coach page and booking returns to it', async () => {
    const book = await waitForPage('pages/book/index', (d) => d.slotsState !== 'loading')
    await tap(book, '.coach-info')
    await waitForPage('pages/coach-detail/index')
    await invoke('pickLesson')
    await waitForPage('pages/book/index', (d) => d.slotsState !== 'loading')
    const stack = (await miniProgram.evaluate(() => getCurrentPages().length)) as number
    check(stack === 3, `booking again should go back, not stack pages (${stack} pages)`)
  })

  await step('a coach with two lessons asks which one', async () => {
    const two = coaches.find((c) => c.title === '省队退役运动员')
    check(two, 'no seeded coach with two lessons')
    await miniProgram.reLaunch(`/pages/coach-detail/index?id=${two.id}`)
    const page = await waitForPage('pages/coach-detail/index')
    check(((await page.data('lessons')) as unknown[]).length === 2, 'expected two lessons')
    await miniProgram.mockWxMethod('showActionSheet', { tapIndex: 1, errMsg: 'showActionSheet:ok' })
    await invoke('pickLesson')
    const book = await waitForPage('pages/book/index', (d) => d.slotsState !== 'loading')
    check((await book.data('coachId')) === two.id, 'coach should be picked')
    await miniProgram.restoreWxMethod('showActionSheet')
  })

  const stackSize = async () =>
    (await miniProgram.evaluate(() => getCurrentPages().length)) as number

  /** Opens the time picker for 一对一私教, which all three seeded coaches teach. */
  async function openPrivateLesson(): Promise<Page> {
    await miniProgram.reLaunch('/pages/booking/index')
    const home = await waitForPage('pages/booking/index')
    const types = (await home.data('lessonTypes')) as { name: string }[]
    const index = types.findIndex((t) => t.name === '一对一私教')
    check(index >= 0, 'no seeded 一对一私教')
    await tap(home, '.lesson', index)
    return waitForPage('pages/book/index', (d) => d.slotsState !== 'loading')
  }

  await step('with no coach picked, the booking page lists every coach to read about', async () => {
    const book = await openPrivateLesson()
    check((await book.data('coachId')) === 0, 'no coach should be picked')
    check(((await book.data('coaches')) as unknown[]).length === 3, 'expected 3 coaches')
    await tap(book, '.coach-info')
    await sleep(400)
    check((await book.data('coachSheet')) === true, 'the coach list should open')
    check((await book.$$('.sheet-coach')).length === 3, 'every coach of the lesson is listed')
    await screenshot('book-coach-sheet')
    // A double tap opens the coach page once.
    const rows = await book.$$('.sheet-coach')
    await Promise.all([rows[0]?.tap(), rows[0]?.tap()])
    await waitForPage('pages/coach-detail/index')
    await sleep(800)
    check((await stackSize()) === 3, 'a double tap should open one coach page')
  })

  await step('going back keeps the list open and the choice unchanged', async () => {
    await miniProgram.navigateBack()
    const book = await waitForPage('pages/book/index', (d) => d.slotsState !== 'loading')
    check((await book.data('coachSheet')) === true, 'the list should still be open')
    check((await book.data('coachId')) === 0, 'no coach should be picked yet')
    const rows = await book.$$('.sheet-coach')
    await rows[0]?.tap()
    await waitForPage('pages/coach-detail/index')
  })

  await step('booking from the coach page picks that coach on the booking page', async () => {
    await invoke('pickLesson')
    await invoke('pickLesson')
    await waitForPage('pages/book/index')
    await sleep(800)
    check((await stackSize()) === 2, 'a double tap should go back once')
    // Slots reload on show, so wait for the ones for the picked coach.
    const book = await waitForPage('pages/book/index', (d) => d.slotsState !== 'loading')
    const data = await book.data()
    check(data.coachId === coaches[0]?.id, `coach should be picked (${data.coachId})`)
    check(data.coachSheet === false, 'the list should be closed')
    const slots = data.slots as { coachName: string }[]
    check(
      slots.every((s) => s.coachName === coaches[0]?.name),
      'slots should be for that coach only',
    )
    await screenshot('book-after-coach-sheet')
  })

  await step('the coach on the confirm page opens the coach page and returns', async () => {
    const book = await waitForPage('pages/book/index', (d) => d.slotsState !== 'loading')
    const slots = (await book.data('slots')) as { available: boolean }[]
    const index = slots.findIndex((s) => s.available)
    check(index >= 0, 'no open slot for the first coach')
    await tap(book, '.slot', index)
    const confirm = await waitForPage('pages/confirm/index')
    await screenshot('confirm-coach-link')
    await tap(confirm, '.coach')
    await waitForPage('pages/coach-detail/index')
    await invoke('pickLesson')
    await waitForPage('pages/confirm/index')
    await sleep(800)
    check((await stackSize()) === 3, 'booking again should go back to the confirm page')
  })

  await step(
    "picking a coach with nothing today skips ahead to that coach's first open day",
    async () => {
      // The seed gives 赵鹏 no slots today.
      const zhao = coaches.find((c) => c.title === '前市队主力')
      check(zhao, 'no seeded 赵鹏')
      const book = await openPrivateLesson()
      const before = (await book.data('date')) as string
      const today = ((await book.data('days')) as { key: string }[])[0]?.key
      await tap(book, '.coach-info')
      await sleep(400)
      const list = (await book.data('coaches')) as { id: number }[]
      await tap(
        book,
        '.sheet-coach',
        list.findIndex((c) => c.id === zhao.id),
      )
      const page = await waitForPage('pages/coach-detail/index')
      const lessons = (await page.data('lessons')) as { name: string }[]
      const tapIndex = lessons.findIndex((l) => l.name === '一对一私教')
      await miniProgram.mockWxMethod('showActionSheet', { tapIndex, errMsg: 'showActionSheet:ok' })
      await invoke('pickLesson')
      await waitForPage('pages/book/index')
      await sleep(800)
      const after = await waitForPage('pages/book/index', (d) => d.slotsState !== 'loading')
      await miniProgram.restoreWxMethod('showActionSheet')
      const data = await after.data()
      check(data.coachId === zhao.id, '赵鹏 should be picked')
      check(
        (data.availableCount as number) > 0,
        `the day shown should have open slots (${data.date})`,
      )
      if (before === today) check(data.date !== today, 'should have moved past today')
      await screenshot('book-skipped-to-first-day')
    },
  )

  await step('the coach row keeps the day when the coach is free then, else moves on', async () => {
    const book = await waitForPage('pages/book/index', (d) => d.slotsState !== 'loading')
    const list = (await book.data('coaches')) as { id: number; name: string }[]
    const chip = async (name: string) => {
      const index = list.findIndex((c) => c.name === name)
      check(index >= 0, `${name} should teach this lesson`)
      // The strip starts with 不限教练, so a coach's chip is one after their place in the list.
      await tap(book, '.coach', index + 1)
      await sleep(800)
      return waitForPage('pages/book/index', (d) => d.slotsState !== 'loading')
    }
    const day = (await book.data('date')) as string
    let page = await chip('王磊')
    check((await page.data('date')) === day, '王磊 is free that day, so it should stay')
    const today = ((await page.data('days')) as { key: string }[])[0]?.key
    check(day !== today, 'the step before should have left the page after today')
    await tap(page, '.day', 0)
    await sleep(800)
    page = await waitForPage('pages/book/index', (d) => d.slotsState !== 'loading')
    check((await page.data('date')) === today, 'picking today by hand should stay on today')
    page = await chip('赵鹏')
    const data = await page.data()
    check(data.date !== today && (data.availableCount as number) > 0, '赵鹏 should move on')
    await screenshot('book-chip-moved-on')
  })

  await step('an unknown coach shows the error state', async () => {
    await miniProgram.reLaunch('/pages/coach-detail/index?id=99999')
    await waitForPage('pages/coach-detail/index', (d) => d.state === 'error')
    await screenshot('coach-missing')
  })

  if (errors.length > 0) throw new Error(`Runtime errors:\n${errors.join('\n')}`)
  console.log('coach page checks passed')
} finally {
  try {
    // A forced theme would otherwise stay set for the next run.
    if (qaTheme()) await resetTheme(miniProgram)
  } finally {
    await miniProgram.close()
  }
}
