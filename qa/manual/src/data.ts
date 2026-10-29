// Builds the venue the 用户手册 screenshots are taken from: the demo seed plus seven weeks of
// history made through the API with a moving clock, so lists, reports and lesson pages look the
// way they do after a venue has run for a while. Writes a fresh database to DATABASE_PATH
// (default data/manual.db) and its images to UPLOADS_DIR (default data/manual-uploads).
//
//   pnpm --filter @rs/qa-manual data
//   DATABASE_PATH=data/manual.db UPLOADS_DIR=data/manual-uploads pnpm --filter @rs/api start
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { POLICY_VERSION, venueDateKey, venueInstant } from '@rs/shared'

const here = dirname(fileURLToPath(import.meta.url))
const apiDir = resolve(here, '../../../apps/api')
const dbPath = resolve(apiDir, process.env.DATABASE_PATH ?? 'data/manual.db')
const uploadsDir = resolve(apiDir, process.env.UPLOADS_DIR ?? 'data/manual-uploads')
// Both are wiped below, so refuse anything that is not the manual's own data.
if (!/manual/.test(dbPath) || !/manual/.test(uploadsDir)) {
  console.error(`Not a manual database or uploads folder: ${dbPath}, ${uploadsDir}`)
  process.exit(1)
}
for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(file, { force: true })
rmSync(uploadsDir, { recursive: true, force: true })
mkdirSync(uploadsDir, { recursive: true })
process.env.DATABASE_PATH = dbPath
process.env.UPLOADS_DIR = uploadsDir

// A clock the whole process shares: the seed, the API and this script all read Date.
const RealDate = Date
let offset = 0
class MovableDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(RealDate.now() + offset)
    // @ts-expect-error forwards Date's overloads
    else super(...args)
  }
  static override now() {
    return RealDate.now() + offset
  }
}
globalThis.Date = MovableDate as DateConstructor
const setClock = (at: Date) => {
  offset = at.getTime() - RealDate.now()
}

const DAY = 86_400_000
const realToday = venueDateKey(new RealDate())
const dayKey = (from: string, days: number) =>
  venueDateKey(new RealDate(Date.parse(`${from}T12:00:00Z`) + days * DAY))
const HISTORY_DAYS = 49
const firstDay = dayKey(realToday, -HISTORY_DAYS)
setClock(venueInstant(firstDay, 8 * 60))

// Same numbers on every run, so the screenshots stay comparable.
let seed = 20261027
function random() {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
}
const chance = (p: number) => random() < p
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T

await import('../../../apps/api/src/db/seed-demo')
const { createApp } = await import('../../../apps/api/src/app')
const { openDb } = await import('../../../apps/api/src/db/client')
const { FakeGateway } = await import('../../../apps/api/src/pay/fake')
const { devLogin } = await import('../../../apps/api/src/wx')
const { sweep } = await import('../../../apps/api/src/sweeper')
const { ensureFirstStaff } = await import('../../../apps/api/src/services/staff')
const schema = await import('../../../apps/api/src/db/schema')

const db = openDb(dbPath)
// Column defaults stamp rows with SQLite's own clock; make them follow the moving one instead.
db.$client.function('unixepoch', { deterministic: false }, () => Math.floor(Date.now() / 1000))
ensureFirstStaff(db, 'admin')
const deps = {
  db,
  gateway: new FakeGateway(),
  now: () => new Date(),
  wxLogin: devLogin,
  uploadsDir,
  log: () => {},
}
const app = createApp(deps)

// biome-ignore lint/suspicious/noExplicitAny: loosely typed JSON from the API
type Json = any
async function call(method: string, path: string, body?: unknown, token?: string): Promise<Json> {
  const res = await app.request(`/api${path}`, {
    method,
    headers: {
      ...(body === undefined || body instanceof FormData
        ? {}
        : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} ${res.status} ${text}`)
  return text ? JSON.parse(text) : null
}
const tryCall = (...args: Parameters<typeof call>) =>
  call(...args).catch((e) => {
    if (process.env.DEBUG) console.error((e as Error).message.slice(0, 300))
    return null
  })

let admin = (await call('POST', '/admin/login', { username: 'admin', password: 'admin' })).token

// Catalog extras: a rate for the kids' class, so months can be confirmed, and a fourth coach.
const coaches: Json[] = await call('GET', '/admin/coaches', undefined, admin)
const categories = db.select().from(schema.coachCategories).all()
const types = db.select().from(schema.lessonTypes).all()
const typeId = (name: string) => types.find((t) => t.name === name)?.id as number
const privateId = typeId('一对一私教')
const trialId = typeId('体验课')
const kidsId = typeId('少儿小班课')
const senior = categories.find((c) => c.name === '高级教练')
if (senior) {
  db.insert(schema.categoryPayRates)
    .values({ categoryId: senior.id, lessonTypeId: kidsId, rate: 12000 })
    .run()
}
const coachId = (name: string) => coaches.find((c) => c.name === name)?.id as number
const wang = coachId('王磊')
const li = coachId('李静')
const zhao = coachId('赵鹏')

// Coaches use the mini program's coach mode, with their own WeChat.
const coachTokens = new Map<number, string>()
const coachLogins = [
  [wang, 'coach-wang'],
  [li, 'coach-li'],
  [zhao, 'coach-zhao'],
] as const
for (const [id, wx] of coachLogins) {
  const { code } = await call('POST', `/admin/coaches/${id}/bind-code`, undefined, admin)
  const { token } = await call('POST', '/coach/bind', { code: `dev:${wx}`, bindCode: code })
  coachTokens.set(id, token)
}

// Staff: a front desk login and one for finance.
await call(
  'POST',
  '/admin/staff',
  { name: '周晓雯', username: 'zhouxw', password: 'qiantai2026', roles: ['front_desk'] },
  admin,
)
await call(
  'POST',
  '/admin/staff',
  { name: '陈敏', username: 'chenmin', password: 'caiwu2026', roles: ['finance'] },
  admin,
)

const names = [
  '张伟',
  '刘洋',
  '陈晨',
  '杨帆',
  '黄晓明',
  '周婷',
  '吴昊',
  '徐静',
  '孙浩然',
  '马丽',
  '朱子豪',
  '胡雪',
  '郭志强',
  '何欣怡',
  '林一鸣',
  '高翔',
  '罗佳',
  '梁思远',
  '宋雨桐',
  '郑凯',
  '谢明轩',
  '韩梅',
  '唐睿',
  '冯可馨',
]
const kidsNames = ['王小乐', '李子墨', '陈果果', '赵一诺', '周星辰', '吴悠悠']

interface Student {
  name: string
  token: string
  id: number
  kid: boolean
  /** Lessons a week this student likes to book. */
  pace: number
  coach: number
  joinDay: number
}
const people: Student[] = []
async function enroll(name: string, kid: boolean, joinDay: number) {
  const { token } = await call('POST', '/auth/student', { code: `dev:${name}` })
  await call('POST', '/me/consent', { version: POLICY_VERSION }, token)
  const phone = `1${pick(['38', '39', '58', '86', '35', '52'])}${String(Math.floor(random() * 1e8)).padStart(8, '0')}`
  await call('PUT', '/me', { name, phone }, token)
  const me = await call('GET', '/me', undefined, token)
  people.push({
    name,
    token,
    id: me.id,
    kid,
    pace: kid ? 1 : pick([0.5, 1, 1, 2, 2, 3]),
    coach: kid ? li : pick([wang, wang, li, zhao]),
    joinDay,
  })
}

async function pay(orderId: number | null, token: string) {
  if (orderId) await call('POST', `/dev/fake-pay/${orderId}`, undefined, token)
}

async function buyPackage(s: Student, productName: string) {
  const products = await call('GET', '/catalog', undefined, s.token)
  const product = products.packageProducts?.find((p: Json) => p.name === productName)
  if (!product) return
  const price = product.price.price
  const res = await tryCall(
    'POST',
    '/packages/purchase',
    { productId: product.id, expectedPrice: price },
    s.token,
  )
  await pay(res?.orderId ?? null, s.token)
}

const packagesOf = async (s: Student) =>
  ((await call('GET', '/packages', undefined, s.token)) as Json[]).filter(
    (p) => p.status === 'active' && p.lessonsRemaining > 0,
  )

async function book(s: Student, date: string, lessonTypeId: number) {
  const fits = (p: Json) => p.lessonTypeId === lessonTypeId
  let usable = (await packagesOf(s)).find(fits)
  if (!usable && lessonTypeId !== trialId) {
    await buyPackage(
      s,
      lessonTypeId === kidsId
        ? '少儿小班课 10 次卡'
        : s.pace >= 2
          ? '私教 20 次卡'
          : '私教 10 次卡',
    )
    usable = (await packagesOf(s)).find(fits)
  }
  // A package can be limited to some coaches.
  const allowed: number[] = usable?.coachIds?.length ? usable.coachIds : [wang, li, zhao]
  let coach = chance(0.85) ? s.coach : pick(allowed)
  if (!allowed.includes(coach)) coach = s.coach = pick(allowed)
  const group = lessonTypeId === kidsId
  const slots: Json[] = await call(
    'GET',
    `/slots?date=${date}&lessonTypeId=${lessonTypeId}${group ? '' : `&coachId=${coach}`}`,
    undefined,
    s.token,
  )
  // People book evenings and weekend mornings more than weekday mornings.
  const open = slots.filter((t) => t.available)
  if (!open.length) return null
  const evening = open.filter(
    (t) =>
      Date.parse(t.startsAt) >=
      venueInstant(venueDateKey(new RealDate(t.startsAt)), 17 * 60).getTime(),
  )
  const slot = pick(evening.length && chance(0.6) ? evening : open)
  const target = slot.id ? { slotId: slot.id } : { coachId: slot.coachId, startsAt: slot.startsAt }
  const res = await tryCall(
    'POST',
    '/bookings',
    {
      ...target,
      lessonTypeId,
      payWith: usable ? 'package' : 'wechat',
      expectedPackageId: usable?.id,
    },
    s.token,
  )
  if (!res) return null
  await pay(res.orderId, s.token)
  return res.bookingId as number
}

// Photos for 课后点评: soft gradients standing in for photos taken at the table.
const photoColors = [
  ['0x1f4fa8', '0xe8620f'],
  ['0x2c7a4b', '0xf2c14e'],
  ['0x4a3b8f', '0x19a7ce'],
  ['0xd1495b', '0x2e4057'],
]
const photoFiles = photoColors.map(([a, b], i) => {
  const file = join(uploadsDir, `manual-photo-${i}.jpg`)
  execFileSync('ffmpeg', [
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `gradients=s=960x720:c0=${a}:c1=${b}:x0=0:y0=0:x1=960:y1=720:d=1`,
    '-frames:v',
    '1',
    '-y',
    file,
  ])
  return file
})

const feedbackTexts = [
  '正手拉球的击球点比上次稳定，重心转换还可以再快一些。下次继续练正手拉下旋，加一组左右移动的多球。',
  '发球旋转明显加强了，短球控制得不错。接发球时注意判断旋转，回去可以对着墙多练摆短。',
  '反手拨球节奏很好，相持中能主动变线。下节课重点练反手转正手的衔接步法。',
  '今天主要练了侧身抢攻，第一板质量提高很多。体能稍弱，建议每周加两次跳绳。',
  '握拍放松了很多，推挡已经能连续 30 板以上。下次开始学正手攻球。',
  '比赛意识进步明显，发球后第三板的衔接更果断了。继续保持，月底可以打一场队内赛。',
]
const kidsFeedback = [
  '今天练了颠球和推挡，注意力很集中，能连续推挡 15 板。在家可以每天颠球 5 分钟。',
  '步法练习完成得很认真，正手动作越来越标准。下次课学习发平击球。',
]
const notes = [
  '多球 200 个，正手连续性好',
  '反手还需加强，下次多练拨球',
  '状态不错，可以加对抗',
  '提醒带护腕',
  '下次练发球抢攻',
]

async function writeFeedback(s: Student, bookingId: number, coach: number) {
  const token = coachTokens.get(coach)
  if (!token) return
  const photos: string[] = []
  if (chance(0.5)) {
    for (const file of photoFiles.slice(0, pick([1, 2, 3]))) {
      const form = new FormData()
      form.append('file', new Blob([readFileSync(file)], { type: 'image/jpeg' }), 'photo.jpg')
      const res = await tryCall('POST', `/coach/lessons/${bookingId}/photos`, form, token)
      if (res?.url) photos.push(res.url)
    }
  }
  await tryCall(
    'PUT',
    `/coach/lessons/${bookingId}/feedback`,
    { text: pick(s.kid ? kidsFeedback : feedbackTexts), photos },
    token,
  )
}

/** Lessons of one venue day, as the front desk sees them. */
async function deskDay(date: string): Promise<Json[]> {
  return call('GET', `/admin/front-desk?date=${date}`, undefined, admin)
}

/** Sessions run out over the weeks, so everyone signs in again each simulated day. */
async function signIn() {
  admin = (await call('POST', '/admin/login', { username: 'admin', password: 'admin' })).token
  for (const [id, wx] of coachLogins)
    coachTokens.set(id, (await call('POST', '/coach/login', { code: `dev:${wx}` })).token)
  for (const s of people)
    s.token = (await call('POST', '/auth/student', { code: `dev:${s.name}` })).token
}

let booked = 0
const todays = new Set<number>()
for (let d = 0; d <= HISTORY_DAYS; d++) {
  const date = dayKey(firstDay, d)
  const isToday = date === realToday
  setClock(venueInstant(date, 9 * 60))
  await signIn()

  // New students arrive over the weeks: half at the start, the rest a few a week.
  const due = names.filter((_, i) => (i < 12 ? 0 : Math.floor((i - 12) * 3.5)) === d)
  for (const name of due) await enroll(name, false, d)
  if (d === 0 || d === 14) {
    for (const name of kidsNames.slice(d === 0 ? 0 : 4, d === 0 ? 4 : 6))
      await enroll(name, true, d)
  }

  // Weekend kids' classes beyond the seed's first two weeks.
  if (d % 7 === 0 && d > 0) {
    const sessions = []
    for (let k = 0; k < 7; k++) {
      const day = dayKey(date, k + 7)
      const weekday = new RealDate(venueInstant(day, 12 * 60)).getUTCDay()
      if (weekday === 0 || weekday === 6) {
        sessions.push({
          coachId: li,
          startsAt: venueInstant(day, 9 * 60).toISOString(),
          endsAt: venueInstant(day, 10 * 60 + 30).toISOString(),
        })
      }
    }
    if (sessions.length)
      await tryCall(
        'POST',
        '/admin/sessions',
        { lessonTypeId: kidsId, capacity: 6, sessions },
        admin,
      )
  }

  for (const s of people) {
    // A first visit is often a trial lesson, then a package.
    if (s.joinDay === d && !s.kid && chance(0.5)) {
      await book(s, dayKey(date, pick([1, 2, 3])), trialId)
      continue
    }
    const pkgs = await packagesOf(s)
    if (!pkgs.length && (s.joinDay < d || s.kid) && chance(s.kid ? 1 : 0.35)) {
      await buyPackage(
        s,
        s.kid ? '少儿小班课 10 次卡' : s.pace >= 2 ? '私教 20 次卡' : '私教 10 次卡',
      )
    }
    if (s.kid) {
      // Kids come to the weekend class, booked a few days ahead.
      const weekend = [1, 2, 3, 4, 5, 6]
        .map((k) => dayKey(date, k))
        .filter((day) => [0, 6].includes(new RealDate(venueInstant(day, 12 * 60)).getUTCDay()))
      if (weekend.length && chance(0.45) && (await book(s, pick(weekend), kidsId))) booked++
    } else if (chance(Math.min(1, (s.pace * 1.8) / 7))) {
      if (await book(s, dayKey(date, pick([1, 2, 3, 4, 5, 6])), privateId)) booked++
    }
    // A full day today, for the front desk's 今日 page.
    if (!s.kid && d >= HISTORY_DAYS - 3 && !isToday && !todays.has(s.id) && chance(0.3)) {
      if (await book(s, realToday, privateId)) {
        booked++
        todays.add(s.id)
      }
    }
  }

  // Now and then someone cancels or moves a lesson that is still days away.
  if (chance(0.5)) {
    const s = pick(people.filter((p) => !p.kid))
    const mine: Json[] =
      (await tryCall('GET', '/bookings?scope=upcoming', undefined, s.token)) ?? []
    const next = mine.find((b: Json) => b.status === 'confirmed' && b.canMove)
    if (next) {
      if (chance(0.5)) {
        const options = await tryCall(
          'GET',
          `/bookings/${next.id}/move-options`,
          undefined,
          s.token,
        )
        const day = dayKey(date, 3)
        const slots: Json[] =
          (await tryCall(
            'GET',
            `/slots?date=${day}&lessonTypeId=${privateId}&coachId=${next.coach.id}&moving=${next.id}`,
            undefined,
            s.token,
          )) ?? []
        const free = slots.find((t) => t.available)
        if (options && free)
          await tryCall(
            'POST',
            `/bookings/${next.id}/move`,
            { coachId: free.coachId, startsAt: free.startsAt },
            s.token,
          )
      } else {
        await tryCall('POST', `/bookings/${next.id}/cancel`, {}, s.token)
      }
    }
  }

  // Through the day the desk and the coaches mark who came, and coaches write 课后点评.
  const realNow = RealDate.now()
  const at = (t: number) => setClock(new RealDate(Math.min(t, realNow)))
  await signIn()
  for (const lesson of await deskDay(date)) {
    const id = lesson.bookingId
    const start = Date.parse(lesson.startsAt)
    const end = Date.parse(lesson.endsAt)
    if (start > realNow || lesson.attendance) continue
    // The last lessons of today are still waiting to be marked.
    if (isToday && realNow - start < 2 * 3_600_000 && chance(0.6)) continue
    const came = chance(0.94)
    const coach = lesson.coach.id
    const token = coachTokens.get(coach)
    const attendance = came ? 'attended' : 'no_show'
    if (token && chance(0.5)) {
      at(start + (10 + Math.floor(random() * 40)) * 60_000)
      await tryCall('PUT', `/coach/lessons/${id}/attendance`, { attendance }, token)
    } else {
      at(came ? start - Math.floor(random() * 15) * 60_000 : start + 15 * 60_000)
      await tryCall('PUT', `/admin/bookings/${id}/attendance`, { attendance }, admin)
    }
    if (!came || end > realNow) continue
    at(end + (20 + Math.floor(random() * 150)) * 60_000)
    const s = people.find((p) => p.id === lesson.student.id)
    if (s && token && chance(0.6)) await writeFeedback(s, id, coach)
    if (token && chance(0.4))
      await tryCall('PUT', `/coach/lessons/${id}/note`, { note: pick(notes) }, token)
  }
  at(isToday ? realNow : venueInstant(date, 23 * 60).getTime())
  await sweep(deps as never)
}

setClock(new RealDate())
await signIn()

// 学员档案 for the regulars.
const tagSets = [['反手弱', '备赛'], ['步法慢'], ['发球好', '相持稳'], ['零基础'], ['左手持拍'], []]
for (const [i, s] of people.entries()) {
  if (i % 4 === 3) continue
  await tryCall(
    'PUT',
    `/admin/students/${s.id}/profile`,
    {
      level: s.kid ? 'beginner' : pick(['elementary', 'intermediate', 'intermediate', 'advanced']),
      grip: chance(0.8) ? 'shakehand' : 'penhold',
      tags: s.kid ? ['青少年'] : pick(tagSets),
      note: s.kid
        ? '注意力集中时间短，多用游戏方式练习'
        : pick(['', '目标是参加区业余联赛', '周末上课为主']),
    },
    admin,
  )
}

// Two students ask for their money back: one is settled, one waits for the admin.
const adults = people.filter((p) => !p.kid)
setClock(new RealDate(RealDate.now() - 4 * DAY))
await signIn()
const refunders = []
for (const s of adults) {
  const pkg = (await packagesOf(s)).find((p) => p.lessonsRemaining >= 5 && !p.paidOffline)
  if (pkg && (await tryCall('POST', `/packages/${pkg.id}/refund-request`, {}, s.token)))
    refunders.push(s)
  if (refunders.length === 2) break
}
const refunds: Json[] = await call('GET', '/admin/refunds?status=requested', undefined, admin)
const firstRefund = refunds[refunds.length - 1]
if (firstRefund) {
  setClock(new RealDate(RealDate.now() - 3 * DAY))
  await signIn()
  await tryCall(
    'POST',
    `/admin/refunds/${firstRefund.id}/approve`,
    { amount: firstRefund.amount },
    admin,
  )
}
setClock(new RealDate())
await signIn()

// Invoices: three requests, two issued.
const pdf = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
)
let invoiced = 0
for (const s of adults.slice(2)) {
  const { orders } = await call('GET', '/invoices', undefined, s.token)
  const order = orders.find((o: Json) => o.state === 'available' && o.amount > 0)
  if (!order) continue
  const company = invoiced === 1
  const done = await tryCall(
    'POST',
    '/invoices',
    {
      orderId: order.orderId,
      kind: company ? 'company' : 'personal',
      name: company ? '北京星火科技有限公司' : s.name,
      taxNumber: company ? '91110108MA01ABCD2X' : '',
      email: company ? 'finance@xinghuo-tech.cn' : `xueyuan${s.id}@163.com`,
    },
    s.token,
  )
  if (done && ++invoiced === 3) break
}
const invoiceRows: Json = await call('GET', '/admin/invoices', undefined, admin)
for (const inv of (Array.isArray(invoiceRows) ? invoiceRows : (invoiceRows.rows ?? [])).slice(
  0,
  2,
)) {
  const form = new FormData()
  form.append('file', new Blob([pdf], { type: 'application/pdf' }), 'invoice.pdf')
  await tryCall('POST', `/admin/invoices/${inv.id}/issue`, form, admin)
}

// Front desk: a student who signed up at the counter and paid cash for a package.
const desk = await tryCall(
  'POST',
  '/admin/students',
  { name: '刘建国', phone: '13910086688' },
  admin,
)
const tenPack = db
  .select()
  .from(schema.packageProducts)
  .all()
  .find((p) => p.name === '私教 10 次卡')
if (desk && tenPack) {
  await tryCall(
    'POST',
    '/admin/packages/offline-sale',
    {
      studentId: desk.id,
      productId: tenPack.id,
      amount: tenPack.salePrice ?? tenPack.price,
      method: 'cash',
      note: '',
    },
    admin,
  )
}

// A coach takes a day off next week, and the venue closes for an evening of maintenance.
const nextWeek = dayKey(realToday, 8)
await tryCall(
  'POST',
  `/admin/coaches/${zhao}/exceptions`,
  {
    kind: 'off',
    startsAt: venueInstant(nextWeek, 0).toISOString(),
    endsAt: venueInstant(dayKey(nextWeek, 1), 0).toISOString(),
    note: '外出比赛',
  },
  admin,
)
const closing = dayKey(realToday, 10)
await tryCall(
  'POST',
  '/admin/closures',
  {
    startsAt: venueInstant(closing, 18 * 60).toISOString(),
    endsAt: venueInstant(closing, 22 * 60).toISOString(),
    note: '球台维护',
  },
  admin,
)

// Last month's coach pay is checked and confirmed.
const lastMonth = dayKey(`${realToday.slice(0, 8)}01`, -1).slice(0, 7)
const report = await tryCall('GET', `/admin/reports/monthly?month=${lastMonth}`, undefined, admin)
const version = report?.payStatus?.version
if (version)
  await tryCall('POST', `/admin/reports/pay-months/${lastMonth}/confirm`, { version }, admin)

console.log(`${people.length} students, ${booked} lessons booked`)
if (!existsSync(dbPath)) throw new Error('no database written')
