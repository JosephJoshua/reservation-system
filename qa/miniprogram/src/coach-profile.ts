// Drives the coach pages against a local API seeded with `pnpm --filter @rs/api db:seed`: the
// coach list on the home page, a coach's page with category, tags, prices and rich text profile,
// booking from it, and the link back from the booking page. Saves screenshots to
// screenshots/coach-profile/; run it once in light and once in dark mode.
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import automator from 'miniprogram-automator'
import { startTheme } from './theme'

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

  await step('an unknown coach shows the error state', async () => {
    await miniProgram.reLaunch('/pages/coach-detail/index?id=99999')
    await waitForPage('pages/coach-detail/index', (d) => d.state === 'error')
    await screenshot('coach-missing')
  })

  if (errors.length > 0) throw new Error(`Runtime errors:\n${errors.join('\n')}`)
  console.log('coach page checks passed')
} finally {
  await miniProgram.close()
}
