// Drives 课后点评 end to end against a local API seeded with `pnpm --filter @rs/api db:seed`: the
// student's empty 学习记录, a coach writing feedback with photos (double taps on add, save and
// delete), the student seeing it on the lesson and in 学习记录, and the coach deleting it after
// the venue hid it. Lessons are moved into the past in the API's SQLite file, so set QA_DB to it.
// Saves a screenshot of each screen to screenshots/feedback/. Run it once with DevTools in light
// and once in dark, or force the theme with QA_THEME.
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { venueDateKey } from '@rs/shared'
import { closeMiniProgram, type MiniProgram, openMiniProgram } from './launch'
import { expectStudent, switchStudent } from './session'
import { qaTheme, resetTheme, startTheme } from './theme'

const api = (process.env.API_BASE_URL ?? 'http://localhost:8787').replace(/\/+$/, '')
const adminPassword = process.env.ADMIN_PASSWORD ?? 'admin'
const dbPath = process.env.QA_DB
if (!dbPath) throw new Error('set QA_DB to the API database file, to move lessons into the past')
const forcedTheme = qaTheme()
const projectPath = fileURLToPath(new URL('../../../apps/miniprogram', import.meta.url))
const outDir = fileURLToPath(new URL('../screenshots/feedback', import.meta.url))
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

async function step(name: string, fn: () => Promise<void>) {
  console.log(`- ${name}`)
  await fn()
}

// Runs inside the mini program, where `wx` is the real API.
declare const wx: {
  env: { USER_DATA_PATH: string }
  getFileSystemManager(): {
    writeFileSync(path: string, data: string, encoding: string): void
  }
}

// A 64 x 64 PNG in the brand blue.
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAT0lEQVR42u3PQQkAAAgEsGtiM3Mbxwi+hcEKLNXzWgQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQELgvBxFE8wKhGPAAAAABJRU5ErkJggg=='

/** Moves a booking and its slot to the hour before last, so attendance and feedback are open. */
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

/** Makes wx.chooseMedia pick `count` copies of the test photo, saved as real local files. */
async function pickPhotos(count: number) {
  await miniProgram.evaluate((png: string) => {
    wx.getFileSystemManager().writeFileSync(`${wx.env.USER_DATA_PATH}/qa-photo.png`, png, 'base64')
  }, PNG)
  await miniProgram.mockWxMethod(
    'chooseMedia',
    function (this: unknown, options: Record<string, unknown>, n: number) {
      const path = `${wx.env.USER_DATA_PATH}/qa-photo.png`
      const res = {
        type: 'image',
        tempFiles: Array.from({ length: n }, () => ({
          tempFilePath: path,
          size: 200,
          fileType: 'image',
        })),
        errMsg: 'chooseMedia:ok',
      }
      if (typeof options.success === 'function') options.success(res)
      if (typeof options.complete === 'function') options.complete(res)
      return Promise.resolve(res)
    },
    count,
  )
}

/**
 * Makes wx.editImage return `result` ('cancel' closes it unsaved, 'bad' saves a file that is not
 * an image), and wx.compressImage hand the file back unchanged.
 */
async function mockEditor(result: 'ok' | 'cancel' | 'bad') {
  await miniProgram.evaluate(() => {
    const fs = wx.getFileSystemManager()
    fs.writeFileSync(`${wx.env.USER_DATA_PATH}/qa-bad.png`, 'not an image', 'utf8')
  })
  // The automator hands the mock the options without their callbacks and settles the call from
  // what it returns. No named inner functions: the build wraps them in __name, which DevTools lacks.
  await miniProgram.mockWxMethod(
    'editImage',
    function (this: unknown, _options: Record<string, unknown>, how: string) {
      if (how === 'cancel') return { errMsg: 'editImage:fail cancel' }
      const name = how === 'bad' ? 'qa-bad.png' : 'qa-photo.png'
      return { tempFilePath: `${wx.env.USER_DATA_PATH}/${name}`, errMsg: 'editImage:ok' }
    },
    result,
  )
  await miniProgram.mockWxMethod(
    'compressImage',
    function (this: unknown, options: Record<string, unknown>) {
      return { tempFilePath: options.src, errMsg: 'compressImage:ok' }
    },
  )
}

// Page data is read whole: data('x') reads a null as undefined.
interface Lesson {
  feedbackBlocked: string | null
  feedback: unknown
}

interface Photo {
  url: string
  uploading: boolean
}

const uploaded = (d: Record<string, unknown>, n: number) =>
  (d.photos as Photo[]).length === n && (d.photos as Photo[]).every((p) => !p.uploading && p.url)

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

  // A student with a paid lesson, moved into the past and marked attended by the venue.
  const studentLogin = `qa_fb_${run}`
  const token = (await call('POST', '/auth/student', { code: `dev:${studentLogin}` })).token
  const { version } = await call('GET', '/policies')
  await call('POST', '/me/consent', { version }, token)
  await call('PUT', '/me', { name: '林小雨', phone: '13900139002' }, token)
  let bookingId = 0
  for (let days = 2; days < 9 && !bookingId; days++) {
    const slots = (await call(
      'GET',
      `/slots?date=${venueDate(Date.now() + days * DAY)}&coachId=${coach.id}&lessonTypeId=${lesson.id}`,
      undefined,
      token,
    )) as { coachId: number; startsAt: string; available: boolean }[]
    const slot = slots.find((s) => s.available)
    if (!slot) continue
    const res = await call(
      'POST',
      '/bookings',
      {
        coachId: slot.coachId,
        startsAt: slot.startsAt,
        lessonTypeId: lesson.id,
        payWith: 'wechat',
      },
      token,
    )
    if (res.orderId) await call('POST', `/dev/fake-pay/${res.orderId}`, undefined, token)
    bookingId = res.bookingId
  }
  check(bookingId, 'the coach has no free slot in the next week')
  moveIntoPast(bookingId)
  await call('PUT', `/admin/bookings/${bookingId}/attendance`, { attendance: 'attended' }, admin)
  await autoConfirmModals()

  await step('学习记录 is empty before any feedback', async () => {
    await switchStudent(miniProgram, studentLogin)
    await miniProgram.reLaunch('/pages/feedback/index')
    const page = await waitForPage('pages/feedback/index')
    await expectStudent(miniProgram, studentLogin)
    check(((await page.data('items')) as unknown[]).length === 0, 'should start empty')
    await screenshot('record-empty')
  })

  await step('the coach opens the editor once on a double tap', async () => {
    if (coach.bound) await call('DELETE', `/admin/coaches/${coach.id}/binding`, undefined, admin)
    const { code } = await call('POST', `/admin/coaches/${coach.id}/bind-code`, {}, admin)
    await switchStudent(miniProgram, `qa_fb_coach_${run}`)
    await miniProgram.reLaunch('/coach/bind/index')
    await waitForPage('coach/bind/index', () => true)
    await invoke('onCode', { detail: { value: code } })
    await invoke('submit')
    await waitForPage('coach/index/index', (d) => d.state === 'ready')
    await miniProgram.navigateTo(`/coach/lesson/index?id=${bookingId}`)
    const page = await waitForPage('coach/lesson/index', (d) => d.state === 'ready')
    check(
      ((await page.data()).lesson as Lesson).feedbackBlocked === null,
      'an attended lesson should take feedback',
    )
    await screenshot('coach-lesson-before')
    await invokeTwice('writeFeedback')
    await waitForPage('coach/feedback/index', (d) => d.state === 'ready')
    const pages = (await miniProgram.evaluate(() => getCurrentPages().length)) as number
    check(pages === 3, `a double tap should open one editor, got ${pages} pages`)
    await screenshot('editor-empty')
  })

  await step('photos upload one at a time, and a double tap on 添加 adds once', async () => {
    await invoke('onText', { detail: { value: '正手拉球稳定多了，下次练反手拧拉和发球抢攻。' } })
    await pickPhotos(2)
    await invokeTwice('addPhotos')
    const page = await waitForPage('coach/feedback/index', (d) => uploaded(d, 2))
    await screenshot('editor-photos')
    await pickPhotos(1)
    await invoke('addPhotos')
    await waitForPage('coach/feedback/index', (d) => uploaded(d, 3))
    await invoke('removePhoto', { currentTarget: { dataset: { index: 0 } } })
    await waitForPage('coach/feedback/index', (d) => uploaded(d, 2) && d.canSave === true)
    check((await page.data('canSave')) === true, 'should be ready to publish')
    await screenshot('editor-ready')
  })

  await step(
    'editing a photo replaces it; a cancel or a failed upload keeps the old one',
    async () => {
      const page = await waitForPage('coach/feedback/index', (d) => uploaded(d, 2))
      check((await page.data('canEdit')) === true, 'DevTools should offer wx.editImage')
      const urls = async () => ((await page.data('photos')) as Photo[]).map((p) => p.url)
      const before = await urls()

      await mockEditor('cancel')
      await invoke('editPhoto', { currentTarget: { dataset: { index: 0 } } })
      await sleep(500)
      check((await urls()).join() === before.join(), 'a cancelled edit should change nothing')

      await mockEditor('bad')
      await invoke('editPhoto', { currentTarget: { dataset: { index: 0 } } })
      // The refusal shows as a toast, then the old photo is back.
      await sleep(1500)
      await waitForPage('coach/feedback/index', (d) => uploaded(d, 2))
      check((await urls()).join() === before.join(), 'a refused upload should put the old one back')

      await mockEditor('ok')
      // A double tap opens the editor once.
      await miniProgram.evaluate(() => {
        const pages = getCurrentPages()
        const page = pages[pages.length - 1] as unknown as Record<string, (e: unknown) => unknown>
        const tap = { currentTarget: { dataset: { index: 1 } } }
        page.editPhoto?.(tap)
        page.editPhoto?.(tap)
      })
      await waitForPage(
        'coach/feedback/index',
        (d) => uploaded(d, 2) && (d.photos as Photo[])[1]?.url !== before[1],
      )
      const after = await urls()
      check(after[0] === before[0], 'the other photo should stay')
      check(after[1] !== before[1] && after[1] !== '', 'the edited photo should be a new upload')
      check((await page.data('canSave')) === true, 'should still be ready to publish')
      await screenshot('editor-edited')
    },
  )

  await step('a double tap on 发布 saves once and goes back', async () => {
    await invokeTwice('save')
    const page = await waitForPage(
      'coach/lesson/index',
      (d) => d.state === 'ready' && (d.lesson as Lesson | null)?.feedback !== null,
    )
    const pages = (await miniProgram.evaluate(() => getCurrentPages().length)) as number
    check(pages === 2, `should be back on the lesson, got ${pages} pages`)
    check(
      ((await page.data('feedbackPhotos')) as string[]).length === 2,
      'the lesson should show both photos',
    )
    await screenshot('coach-lesson-feedback')
  })

  await step('the student sees it on the lesson and in 学习记录', async () => {
    await switchStudent(miniProgram, studentLogin)
    await miniProgram.reLaunch(`/pages/booking-detail/index?id=${bookingId}`)
    const detail = await waitForPage('pages/booking-detail/index', (d) => d.feedback !== null)
    const feedback = (await detail.data('feedback')) as { photos: string[] }
    check(feedback.photos.length === 2, 'the student should see both photos')
    await sleep(1000)
    await screenshot('student-detail')
    await miniProgram.navigateTo('/pages/feedback/index')
    const record = await waitForPage(
      'pages/feedback/index',
      (d) => d.state === 'ready' && (d.items as unknown[]).length === 1,
    )
    check(((await record.data()).items as unknown[]).length === 1, 'one entry in 学习记录')
    await sleep(1000)
    await screenshot('record')
  })

  await step(
    'hidden by the venue, the coach can only delete it, once on a double tap',
    async () => {
      const [item] = (await call('GET', '/admin/feedback', undefined, admin)).filter(
        (f: { bookingId: number }) => f.bookingId === bookingId,
      )
      await call('PUT', `/admin/feedback/${item.id}/hidden`, { hidden: true }, admin)
      await switchStudent(miniProgram, `qa_fb_coach_${run}`)
      await miniProgram.reLaunch(`/coach/lesson/index?id=${bookingId}`)
      const page = await waitForPage('coach/lesson/index', (d) => d.state === 'ready')
      const data = await page.data()
      check(Boolean(data.feedbackNote), 'should say the student cannot see it')
      check((data.lesson as Lesson).feedbackBlocked !== null, 'hidden feedback stays as is')
      await screenshot('coach-lesson-hidden')
      await invokeTwice('deleteFeedback')
      const deleted = await waitForPage(
        'coach/lesson/index',
        (d) => (d.lesson as Lesson | null)?.feedback === null,
      )
      check(
        (await deleted.data()).feedbackClosed === '点评已删除，不能再写',
        'should say why it cannot be written again',
      )
      await screenshot('coach-lesson-deleted')
      const [row] = (await call('GET', '/admin/feedback', undefined, admin)).filter(
        (f: { bookingId: number }) => f.bookingId === bookingId,
      )
      check(row.deleted && row.hidden, 'the venue should see it as hidden and deleted')
      await call('DELETE', `/admin/coaches/${coach.id}/binding`, undefined, admin)
    },
  )

  if (errors.length > 0) throw new Error(`Runtime errors:\n${errors.join('\n')}`)
  console.log('all feedback flows passed')
} finally {
  for (const method of ['showModal', 'chooseMedia', 'editImage', 'compressImage']) {
    await miniProgram.restoreWxMethod(method).catch(() => {})
  }
  for (const key of ['devLogin', 'token', 'coachToken']) {
    await miniProgram.callWxMethod('removeStorageSync', key).catch(() => {})
  }
  try {
    if (forcedTheme) await resetTheme(miniProgram)
  } finally {
    await closeMiniProgram(miniProgram)
  }
}
