// Drives 学员档案 on the coach lesson page against a local API seeded with
// `pnpm --filter @rs/api db:seed`: an empty profile, the coach filling it in from the lesson page
// (with a double tap on 保存), one the venue filled in, a coach save refused because the venue
// changed it meanwhile, the student's 课后点评 from every coach, the longest profile the admin
// allows, and the student's own lesson page, which must not show any of it. One lesson is moved into the past in the API's SQLite file to count, so
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
  edited: string
  feedbackCount: number
}

/** Picks the option at `tapIndex` in the next action sheet. */
async function pickInSheet(method: string, tapIndex: number) {
  await miniProgram.mockWxMethod('showActionSheet', { tapIndex, errMsg: 'showActionSheet:ok' })
  try {
    await invoke(method)
    await sleep(300)
  } finally {
    await miniProgram.restoreWxMethod('showActionSheet')
  }
}

const NOTE = '反手推挡偏慢，多练步法。\n目标：下个月区赛。'

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
    check(profile.counts === '已在本馆上课 1 次', `counts: ${profile.counts}`)
    check((await page.$('.profile-empty')) !== null, 'should say nothing is filled in')
    await screenshot('empty')
  })

  await step('the coach fills it in from the lesson page, double tapping 保存', async () => {
    await invoke('editProfile')
    page = await waitForPage('coach/profile/index', (d) => d.state === 'ready')
    check((await page.data()).edited === '', 'nobody has saved it yet')
    await screenshot('editor-empty')
    await pickInSheet('pickLevel', 1)
    await pickInSheet('pickGrip', 0)
    for (const tag of ['发球好', '  ', '发球好', '一二三四五六七八九十一']) {
      await invoke('onTyping', { detail: { value: tag } })
      await invoke('addTag')
    }
    await invoke('onNote', { detail: { value: '  正手稳定，反手要多练。  ' } })
    await sleep(300)
    let data = await page.data()
    check(data.levelText === '初级' && data.gripText === '横拍', `picked: ${data.levelText}`)
    // The repeat is dropped and the over-long tag stays typed, refused with a toast.
    check(JSON.stringify(data.tags) === '["发球好"]', `tags: ${JSON.stringify(data.tags)}`)
    await invoke('onTyping', { detail: { value: '' } })
    data = await page.data()
    check(data.canSave === true, 'should be saveable')
    await screenshot('editor-filled')
    // Unpicking the level shows 不填 last.
    await pickInSheet('pickLevel', 4)
    check((await page.data()).levelText === '未填', 'level should be cleared')
    await pickInSheet('pickLevel', 1)
    await invoke('save')
    await invoke('save')
    page = await waitForPage('coach/lesson/index', (d) => (d.profile as ProfileView).edited !== '')
    const profile = await profileOf()
    check(
      profile?.chips.map((c) => c.text).join(',') === '初级,横拍,发球好',
      `chips: ${JSON.stringify(profile?.chips)}`,
    )
    check(profile.note === '正手稳定，反手要多练。', `note: ${profile.note}`)
    check(profile.edited.endsWith('修改'), `edited: ${profile.edited}`)
    const pages = (await miniProgram.evaluate(() => getCurrentPages().length)) as number
    check(pages === 2, `the double tap went back twice or not at all: ${pages} pages`)
    await screenshot('saved-by-coach')
  })

  await step(
    'a save on top of the venue change keeps the coach edit and takes theirs',
    async () => {
      await invoke('editProfile')
      page = await waitForPage('coach/profile/index', (d) => d.state === 'ready')
      await invoke('onNote', { detail: { value: '教练这边的改动' } })
      await call(
        'PUT',
        `/admin/students/${studentId}/profile`,
        { level: 'elementary', grip: 'shakehand', tags: ['发球好'], note: '场馆先改了' },
        admin,
      )
      await miniProgram.mockWxMethod('showModal', { confirm: true, errMsg: 'showModal:ok' })
      try {
        await invoke('save')
        page = await waitForPage(
          'coach/profile/index',
          (d) => d.state === 'ready' && d.levelText === '初级',
        )
      } finally {
        await miniProgram.restoreWxMethod('showModal')
      }
      const data = await page.data()
      check(data.note === '教练这边的改动', `the coach's note was lost: ${data.note}`)
      check(data.gripText === '横拍' && JSON.stringify(data.tags) === '["发球好"]', 'not merged')
      check(String(data.edited).startsWith('场馆'), `edited: ${data.edited}`)
      check(data.canSave === true, 'the merged form should be saveable')
      await screenshot('conflict-merged')
      await invoke('save')
      page = await waitForPage(
        'coach/lesson/index',
        (d) => (d.profile as ProfileView)?.note === '教练这边的改动',
      )
    },
  )

  await step('the student 课后点评 from every coach are listed', async () => {
    const coachToken = (await call('POST', '/coach/login', { code: `dev:qa_sp_coach_${run}` }))
      .token as string
    await call(
      'PUT',
      `/coach/lessons/${past}/feedback`,
      { text: '发球旋转更强了，下次练接发球。', photos: [] },
      coachToken,
    )
    await invoke('load')
    page = await waitForPage(
      'coach/lesson/index',
      (d) => (d.profile as ProfileView).feedbackCount === 1,
    )
    await screenshot('feedback-count')
    await invoke('openStudentFeedback')
    await invoke('openStudentFeedback')
    const list = await waitForPage('coach/student-feedback/index', (d) => d.state === 'ready')
    const items = (await list.data()).items as { text: string; lesson: string }[]
    check(items.length === 1 && items[0]?.text.startsWith('发球旋转'), JSON.stringify(items))
    const pages = (await miniProgram.evaluate(() => getCurrentPages().length)) as number
    check(pages === 3, `the double tap opened the list twice: ${pages} pages`)
    await screenshot('feedback-list')
    await miniProgram.navigateBack()
    page = await waitForPage('coach/lesson/index', (d) => d.state === 'ready')
  })

  await step('the venue fills it in and a pull-down refresh shows it', async () => {
    await call(
      'PUT',
      `/admin/students/${studentId}/profile`,
      { level: 'intermediate', grip: 'penhold', tags: ['反手弱', '备赛'], note: NOTE },
      admin,
    )
    await invoke('onPullDownRefresh')
    page = await waitForPage('coach/lesson/index', (d) => (d.profile as ProfileView).note === NOTE)
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
    check(profile?.counts === '已在本馆上课 0 次，缺席 1 次', `counts: ${profile?.counts}`)
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
