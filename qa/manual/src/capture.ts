// Takes the admin screenshots and recordings for the 用户手册 (apps/docs). Run the API on the
// manual data (`pnpm --filter @rs/qa-manual data`) and the admin dev server first:
//
//   DATABASE_PATH=data/manual.db UPLOADS_DIR=data/manual-uploads pnpm --filter @rs/api start
//   pnpm --filter @rs/admin dev
//   pnpm --filter @rs/qa-manual capture [id ...]
//
// Shots are written as WebP to apps/docs/public/img/admin, recordings as MP4 to
// apps/docs/public/video. Needs ffmpeg. Pass ids to retake only some of them.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Browser, chromium, type Locator, type Page } from '@playwright/test'
import { venueDateKey } from '@rs/shared'

const here = dirname(fileURLToPath(import.meta.url))
const docs = resolve(here, '../../../apps/docs/public')
const imgDir = join(docs, 'img/admin')
const videoDir = join(docs, 'video')
mkdirSync(imgDir, { recursive: true })
mkdirSync(videoDir, { recursive: true })

const ADMIN = process.env.ADMIN_URL ?? 'http://localhost:5173/admin/'
const only = new Set(process.argv.slice(2))
const wanted = (id: string) => only.size === 0 || only.has(id)

// The cloud sandbox has Chromium at a fixed path; elsewhere Playwright's own browser is used.
const sandboxChromium = '/opt/pw-browsers/chromium'
const browser: Browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM ?? (existsSync(sandboxChromium) ? sandboxChromium : undefined),
})

const desktop = { viewport: { width: 1280, height: 760 }, deviceScaleFactor: 2 }
const phone = {
  viewport: { width: 390, height: 780 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
}

/** Writes a PNG buffer as WebP. */
function webp(png: Buffer, id: string) {
  execFileSync(
    'ffmpeg',
    [
      '-loglevel',
      'error',
      '-y',
      '-i',
      'pipe:0',
      '-c:v',
      'libwebp',
      '-quality',
      '88',
      join(imgDir, `${id}.webp`),
    ],
    { input: png },
  )
  console.log(`shot ${id}`)
}

// A visible pointer for recordings, which otherwise show clicks out of nowhere.
const pointerScript = `
addEventListener('DOMContentLoaded', () => {
  const dot = document.createElement('div')
  dot.style.cssText = 'position:fixed;z-index:2147483647;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(232,98,15,.35);border:2px solid #e8620f;pointer-events:none;transition:transform .15s;left:-50px;top:-50px'
  document.body.appendChild(dot)
  addEventListener('mousemove', (e) => { dot.style.left = e.clientX + 'px'; dot.style.top = e.clientY + 'px' }, true)
  addEventListener('mousedown', () => { dot.style.transform = 'scale(.6)' }, true)
  addEventListener('mouseup', () => { dot.style.transform = '' }, true)
})`

/** Contexts still open, so a failed step can close its own without keeping a half-made recording. */
const unfinished = new Set<() => Promise<void>>()

async function open(
  options: { phone?: boolean; record?: string; user?: [string, string] } = {},
): Promise<{ page: Page; done: () => Promise<void> }> {
  const base = {
    ...(options.phone ? phone : desktop),
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'light' as const,
  }
  // Sign in first, so a recording starts on the page it is about.
  const login = await browser.newContext(base)
  await login.addInitScript(() => localStorage.setItem('rs:theme', 'light'))
  const first = await login.newPage()
  const [username, password] = options.user ?? ['admin', 'admin']
  await first.goto(ADMIN)
  await first.getByPlaceholder('登录名').fill(username)
  await first.getByPlaceholder('密码').fill(password)
  await first.getByRole('button', { name: '登录' }).click()
  await first.getByRole('button', { name: '退出登录' }).waitFor()
  if (!options.record) {
    const close = () => login.close()
    unfinished.add(close)
    return {
      page: first,
      done: async () => {
        unfinished.delete(close)
        await close()
      },
    }
  }
  const storageState = await login.storageState()
  await login.close()

  const recordDir = mkdtempSync(join(tmpdir(), 'rs-rec-'))
  const size = options.phone ? phone.viewport : { width: 1280, height: 860 }
  const context = await browser.newContext({
    ...base,
    viewport: size,
    storageState,
    recordVideo: { dir: recordDir, size },
  })
  await context.addInitScript(pointerScript)
  const page = await context.newPage()
  const discard = async () => {
    await context.close()
    rmSync(recordDir, { recursive: true, force: true })
  }
  unfinished.add(discard)
  return {
    page,
    done: async () => {
      unfinished.delete(discard)
      await context.close()
      const file = readdirSync(recordDir).find((f) => f.endsWith('.webm'))
      if (file) {
        execFileSync('ffmpeg', [
          '-loglevel',
          'error',
          '-y',
          // The first moment is the page loading.
          '-ss',
          '0.8',
          '-i',
          join(recordDir, file),
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          '-crf',
          '30',
          '-preset',
          'slow',
          '-movflags',
          '+faststart',
          '-an',
          join(videoDir, `${options.record}.mp4`),
        ])
        console.log(`video ${options.record}`)
      }
      rmSync(recordDir, { recursive: true, force: true })
    },
  }
}

async function go(page: Page, hash: string) {
  await page.goto(`${ADMIN}#/${hash}`)
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(500)
}

/** Screenshots the viewport, or one element when given. */
async function shot(page: Page, id: string, target?: Locator) {
  if (!wanted(id)) return
  await page.waitForTimeout(300)
  const png = target
    ? await target.screenshot({ animations: 'disabled' })
    : await page.screenshot({ animations: 'disabled' })
  webp(png, id)
}

const dialog = (page: Page) => page.locator('.t-dialog:visible').last()

/** The venue date some days from today. */
const dayFromToday = (days: number) => venueDateKey(new Date(Date.now() + days * 86_400_000))

/** Picks a date in a TDesign date picker by clicking its day in the open calendar. */
async function typeDate(scope: Locator, date: string) {
  const page = scope.page()
  await scope.locator('.t-date-picker input').first().click()
  const panel = page.locator('.t-popup:visible .t-date-picker__panel').last()
  const month = Number(date.slice(5, 7))
  const shown = Number.parseInt(
    await panel.locator('.t-date-picker__header-controller-month input').inputValue(),
    10,
  )
  if (shown !== month)
    await panel
      .locator('.t-date-picker__header-controller-next, [class*=controller] .t-icon-chevron-right')
      .last()
      .click()
  await panel
    .locator(
      '.t-date-picker__cell:not(.t-date-picker__cell--disabled):not(.t-date-picker__cell--additional)',
    )
    .filter({ hasText: new RegExp(`^${Number(date.slice(8))}$`) })
    .first()
    .click()
  await page.waitForTimeout(800)
}

const drawer = (page: Page) => page.locator('.t-drawer__content-wrapper:visible').last()

// Login page, before signing in.
if (wanted('login')) {
  const context = await browser.newContext({ ...desktop, locale: 'zh-CN' })
  const page = await context.newPage()
  await page.goto(ADMIN)
  await page.getByPlaceholder('登录名').waitFor()
  webp(await page.screenshot(), 'login')
  await context.close()
}

const { page, done } = await open()

await go(page, 'overview')
await shot(page, 'overview')

if (wanted('command-menu')) {
  await page.keyboard.press('Control+k')
  await page.keyboard.type('张')
  await shot(page, 'command-menu')
  await page.keyboard.press('Escape')
}

await go(page, 'checkin')
await shot(page, 'today')
if (wanted('today-qr')) {
  await page.getByRole('button', { name: '签到码' }).click()
  await shot(page, 'today-qr', dialog(page))
  await page.keyboard.press('Escape')
}

/** Runs one part of the capture; a failure is reported and the rest goes on. */
async function step(ids: string[], fn: () => Promise<void>) {
  if (!ids.some(wanted)) return
  const before = new Set(unfinished)
  try {
    await fn()
  } catch (e) {
    console.error(`FAILED ${ids.join(', ')}: ${(e as Error).message.split('\n')[0]}`)
    for (const close of unfinished) {
      if (before.has(close)) continue
      unfinished.delete(close)
      await close().catch(() => {})
    }
    if (!page.isClosed()) {
      await page.setViewportSize(desktop.viewport)
      await page.keyboard.press('Escape').catch(() => {})
    }
  }
}

await step(['schedule', 'schedule-lesson', 'schedule-hours'], async () => {
  await go(page, 'schedule')
  await shot(page, 'schedule')
  await page.locator('.board-block').filter({ hasText: '已约' }).first().click()
  await shot(page, 'schedule-lesson', drawer(page).or(dialog(page)).first())
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  await page.locator('.board-coach').filter({ hasText: '王磊' }).first().click()
  await shot(page, 'schedule-hours', dialog(page))
  await page.keyboard.press('Escape')
})

await step(['book'], async () => {
  await go(page, 'schedule')
  await page.getByRole('button', { name: '代约' }).click()
  const d = dialog(page)
  await d.locator('.t-select').first().click()
  await page.keyboard.type('张伟')
  await page.waitForTimeout(800)
  await page.locator('.t-select-option:visible').first().click()
  await page.waitForTimeout(500)
  await d.locator('.t-dialog__header').click()
  await d.locator('.t-select').nth(2).click()
  await page.locator('.t-select-option:visible').filter({ hasText: '王磊' }).first().click()
  await typeDate(d, dayFromToday(2))
  await d
    .getByRole('button', { name: /^1[89]:00$/ })
    .first()
    .click()
    .catch(() => {})
  await page.setViewportSize({ width: 1280, height: 1000 })
  await shot(page, 'book', page.locator('.t-dialog:visible .t-dialog').last().or(d).first())
  await page.setViewportSize(desktop.viewport)
  await d.getByRole('button', { name: '返回' }).click()
})

await step(['desk-student'], async () => {
  await go(page, 'checkin')
  await page.getByRole('button', { name: '前台建档' }).click()
  const d = dialog(page)
  await d.getByPlaceholder('上课学员姓名').fill('李桂芳')
  await d.getByPlaceholder('11 位手机号').fill('13716582093')
  await shot(page, 'desk-student', d)
  await page.keyboard.press('Escape')
})

await step(['bookings', 'lesson-detail', 'move', 'cancel'], async () => {
  await go(page, 'bookings')
  await shot(page, 'bookings')
  await go(page, 'bookings?status=confirmed')
  const row = page
    .locator('tbody tr')
    .filter({ has: page.getByRole('button', { name: '改约' }) })
    .first()
  await row.getByRole('button', { name: '改约' }).click()
  await page.waitForTimeout(800)
  await typeDate(dialog(page), dayFromToday(3))
  await shot(page, 'move', dialog(page))
  await dialog(page).getByRole('button', { name: '返回' }).click()
  await page.waitForTimeout(400)
  await row.getByRole('button', { name: '取消' }).click()
  await page.waitForTimeout(500)
  await shot(page, 'cancel', dialog(page))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  await go(page, 'bookings?tab=feedback')
  await page
    .locator('tbody tr')
    .filter({ has: page.locator('img') })
    .first()
    .locator('.lesson-link')
    .click()
  await page.waitForTimeout(1000)
  await shot(page, 'lesson-detail')
  await page.keyboard.press('Escape')
})

await step(['feedback-list'], async () => {
  await go(page, 'bookings?tab=feedback')
  await shot(page, 'feedback-list')
})

await step(
  ['students', 'student-detail', 'student-profile', 'sell-package', 'bind-code'],
  async () => {
    await go(page, 'students')
    await shot(page, 'students')
    await page.locator('tbody tr a').filter({ hasText: '何欣怡' }).first().click()
    await page.waitForTimeout(1200)
    await shot(page, 'student-detail')
    await page.getByRole('button', { name: '编辑' }).first().click()
    await shot(page, 'student-profile', dialog(page))
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
    await page.getByRole('button', { name: '前台售卖' }).first().click()
    await page.waitForTimeout(500)
    await shot(page, 'sell-package', dialog(page))
    await page.keyboard.press('Escape')
    await go(page, 'students')
    await page.locator('tbody tr a').filter({ hasText: '刘建国' }).first().click()
    await page.waitForTimeout(1000)
    await page.getByRole('button', { name: '绑定微信' }).first().click()
    await page.waitForTimeout(800)
    await shot(page, 'bind-code', dialog(page))
    await page.keyboard.press('Escape')
  },
)

await step(['group-new'], async () => {
  await go(page, 'schedule')
  await page.getByRole('button', { name: '排小班课' }).click()
  await page.waitForTimeout(500)
  await shot(page, 'group-new', dialog(page))
  await page.keyboard.press('Escape')
})

await step(['orders'], async () => {
  await go(page, 'orders')
  await shot(page, 'orders')
})

await step(['refunds', 'refund-approve'], async () => {
  await go(page, 'refunds')
  await shot(page, 'refunds')
  await page.getByRole('button', { name: '同意' }).first().click()
  await page.waitForTimeout(400)
  await shot(page, 'refund-approve', dialog(page))
  await page.keyboard.press('Escape')
})

await step(['invoices', 'invoice-issue'], async () => {
  await go(page, 'invoices')
  await shot(page, 'invoices')
  await page.getByRole('button', { name: '上传发票' }).first().click()
  await page.waitForTimeout(400)
  await shot(page, 'invoice-issue', dialog(page))
  await page.keyboard.press('Escape')
})

await step(['stats', 'report-month'], async () => {
  await go(page, 'reports')
  await page.waitForTimeout(1000)
  await shot(page, 'stats')
  await page.getByText('月报与课时费', { exact: true }).click()
  await page.waitForTimeout(1200)
  await shot(page, 'report-month')
})

await step(['courses', 'course-edit'], async () => {
  await go(page, 'courses')
  await shot(page, 'courses')
  await page.getByRole('button', { name: '编辑' }).first().click()
  await page.waitForTimeout(800)
  await shot(page, 'course-edit')
  await go(page, 'courses')
})

await step(['coaches', 'coach-edit', 'coach-bind', 'categories'], async () => {
  await go(page, 'coaches')
  await shot(page, 'coaches')
  await page.getByRole('button', { name: '管理' }).first().click()
  await page.waitForTimeout(500)
  await shot(page, 'coach-bind', dialog(page))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: '编辑' }).first().click()
  await page.waitForTimeout(800)
  await shot(page, 'coach-edit')
  await go(page, 'coaches')
  await page.locator('.t-tabs__nav-item').filter({ hasText: '教练类别' }).click()
  await page.waitForTimeout(600)
  await shot(page, 'categories')
})

await step(['products', 'product-edit'], async () => {
  await go(page, 'products')
  await shot(page, 'products')
  await page.getByRole('button', { name: '编辑' }).first().click()
  await page.waitForTimeout(800)
  await shot(page, 'product-edit')
  await go(page, 'products')
})

await step(['home-content', 'banner-edit'], async () => {
  await go(page, 'banners')
  await shot(page, 'home-content')
  await page.getByRole('button', { name: '编辑' }).first().click()
  await page.waitForTimeout(800)
  await shot(page, 'banner-edit')
  await go(page, 'banners')
})

for (const section of [
  'venue',
  'booking',
  'schedule',
  'closures',
  'payment',
  'attendance',
  'pay',
]) {
  await step([`settings-${section}`], async () => {
    await go(page, `settings?section=${section}`)
    await shot(page, `settings-${section}`)
  })
}

await step(['staff', 'staff-new'], async () => {
  await go(page, 'staff')
  await shot(page, 'staff')
  await page.getByRole('button', { name: '新增员工' }).click()
  await page.waitForTimeout(400)
  await shot(page, 'staff-new', dialog(page))
  await page.keyboard.press('Escape')
})

await step(['action-log'], async () => {
  await go(page, 'actions')
  await shot(page, 'action-log')
})

await done()

// The admin on a phone.
await step(['phone-overview', 'phone-menu', 'phone-today', 'phone-bookings'], async () => {
  const m = await open({ phone: true })
  await go(m.page, 'overview')
  await shot(m.page, 'phone-overview')
  await m.page.getByRole('button', { name: '菜单' }).click()
  await m.page.waitForTimeout(500)
  await shot(m.page, 'phone-menu')
  await go(m.page, 'checkin')
  await shot(m.page, 'phone-today')
  await go(m.page, 'bookings')
  await shot(m.page, 'phone-bookings')
  await m.done()
})

// Recordings change the data, so they come last.
const pause = (page: Page, ms = 700) => page.waitForTimeout(ms)

/** Moves the pointer to an element in steps before clicking, so a recording can follow it. */
async function press(page: Page, target: Locator) {
  const box = await target.boundingBox()
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 })
  await pause(page, 250)
  await target.click()
  await pause(page)
}

await step(['v-checkin'], async () => {
  const r = await open({ record: 'admin-checkin' })
  const p = r.page
  await go(p, 'checkin')
  await pause(p, 1200)
  const row = p
    .locator('tbody tr')
    .filter({ has: p.getByRole('button', { name: '签到' }) })
    .first()
  await press(p, row.getByRole('button', { name: '签到' }))
  await pause(p, 1500)
  await press(
    p,
    p
      .locator('.t-radio-button, .t-tabs__nav-item, button')
      .filter({ hasText: /^已签到/ })
      .first(),
  )
  await pause(p, 1500)
  await r.done()
})

await step(['v-book'], async () => {
  const r = await open({ record: 'admin-book' })
  const p = r.page
  await go(p, 'schedule')
  await pause(p, 1000)
  await press(p, p.getByRole('button', { name: '代约' }))
  const d = dialog(p)
  await press(p, d.locator('.t-select').first())
  await p.keyboard.type('周婷', { delay: 150 })
  await pause(p, 900)
  await press(p, p.locator('.t-select-option:visible').first())
  await press(p, d.locator('.t-select').nth(2))
  await press(p, p.locator('.t-select-option:visible').filter({ hasText: '李静' }).first())
  await typeDate(d, dayFromToday(3))
  await press(p, d.getByRole('button', { name: /^1[5-9]:[03]0$/ }).first())
  await pause(p, 1000)
  await press(p, d.getByRole('button', { name: '确认代约' }))
  await pause(p, 2500)
  await r.done()
})

await step(['v-desk'], async () => {
  const r = await open({ record: 'admin-desk-student' })
  const p = r.page
  await go(p, 'checkin')
  await pause(p, 1000)
  await press(p, p.getByRole('button', { name: '前台建档' }))
  const d = dialog(p)
  await press(p, d.getByPlaceholder('上课学员姓名'))
  await p.keyboard.type('王建华', { delay: 150 })
  await press(p, d.getByPlaceholder('11 位手机号'))
  await p.keyboard.type('13651190276', { delay: 80 })
  await press(p, d.getByRole('button', { name: '建档' }))
  await pause(p, 2500)
  await r.done()
})

await step(['v-group'], async () => {
  const r = await open({ record: 'admin-group-class' })
  const p = r.page
  await go(p, 'schedule')
  await pause(p, 1000)
  await press(p, p.getByRole('button', { name: '排小班课' }))
  const d = dialog(p)
  for (const day of ['周一', '周二', '周三', '周四', '周五']) {
    await press(p, d.locator('.t-checkbox').filter({ hasText: day }))
  }
  const start = d
    .locator('.field')
    .filter({ has: p.locator('.field-label', { hasText: /^开始时间$/ }) })
    .locator('input')
  await press(p, start)
  await p.keyboard.press('ControlOrMeta+a')
  await p.keyboard.type('15:00', { delay: 120 })
  await pause(p, 800)
  await press(p, d.getByRole('button', { name: /^创建/ }))
  await pause(p, 2500)
  await r.done()
})

await browser.close()
