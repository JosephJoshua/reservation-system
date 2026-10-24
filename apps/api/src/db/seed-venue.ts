// Fills an empty database with a busy venue: nine coaches, a few hundred students and five months
// of lessons, payments, refunds, attendance, 点评, packages, 学员档案 and 发票, plus two weeks of
// bookings ahead, so the dashboard, reports and lists look like daily use. Dates are relative to
// today, and a fixed random seed gives the same venue on every run. Refuses a database that already
// has coaches. Staff logins: admin/admin, desk/desk1234 (前台), finance/finance1234 (财务).
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  addVenueDays,
  defaultSettings,
  POLICY_VERSION,
  type StaffRole,
  venueDateKey,
  venueInstant,
  venueParts,
} from '@rs/shared'
import { and, eq, gt, gte, isNull, lt } from 'drizzle-orm'
import { config } from '../config'
import { syncSlots } from '../services/coaches'
import { newOutRefundNo, newOutTradeNo } from '../services/ids'
import { saveSettings } from '../services/settings'
import { ensureFirstStaff, hashPassword } from '../services/staff'
import { openDb } from './client'
import { gradientPng } from './demo-png'
import { runMigrations } from './migrate'
import {
  actionLog,
  banners,
  bookings,
  categoryPayRates,
  categoryPrices,
  coachCategories,
  coaches,
  coachHours,
  coachLessonTypes,
  invoices,
  lessonFeedback,
  lessonTypes,
  orders,
  packageLedger,
  packageProducts,
  packages,
  refunds,
  slots,
  staff,
  studentNotices,
  studentProfiles,
  students,
} from './schema'

const db = openDb(config.databasePath)
runMigrations(db)
if (db.select().from(coaches).get()) {
  console.error('This database already has coaches; seed an empty database instead.')
  process.exit(1)
}

// mulberry32: small and seedable, so every run builds the same venue.
let seed = 20261025
function rand() {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const chance = (p: number) => rand() < p
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('insert returned no row')
  return value
}
const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1))
function pick<T>(items: readonly T[]): T {
  const item = items[Math.floor(rand() * items.length)]
  if (item === undefined) throw new Error('pick from an empty list')
  return item
}
function weighted<T>(items: readonly T[], weight: (item: T) => number): T | undefined {
  const total = items.reduce((s, i) => s + weight(i), 0)
  let r = rand() * total
  for (const item of items) {
    r -= weight(item)
    if (r < 0) return item
  }
  return undefined
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const HISTORY_DAYS = 150
const AHEAD_DAYS = 14
const now = new Date()
const today = venueDateKey(now)
const firstDay = addVenueDays(today, -HISTORY_DAYS)
const at = (date: string, minute: number) => venueInstant(date, minute)
const weekday = (date: string) => venueParts(at(date, 12 * 60)).weekday
const before = (d: Date, ms: number) => new Date(d.getTime() - ms)
const after = (d: Date, ms: number) => new Date(d.getTime() + ms)
const earliest = (...dates: Date[]) => new Date(Math.min(...dates.map((d) => d.getTime())))

// Settings ---------------------------------------------------------------------------------------

saveSettings(
  db,
  {
    ...defaultSettings,
    venue: {
      name: '飞羽乒乓球馆',
      address: '海淀区中关村大街59号B1层',
      phone: '010-62345678',
      latitude: 39.9606,
      longitude: 116.3163,
      openingHours: '每天 09:00-22:00',
    },
    booking: { ...defaultSettings.booking, tables: 12 },
    notice: { text: '本周六下午场地检修，16:00 后正常上课', endsAt: null },
    policies: {
      booking:
        '1. 请提前 10 分钟到场热身。\n2. 开课前 24 小时可免费取消，之后取消视为已上课。\n3. 迟到不顺延下课时间。',
      agreement:
        '本协议是你与飞羽乒乓球馆之间关于使用预约服务的约定。\n\n1. 课时包仅限本人使用，不可转让。\n2. 课时包到期后剩余课时失效。\n3. 退款按实付金额扣除已上课时的单节原价计算。',
    },
  },
  now,
)

// Staff ------------------------------------------------------------------------------------------

ensureFirstStaff(db, config.adminPassword ?? 'admin')
const admin = db.select().from(staff).get()
if (!admin) throw new Error('admin login missing')
const addStaff = (name: string, username: string, password: string, roles: StaffRole[]) =>
  db
    .insert(staff)
    .values({
      name,
      username,
      passwordHash: hashPassword(password),
      roles,
      createdAt: at(firstDay, 9 * 60),
    })
    .returning()
    .get()
const desk = addStaff('陈晓雨', 'desk', 'desk1234', ['front_desk'])
const desk2 = addStaff('马俊', 'desk2', 'desk1234', ['front_desk'])
const finance = addStaff('刘会计', 'finance', 'finance1234', ['finance'])
db.insert(staff)
  .values({
    name: '何明',
    username: 'heming',
    passwordHash: hashPassword('left-the-venue'),
    roles: ['front_desk'],
    active: false,
    createdAt: at(firstDay, 9 * 60),
  })
  .run()
const deskStaff = [desk, desk2]

// Catalog ----------------------------------------------------------------------------------------

const categoryRows = db
  .insert(coachCategories)
  .values([
    { name: '主教练', sort: 0 },
    { name: '高级教练', sort: 1 },
    { name: '教练', sort: 2 },
  ])
  .returning()
  .all()
const head = must(categoryRows[0])
const senior = must(categoryRows[1])
const regular = must(categoryRows[2])

const typeRows = db
  .insert(lessonTypes)
  .values([
    {
      name: '体验课',
      description: '首次来馆专享，教练评估你的水平',
      durationMinutes: 60,
      price: 9900,
      isTrial: true,
      sort: 0,
    },
    {
      name: '一对一私教',
      description: '按你的水平定制训练，含多球和对练',
      durationMinutes: 60,
      price: 30000,
      sort: 1,
    },
    {
      name: '少儿小班课',
      description: '6-12 岁，基本功和步法，每班最多 6 人',
      durationMinutes: 90,
      price: 12000,
      capacity: 6,
      minStudents: 3,
      studentsPerTable: 2,
      sort: 2,
    },
    {
      name: '成人小班课',
      description: '有一定基础的成人，对练和战术，每班最多 4 人',
      durationMinutes: 90,
      price: 15000,
      capacity: 4,
      minStudents: 2,
      studentsPerTable: 2,
      sort: 3,
    },
  ])
  .returning()
  .all()
const trial = must(typeRows[0])
const privateLesson = must(typeRows[1])
const kids = must(typeRows[2])
const adults = must(typeRows[3])

const privatePrice = new Map([
  [head.id, 40000],
  [senior.id, 30000],
  [regular.id, 22000],
])
db.insert(categoryPrices)
  .values([
    { categoryId: head.id, lessonTypeId: privateLesson.id, price: 40000 },
    { categoryId: regular.id, lessonTypeId: privateLesson.id, price: 22000 },
  ])
  .run()
db.insert(categoryPayRates)
  .values([
    { categoryId: head.id, lessonTypeId: privateLesson.id, rate: 18000 },
    { categoryId: senior.id, lessonTypeId: privateLesson.id, rate: 12000 },
    { categoryId: regular.id, lessonTypeId: privateLesson.id, rate: 9000 },
    { categoryId: senior.id, lessonTypeId: trial.id, rate: 4000 },
    { categoryId: regular.id, lessonTypeId: trial.id, rate: 4000 },
    { categoryId: senior.id, lessonTypeId: kids.id, rate: 25000 },
    { categoryId: regular.id, lessonTypeId: kids.id, rate: 20000 },
    { categoryId: senior.id, lessonTypeId: adults.id, rate: 25000 },
  ])
  .run()

type Hours = { days: number[]; from: number; to: number }
type CoachSeed = {
  name: string
  category: typeof head
  title: string
  tags: string[]
  profile: string
  teaches: (typeof trial)[]
  hours: Hours[]
  // Weekly group sessions: weekday, start hour, lesson type.
  sessions?: { day: number; hour: number; type: typeof kids }[]
  active?: boolean
  // Venue days ago the coach joined; slots start then.
  joined?: number
}
const weekdays = [1, 2, 3, 4, 5]
const weekend = [0, 6]
const coachSeeds: CoachSeed[] = [
  {
    name: '王磊',
    category: head,
    title: '国家二级运动员',
    tags: ['弧圈球', '步法', '比赛备战'],
    profile:
      '<h3>执教经历</h3><p>执教 8 年，曾任市青少年队教练，带出多名省级比赛前八的学员。</p><h3>教学风格</h3><p>重视基本功和步法，<strong>每节课都有针对性的多球训练</strong>，适合想参加比赛的学员。</p>',
    teaches: [privateLesson],
    hours: [
      { days: [2, 3, 4, 5], from: 17, to: 21 },
      { days: weekend, from: 9, to: 17 },
    ],
  },
  {
    name: '陈思远',
    category: head,
    title: '前省队主力',
    tags: ['直拍', '台内技术', '战术'],
    profile: '<p>直拍横打专家，擅长台内小球和前三板战术，适合有基础想突破的学员。</p>',
    teaches: [privateLesson],
    hours: [
      { days: [1, 3, 5], from: 10, to: 12 },
      { days: [1, 3, 5], from: 18, to: 21 },
      { days: [6], from: 13, to: 19 },
    ],
  },
  {
    name: '李静',
    category: senior,
    title: '省队退役运动员',
    tags: ['零基础', '青少年'],
    profile:
      '<p>耐心细致，擅长从握拍和站位教起，适合零基础成人和 6 岁以上的孩子。</p><ul><li><p>前省队队员，退役后执教 5 年</p></li><li><p>国家二级社会体育指导员</p></li></ul>',
    teaches: [privateLesson, trial, kids],
    hours: [
      { days: weekdays, from: 16, to: 20 },
      { days: weekend, from: 11, to: 17 },
    ],
    sessions: [
      { day: 6, hour: 9, type: kids },
      { day: 0, hour: 9, type: kids },
    ],
  },
  {
    name: '赵鹏',
    category: senior,
    title: '前市队主力',
    tags: ['发球', '接发球'],
    profile: '<p>专注发球与接发球技术，帮你在比赛中抢到前三板的主动。</p>',
    teaches: [privateLesson, trial],
    hours: [
      { days: [1, 2, 4], from: 9, to: 12 },
      { days: [1, 2, 3, 4], from: 18, to: 22 },
      { days: [0], from: 10, to: 18 },
    ],
  },
  {
    name: '孙悦',
    category: senior,
    title: '国家一级裁判',
    tags: ['成人提高', '比赛规则', '双打'],
    profile: '<p>带成人小班多年，课堂节奏快，对练量大。也讲比赛规则和双打配合。</p>',
    teaches: [privateLesson, trial, adults],
    hours: [
      { days: [2, 4], from: 17, to: 19 },
      { days: [1, 5], from: 18, to: 21 },
      { days: [6], from: 10, to: 16 },
    ],
    sessions: [
      { day: 3, hour: 19, type: adults },
      { day: 6, hour: 17, type: adults },
    ],
  },
  {
    name: '周涛',
    category: regular,
    title: '体育学院乒乓球专业',
    tags: ['零基础', '正手'],
    profile: '<p>体育学院乒乓球专业毕业，讲解清楚，适合零基础和刚入门的成人。</p>',
    teaches: [privateLesson, trial],
    hours: [
      { days: [2, 3, 5], from: 18, to: 22 },
      { days: weekend, from: 9, to: 13 },
    ],
  },
  {
    name: '吴婷',
    category: regular,
    title: '少儿体育指导员',
    tags: ['少儿', '兴趣培养'],
    profile: '<p>擅长用游戏带孩子入门，培养兴趣和球感。</p>',
    teaches: [privateLesson, trial, kids],
    hours: [
      { days: [3, 4, 5], from: 16, to: 19 },
      { days: [6], from: 9, to: 13 },
    ],
    sessions: [{ day: 6, hour: 14, type: kids }],
  },
  {
    name: '郑凯',
    category: regular,
    title: '业余联赛冠军',
    tags: ['反手', '相持'],
    profile: '<p>今年新加入，周末带课为主。反手拧拉和相持是强项。</p>',
    teaches: [privateLesson, trial],
    hours: [{ days: weekend, from: 13, to: 20 }],
    joined: 45,
  },
  {
    name: '黄伟',
    category: regular,
    title: '',
    tags: ['正手'],
    profile: '<p>已离职。</p>',
    teaches: [privateLesson],
    hours: [{ days: [1, 2, 3], from: 18, to: 21 }],
    active: false,
  },
]

type CoachInfo = CoachSeed & { id: number; leftAt: string | null; joinedAt: string }
const coachList: CoachInfo[] = coachSeeds.map((c, i) => {
  const row = db
    .insert(coaches)
    .values({
      name: c.name,
      categoryId: c.category.id,
      title: c.title,
      tags: c.tags,
      profile: c.profile,
      active: c.active ?? true,
      sort: i + 1,
      openid: c.active === false ? null : `demo-coach-${i + 1}`,
      createdAt: at(firstDay, 9 * 60),
    })
    .returning()
    .get()
  db.insert(coachLessonTypes)
    .values(c.teaches.map((t) => ({ coachId: row.id, lessonTypeId: t.id })))
    .run()
  if (c.active !== false) {
    db.insert(coachHours)
      .values(
        c.hours.flatMap((h) =>
          h.days.map((day) => ({
            coachId: row.id,
            weekday: day,
            startMinute: h.from * 60,
            endMinute: h.to * 60,
            lessonMinutes: 60,
          })),
        ),
      )
      .run()
  }
  return {
    ...c,
    id: row.id,
    joinedAt: addVenueDays(today, -(c.joined ?? HISTORY_DAYS)),
    // 黄伟 left two months ago.
    leftAt: c.active === false ? addVenueDays(today, -60) : null,
  }
})
const coachById = new Map(coachList.map((c) => [c.id, c]))
const priceFor = (coach: CoachInfo) => privatePrice.get(coach.category.id) ?? privateLesson.price

const products = db
  .insert(packageProducts)
  .values([
    {
      name: '私教 10 次卡',
      description: '高级教练和教练可用，适合每周练一到两次',
      lessonTypeId: privateLesson.id,
      coachIds: coachList.filter((c) => c.category.id !== head.id).map((c) => c.id),
      lessonCount: 10,
      price: 260000,
      validityDays: 180,
      sort: 1,
    },
    {
      name: '私教 20 次卡',
      description: '高级教练和教练可用，单节最划算',
      lessonTypeId: privateLesson.id,
      coachIds: coachList.filter((c) => c.category.id !== head.id).map((c) => c.id),
      lessonCount: 20,
      price: 480000,
      validityDays: 365,
      sort: 2,
    },
    {
      name: '主教练 10 次卡',
      description: '王磊、陈思远可用',
      lessonTypeId: privateLesson.id,
      coachIds: coachList.filter((c) => c.category.id === head.id).map((c) => c.id),
      lessonCount: 10,
      price: 360000,
      validityDays: 180,
      sort: 3,
    },
    {
      name: '少儿小班课 10 次卡',
      description: '只用于少儿小班课',
      lessonTypeId: kids.id,
      coachIds: [],
      lessonCount: 10,
      price: 100000,
      validityDays: 180,
      sort: 4,
    },
    {
      name: '成人小班课 8 次卡',
      description: '只用于成人小班课',
      lessonTypeId: adults.id,
      coachIds: [],
      lessonCount: 8,
      price: 104000,
      validityDays: 120,
      sort: 5,
    },
  ])
  .returning()
  .all()
const tenPack = must(products[0])
const twentyPack = must(products[1])
const headPack = must(products[2])
const kidsPack = must(products[3])
const adultPack = must(products[4])

// Students ---------------------------------------------------------------------------------------

const surnames =
  '王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤'
const givenAdult = [
  '伟',
  '芳',
  '娜',
  '敏',
  '静',
  '磊',
  '强',
  '军',
  '洋',
  '勇',
  '艳',
  '杰',
  '涛',
  '明',
  '超',
  '霞',
  '平',
  '刚',
  '桂英',
  '建华',
  '志强',
  '海燕',
  '晓东',
  '丽娟',
  '文博',
  '雪梅',
  '子豪',
  '思琪',
  '浩然',
  '雨桐',
  '宇航',
  '欣怡',
  '俊杰',
  '佳慧',
  '晨阳',
  '梦瑶',
  '国栋',
  '亚楠',
  '振宇',
  '晓峰',
]
const givenKid = [
  '梓涵',
  '一诺',
  '子轩',
  '若汐',
  '浩宇',
  '可馨',
  '沐阳',
  '语桐',
  '宇轩',
  '诗涵',
  '铭泽',
  '欣妍',
  '睿',
  '朵朵',
  '乐乐',
  '子墨',
  '安琪',
  '皓轩',
  '星辰',
  '悦',
  '嘉懿',
  '天佑',
  '芊芊',
  '奕辰',
]

type Kind = 'regular' | 'casual' | 'trialOnly' | 'lapsed' | 'kid' | 'groupAdult'
type StudentInfo = {
  id: number
  kind: Kind
  joined: Date
  desk: boolean
  fav: CoachInfo
  // Venue date after which a lapsed student stops coming.
  lapseOn: string | null
  hadTrial: boolean
  bookedDays: Set<string>
  // Weekly group session this student attends: coach id, weekday and hour.
  session: { coachId: number; day: number; hour: number } | null
}

const STUDENTS = 380
const kindWeights: [Kind, number][] = [
  ['regular', 0.24],
  ['casual', 0.28],
  ['trialOnly', 0.16],
  ['lapsed', 0.08],
  ['kid', 0.16],
  ['groupAdult', 0.08],
]
const groupSessions = coachList.flatMap((c) =>
  (c.sessions ?? []).map((s) => ({ coachId: c.id, day: s.day, hour: s.hour, type: s.type })),
)
const usedPhones = new Set<string>()
const phone = () => {
  for (;;) {
    const p = `1${pick(['3', '5', '7', '8', '9'])}${String(int(0, 999_999_999)).padStart(9, '0')}`
    if (!usedPhones.has(p)) {
      usedPhones.add(p)
      return p
    }
  }
}
const privateCoaches = coachList.filter((c) => c.teaches.includes(privateLesson))
const studentList: StudentInfo[] = []
for (let i = 0; i < STUDENTS; i++) {
  const kind = weighted(kindWeights, ([, w]) => w)?.[0] ?? 'casual'
  // About a third were students before the history starts; the rest join at a growing pace.
  const daysAgo = chance(0.32)
    ? HISTORY_DAYS + int(10, 300)
    : Math.floor(HISTORY_DAYS * (1 - Math.sqrt(rand())))
  const joined = new Date(now.getTime() - daysAgo * DAY - int(0, 10) * HOUR)
  const desk = chance(0.06)
  const isKid = kind === 'kid'
  const name = `${surnames[int(0, surnames.length - 1)]}${pick(isKid ? givenKid : givenAdult)}`
  const session =
    kind === 'kid' || kind === 'groupAdult'
      ? pick(groupSessions.filter((s) => s.type.id === (isKid ? kids.id : adults.id)))
      : null
  const row = db
    .insert(students)
    .values({
      openid: desk ? `desk:demo-${i + 1}` : `demo-student-${i + 1}`,
      name,
      phone: phone(),
      policyVersion: desk ? null : POLICY_VERSION,
      policyAgreedAt: desk ? null : joined,
      createdAt: joined,
    })
    .returning({ id: students.id })
    .get()
  const fav = weighted(
    privateCoaches.filter((c) => c.active !== false || daysAgo > 60),
    (c) => (c.category.id === head.id ? 1 : 1.6),
  )
  if (!fav) throw new Error('no coach to favour')
  studentList.push({
    id: row.id,
    kind,
    joined,
    desk,
    fav,
    lapseOn: kind === 'lapsed' ? addVenueDays(today, -int(35, 110)) : null,
    hadTrial: daysAgo > HISTORY_DAYS,
    bookedDays: new Set(),
    session: session ? { coachId: session.coachId, day: session.day, hour: session.hour } : null,
  })
}

// Slots ------------------------------------------------------------------------------------------

type Slot = typeof slots.$inferSelect
const sessionMinutes = 90
const sessionsOn = (coach: CoachInfo, date: string) =>
  (coach.sessions ?? []).filter((s) => s.day === weekday(date))
const working = (coach: CoachInfo, date: string) =>
  date >= coach.joinedAt && (!coach.leftAt || date < coach.leftAt)

function insertSessions(date: string): Slot[] {
  const rows = coachList.flatMap((coach) =>
    working(coach, date)
      ? sessionsOn(coach, date).map((s) => ({
          coachId: coach.id,
          startsAt: at(date, s.hour * 60),
          endsAt: at(date, s.hour * 60 + sessionMinutes),
          lessonTypeId: s.type.id,
          capacity: s.type.capacity,
          createdAt: before(at(date, 0), 20 * DAY),
        }))
      : [],
  )
  return rows.length ? db.insert(slots).values(rows).returning().all() : []
}

/** Private slots from the weekly hours that have already started; the slot sync makes the rest. */
function insertPastPrivate(date: string): Slot[] {
  const rows: (typeof slots.$inferInsert)[] = []
  for (const coach of coachList) {
    if (!working(coach, date)) continue
    const sessions = sessionsOn(coach, date)
    for (const h of coach.hours.filter((h) => h.days.includes(weekday(date)))) {
      for (let hour = h.from; hour < h.to; hour++) {
        const startsAt = at(date, hour * 60)
        const endsAt = at(date, hour * 60 + 60)
        if (startsAt > now) continue
        const clash = sessions.some((s) => {
          const from = at(date, s.hour * 60)
          return from < endsAt && after(from, sessionMinutes * MINUTE) > startsAt
        })
        if (clash) continue
        rows.push({
          coachId: coach.id,
          startsAt,
          endsAt,
          source: 'hours',
          createdAt: before(startsAt, 14 * DAY),
        })
      }
    }
  }
  return rows.length ? db.insert(slots).values(rows).returning().all() : []
}

// Coming group sessions go in first, so the slot sync leaves their time free; then the sync builds
// the coming private slots from the weekly hours, as the sweeper does.
const comingSessions = new Map<string, Slot[]>()
for (let d = 0; d <= AHEAD_DAYS; d++) {
  const date = addVenueDays(today, d)
  comingSessions.set(date, insertSessions(date))
}
for (const coach of coachList) {
  if (coach.active !== false) syncSlots(db, coach.id, now)
}

function daySlots(date: string): Slot[] {
  if (date < today) return [...insertSessions(date), ...insertPastPrivate(date)]
  const next = at(addVenueDays(date, 1), 0)
  const coming = db
    .select()
    .from(slots)
    .where(
      and(
        isNull(slots.lessonTypeId),
        gte(slots.startsAt, at(date, 0)),
        lt(slots.startsAt, next),
        gt(slots.startsAt, now),
      ),
    )
    .all()
  return [
    ...(comingSessions.get(date) ?? []),
    ...(date === today ? insertPastPrivate(date) : []),
    ...coming,
  ].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
}

// Money and packages -----------------------------------------------------------------------------

type Product = typeof packageProducts.$inferSelect
type Pkg = typeof packages.$inferSelect & { product: Product }
const packagesOf = new Map<number, Pkg[]>()
type Booking = typeof bookings.$inferSelect
const bookingRows: Booking[] = []
const orderOfBooking = new Map<number, typeof orders.$inferSelect>()
let orderCount = 0

function addOrder(o: {
  student: StudentInfo
  kind: 'class' | 'trial' | 'package'
  description: string
  amount: number
  paidAt: Date
  bookingId?: number
  productId?: number
}) {
  const offline = o.student.desk || chance(0.12)
  const staffMember = pick(deskStaff)
  orderCount++
  const row = db
    .insert(orders)
    .values({
      outTradeNo: newOutTradeNo(o.paidAt),
      studentId: o.student.id,
      kind: o.kind,
      description: o.description,
      amount: o.amount,
      provider: offline ? 'offline' : 'wechat',
      offlineMethod: offline
        ? pick(['wechat', 'alipay', 'cash', 'wechat', 'transfer'] as const)
        : null,
      status: 'paid',
      prepayId: offline ? null : `wx${o.paidAt.getTime()}${orderCount}`,
      transactionId: offline ? null : `4200${String(o.paidAt.getTime()).slice(-10)}${orderCount}`,
      bookingId: o.bookingId ?? null,
      productId: o.productId ?? null,
      expiresAt: offline ? null : after(o.paidAt, 10 * MINUTE),
      paidAt: o.paidAt,
      createdAt: before(o.paidAt, int(10, 90) * 1000),
    })
    .returning()
    .get()
  if (offline) {
    db.insert(actionLog)
      .values({
        staffId: staffMember.id,
        action: o.kind === 'package' ? 'sell_package' : 'desk_booking',
        summary: o.kind === 'package' ? `线下售出${o.description}` : `代约并收款：${o.description}`,
        amount: o.amount,
        studentId: o.student.id,
        targetKind: 'order',
        targetId: row.id,
        createdAt: o.paidAt,
      })
      .run()
  }
  return row
}

function buyPackage(student: StudentInfo, product: Product, paidAt: Date) {
  const order = addOrder({
    student,
    kind: 'package',
    description: product.name,
    amount: product.price,
    paidAt,
    productId: product.id,
  })
  const row = db
    .insert(packages)
    .values({
      studentId: student.id,
      productId: product.id,
      name: product.name,
      lessonTypeId: product.lessonTypeId,
      coachIds: product.coachIds,
      lessonsPurchased: product.lessonCount,
      lessonsRemaining: product.lessonCount,
      pricePaid: product.price,
      expiresAt: after(paidAt, product.validityDays * DAY),
      status: 'active',
      orderId: order.id,
      createdAt: paidAt,
    })
    .returning()
    .get()
  db.insert(packageLedger)
    .values({
      packageId: row.id,
      delta: product.lessonCount,
      kind: 'purchase',
      actor: 'student',
      createdAt: paidAt,
    })
    .run()
  const pkg = { ...row, product }
  packagesOf.set(student.id, [...(packagesOf.get(student.id) ?? []), pkg])
  return pkg
}

function usablePackage(
  student: StudentInfo,
  lessonTypeId: number,
  coachId: number,
  startsAt: Date,
) {
  return packagesOf
    .get(student.id)
    ?.find(
      (p) =>
        p.status === 'active' &&
        p.lessonTypeId === lessonTypeId &&
        p.lessonsRemaining > 0 &&
        p.expiresAt > startsAt &&
        (p.coachIds.length === 0 || p.coachIds.includes(coachId)),
    )
}

function packageFor(student: StudentInfo, lessonTypeId: number, coach: CoachInfo, bookedAt: Date) {
  const found = usablePackage(student, lessonTypeId, coach.id, bookedAt)
  if (found) return found
  if (lessonTypeId === kids.id) return buyPackage(student, kidsPack, before(bookedAt, HOUR))
  if (lessonTypeId === adults.id) {
    return chance(0.6) ? buyPackage(student, adultPack, before(bookedAt, HOUR)) : undefined
  }
  // A private package is bought for the student's own coach; lessons with others are paid singly.
  if (coach.id !== student.fav.id) return undefined
  if (student.kind !== 'regular')
    return chance(0.05) ? buyPackage(student, tenPack, bookedAt) : undefined
  if (coach.category.id === head.id) {
    return chance(0.8) ? buyPackage(student, headPack, before(bookedAt, HOUR)) : undefined
  }
  const has = (packagesOf.get(student.id) ?? []).length > 0
  // Most regulars buy again; a few switch to paying per lesson.
  if (has && chance(0.15)) return undefined
  return buyPackage(student, chance(0.35) ? twentyPack : tenPack, before(bookedAt, HOUR))
}

function useLesson(pkg: Pkg, delta: number, kind: 'use' | 'return', bookingId: number, when: Date) {
  pkg.lessonsRemaining += delta
  db.update(packages)
    .set({ lessonsRemaining: pkg.lessonsRemaining })
    .where(eq(packages.id, pkg.id))
    .run()
  db.insert(packageLedger)
    .values({
      packageId: pkg.id,
      delta,
      kind,
      bookingId,
      actor: kind === 'use' ? 'student' : 'system',
      createdAt: when,
    })
    .run()
}

// Bookings ---------------------------------------------------------------------------------------

const feedbackTexts = [
  '今天正手连续性比上次好，重心再压低一点，击球点保持在身体右前方。',
  '反手拨球稳定了，下节课开始练反手拧拉。回家可以对墙练习手腕发力。',
  '发球旋转变化不错，接发球判断还要加强，下次重点练搓接和挑打。',
  '步法移动有进步，侧身后回位慢了点，注意还原到中间位置。',
  '多球训练完成得很好，体能也跟上了。下周可以加一些相持对练。',
  '握拍有点紧，放松手腕才能拉出转。今天的发力动作已经基本正确。',
  '第一次接触弧圈球，动作框架已经有了，需要多练找感觉。',
  '比赛意识在提高，前三板能主动上手了。注意变线，不要老打一个落点。',
  '今天状态一般，后半节明显累了。建议课前吃点东西，提前到场热身。',
  '推挡已经很稳，可以开始学习正手攻球的完整动作。',
]
const coachNotes = [
  '膝盖有旧伤，避免大范围跑动',
  '家长希望多练比赛',
  '准备参加区里比赛',
  '基础扎实，可加强度',
  '',
]
let feedbackRows = 0

function addBooking(o: {
  slot: Slot
  student: StudentInfo
  lessonType: typeof trial
  seat: number
  coach: CoachInfo
}) {
  const { slot, student, lessonType, coach } = o
  const date = venueDateKey(slot.startsAt)
  const lead = (lessonType.id === kids.id ? int(1, 6) : int(0, 6)) * DAY + int(2, 20) * HOUR
  const bookedAt = new Date(
    Math.max(
      student.joined.getTime() + HOUR,
      Math.min(slot.startsAt.getTime() - 3 * HOUR, slot.startsAt.getTime() - lead),
    ),
  )
  // Lessons further ahead than the usual lead were booked over the past week, not all today.
  const createdAt =
    bookedAt <= now
      ? bookedAt
      : new Date(Math.max(student.joined.getTime() + HOUR, now.getTime() - rand() * 7 * DAY))
  const byDesk = student.desk || chance(0.07)
  const listPrice = lessonType.id === privateLesson.id ? priceFor(coach) : lessonType.price
  const pkg = lessonType.isTrial ? undefined : packageFor(student, lessonType.id, coach, createdAt)

  // Cancellations: early ones are refunded or return the lesson, late ones are kept.
  const roll = rand()
  let status: Booking['status'] = 'confirmed'
  let cancelledBy: 'student' | 'venue' | null = null
  let late = false
  if (roll < 0.06) {
    status = 'cancelled'
    cancelledBy = 'student'
  } else if (roll < 0.075) {
    status = 'cancelled'
    cancelledBy = 'student'
    late = true
  } else if (roll < 0.08 && slot.lessonTypeId === null) {
    status = 'cancelled'
    cancelledBy = 'venue'
  }
  const cancelledAt =
    status === 'cancelled'
      ? earliest(
          late
            ? before(slot.startsAt, int(1, 20) * HOUR)
            : new Date(
                createdAt.getTime() +
                  rand() * Math.max(0, slot.startsAt.getTime() - 25 * HOUR - createdAt.getTime()),
              ),
          now,
        )
      : null
  if (cancelledAt && cancelledAt < createdAt) {
    status = 'confirmed'
    cancelledBy = null
    late = false
  }

  let attendance: 'attended' | 'no_show' | null = null
  let attendanceBy: 'student' | 'coach' | 'staff' | null = null
  let attendanceAt: Date | null = null
  if (status === 'confirmed' && slot.startsAt <= now) {
    const ageDays = (now.getTime() - slot.startsAt.getTime()) / DAY
    const marked = ageDays > 2 ? chance(0.985) : ageDays > 0.5 ? chance(0.7) : chance(0.45)
    if (marked) {
      attendance = chance(0.05) ? 'no_show' : 'attended'
      attendanceBy =
        attendance === 'no_show'
          ? pick(['coach', 'staff'] as const)
          : pick(['student', 'student', 'coach', 'staff'] as const)
      attendanceAt =
        attendanceBy === 'coach' || attendance === 'no_show'
          ? after(slot.endsAt, int(1, 40) * MINUTE)
          : before(slot.startsAt, int(3, 20) * MINUTE)
      if (attendanceAt > now) attendanceAt = now
    }
  }

  const row = db
    .insert(bookings)
    .values({
      slotId: slot.id,
      studentId: student.id,
      lessonTypeId: lessonType.id,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      status,
      seat: o.seat,
      paidWith: pkg ? 'package' : 'order',
      price: pkg ? 0 : listPrice,
      packageId: pkg?.id ?? null,
      cancelledAt,
      cancelledBy,
      cancelReason: cancelledBy === 'venue' ? '教练临时有事' : null,
      late,
      attendance,
      attendanceAt,
      attendanceBy,
      attendanceStaffId: attendanceBy === 'staff' ? pick(deskStaff).id : null,
      coachNote: chance(0.08) ? pick(coachNotes) : '',
      coachToldBookedAt: createdAt,
      coachToldCancelledAt: cancelledAt,
      coachToldCoachId: coach.id,
      coachToldStartsAt: slot.startsAt,
      coachToldEndsAt: slot.endsAt,
      bookedByStaffId: byDesk ? pick(deskStaff).id : null,
      createdAt,
    })
    .returning()
    .get()
  bookingRows.push(row)
  student.bookedDays.add(date)
  if (lessonType.isTrial) student.hadTrial = true

  if (pkg) {
    useLesson(pkg, -1, 'use', row.id, createdAt)
    if (cancelledAt && !late) useLesson(pkg, 1, 'return', row.id, cancelledAt)
  } else {
    const order = addOrder({
      student,
      kind: lessonType.isTrial ? 'trial' : 'class',
      description: lessonType.name,
      amount: listPrice,
      paidAt: earliest(after(createdAt, int(20, 120) * 1000), now),
      bookingId: row.id,
    })
    orderOfBooking.set(row.id, order)
    if (cancelledAt && !late) {
      db.insert(refunds)
        .values({
          outRefundNo: newOutRefundNo(cancelledAt),
          orderId: order.id,
          amount: listPrice,
          reason: cancelledBy === 'venue' ? '场馆取消' : '学员取消',
          status: 'succeeded',
          bookingId: row.id,
          providerRefundId: order.provider === 'wechat' ? `5030${cancelledAt.getTime()}` : null,
          createdAt: cancelledAt,
          updatedAt: earliest(after(cancelledAt, int(1, 30) * MINUTE), now),
        })
        .run()
    }
  }
  if (cancelledBy === 'venue') {
    db.insert(studentNotices)
      .values({
        bookingId: row.id,
        kind: 'cancelled',
        createdAt: cancelledAt ?? now,
        doneAt: cancelledAt ?? now,
        result: 'sent',
      })
      .run()
  }
  if (status === 'confirmed' && slot.startsAt > now) {
    db.insert(studentNotices)
      .values({ bookingId: row.id, kind: 'booked', createdAt, doneAt: createdAt, result: 'sent' })
      .run()
  }
  if (
    attendance === 'attended' &&
    slot.lessonTypeId === null &&
    !lessonType.isTrial &&
    chance(0.4)
  ) {
    const written = earliest(after(slot.endsAt, int(10, 300) * MINUTE), now)
    db.insert(lessonFeedback)
      .values({
        bookingId: row.id,
        text: pick(feedbackTexts),
        createdAt: written,
        updatedAt: written,
      })
      .run()
    feedbackRows++
  }
  return row
}

// Busy evenings and weekends; demand grows over the months as the venue gets known.
function demand(date: string, hour: number) {
  const wd = weekday(date)
  const weekendDay = wd === 0 || wd === 6
  const time = weekendDay
    ? hour >= 9 && hour < 18
      ? 0.75
      : 0.5
    : hour >= 18
      ? 0.8
      : hour >= 16
        ? 0.55
        : 0.3
  const age = (Date.parse(today) - Date.parse(date)) / DAY
  const growth = 0.75 + 0.25 * (1 - Math.max(0, age) / HISTORY_DAYS)
  // Fewer bookings the further ahead.
  const ahead = age < 0 ? Math.max(0.15, 1 + age / (AHEAD_DAYS + 2)) : 1
  return time * growth * ahead
}

const kindWeight: Record<Kind, number> = {
  regular: 6,
  casual: 1.2,
  trialOnly: 0,
  lapsed: 4,
  kid: 0,
  groupAdult: 0.3,
}

let slotCount = 0
for (let date = firstDay; date <= addVenueDays(today, AHEAD_DAYS); date = addVenueDays(date, 1)) {
  const created = daySlots(date)
  slotCount += created.length
  const dayStart = at(date, 0)
  for (const slot of created) {
    const coach = coachById.get(slot.coachId)
    if (!coach) continue
    const hour = venueParts(slot.startsAt).hours
    if (slot.lessonTypeId !== null) {
      const isKids = slot.lessonTypeId === kids.id
      const members = studentList.filter(
        (s) =>
          s.session?.coachId === coach.id &&
          s.session.day === weekday(date) &&
          s.session.hour === hour &&
          s.joined < dayStart &&
          (!s.lapseOn || date < s.lapseOn),
      )
      const ahead = demand(date, hour) / demand(today, hour)
      let seat = 0
      for (const s of members) {
        if (seat >= slot.capacity) break
        if (!chance((isKids ? 0.85 : 0.7) * Math.min(1, ahead + 0.2))) continue
        seat++
        addBooking({ slot, student: s, lessonType: isKids ? kids : adults, seat, coach })
      }
      // Past sessions had their headcount checked; the sweeper checks the coming ones.
      const checkedAt = before(slot.startsAt, 24 * HOUR)
      db.update(slots)
        .set({
          minCheckedAt: checkedAt <= now ? checkedAt : null,
          coachToldBookedAt: seat > 0 ? earliest(before(slot.startsAt, 2 * DAY), now) : null,
        })
        .where(eq(slots.id, slot.id))
        .run()
      continue
    }
    if (!chance(demand(date, hour))) continue
    // A new adult takes a trial with a coach who teaches it.
    if (coach.teaches.includes(trial) && chance(0.22)) {
      const newcomer = studentList.find(
        (s) =>
          !s.hadTrial &&
          s.kind !== 'kid' &&
          s.joined < before(slot.startsAt, 6 * HOUR) &&
          s.joined > before(slot.startsAt, 20 * DAY) &&
          !s.bookedDays.has(date),
      )
      if (newcomer) {
        addBooking({ slot, student: newcomer, lessonType: trial, seat: 1, coach })
        continue
      }
    }
    const student = weighted(
      studentList.filter(
        (s) =>
          s.hadTrial &&
          s.joined < before(slot.startsAt, 6 * HOUR) &&
          !s.bookedDays.has(date) &&
          (!s.lapseOn || date < s.lapseOn),
      ),
      (s) => kindWeight[s.kind] * (s.fav.id === coach.id ? 5 : 0.35),
    )
    if (!student) continue
    addBooking({ slot, student, lessonType: privateLesson, seat: 1, coach })
  }
}

// Package refunds: a few went through, two wait for the admin.
// Only packages with no lesson still to come can be refunded.
const activePackages = [...packagesOf.values()]
  .flat()
  .filter(
    (p) =>
      p.status === 'active' &&
      p.lessonsRemaining >= 3 &&
      p.expiresAt > now &&
      !bookingRows.some((b) => b.packageId === p.id && b.status === 'confirmed' && b.endsAt > now),
  )
for (const [i, pkg] of activePackages.slice(0, 6).entries()) {
  const listPrice =
    pkg.product.lessonTypeId === privateLesson.id
      ? privateLesson.price
      : pkg.product.price / pkg.lessonsPurchased
  const used = pkg.lessonsPurchased - pkg.lessonsRemaining
  const amount = Math.max(0, Math.round(pkg.pricePaid - used * listPrice))
  const requestedAt = before(now, i < 2 ? int(2, 30) * HOUR : int(5, 40) * DAY)
  const refund = db
    .insert(refunds)
    .values({
      outRefundNo: newOutRefundNo(requestedAt),
      orderId: pkg.orderId,
      amount: amount || 1,
      reason: pick(['课时包退款', '搬家了，离球馆太远', '工作调动，没时间上课']),
      status: i < 2 ? 'requested' : 'succeeded',
      packageId: pkg.id,
      createdAt: requestedAt,
      updatedAt: i < 2 ? requestedAt : after(requestedAt, DAY),
    })
    .returning()
    .get()
  if (i < 2) {
    db.update(packages).set({ status: 'refund_requested' }).where(eq(packages.id, pkg.id)).run()
  } else {
    db.insert(packageLedger)
      .values({
        packageId: pkg.id,
        delta: -pkg.lessonsRemaining,
        kind: 'refund',
        actor: 'admin',
        createdAt: refund.updatedAt,
      })
      .run()
    db.update(packages)
      .set({ status: 'refunded', lessonsRemaining: 0 })
      .where(eq(packages.id, pkg.id))
      .run()
    db.insert(actionLog)
      .values({
        staffId: finance.id,
        action: 'approve_refund',
        summary: `同意课时包退款：${pkg.name}`,
        amount: refund.amount,
        studentId: pkg.studentId,
        targetKind: 'refund',
        targetId: refund.id,
        createdAt: refund.updatedAt,
      })
      .run()
  }
  pkg.status = i < 2 ? 'refund_requested' : 'refunded'
}

// A couple of lessons given as goodwill.
for (const pkg of activePackages.slice(6, 9)) {
  const when = before(now, int(3, 60) * DAY)
  db.insert(packageLedger)
    .values({
      packageId: pkg.id,
      delta: 1,
      kind: 'grant',
      note: '场馆赠送',
      actor: 'admin',
      createdAt: when,
    })
    .run()
  db.update(packages)
    .set({ lessonsRemaining: pkg.lessonsRemaining + 1 })
    .where(eq(packages.id, pkg.id))
    .run()
  db.insert(actionLog)
    .values({
      staffId: admin.id,
      action: 'grant_lessons',
      summary: `赠送 1 节课时：${pkg.name}`,
      studentId: pkg.studentId,
      targetKind: 'package',
      targetId: pkg.id,
      createdAt: when,
    })
    .run()
}

// 发票 on package orders: most issued, a few waiting, one rejected.
const invoiceDir = join(config.uploadsDir, 'invoices')
mkdirSync(invoiceDir, { recursive: true })
const pdf = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
)
const packageOrders = db
  .select()
  .from(orders)
  .where(eq(orders.kind, 'package'))
  .all()
  .filter((o) => !activePackages.slice(0, 6).some((p) => p.orderId === o.id))
const companies = ['北京智联科技有限公司', '中关村软件园管理有限公司', '海淀区星辰教育咨询中心']
let invoiceCount = 0
for (const [i, order] of packageOrders.filter((_, i) => i % 4 === 0).entries()) {
  const student = studentList.find((s) => s.id === order.studentId)
  const name =
    db.select({ name: students.name }).from(students).where(eq(students.id, order.studentId)).get()
      ?.name ?? ''
  if (!student || !order.paidAt) continue
  const company = chance(0.35)
  const createdAt = earliest(after(order.paidAt, int(1, 72) * HOUR), now)
  const status = i < 4 ? 'requested' : i === 4 ? 'rejected' : 'issued'
  const file = status === 'issued' ? `demo-invoice-${order.id}.pdf` : null
  if (file) writeFileSync(join(invoiceDir, file), pdf)
  db.insert(invoices)
    .values({
      studentId: order.studentId,
      orderId: order.id,
      status,
      titleKind: company ? 'company' : 'personal',
      title: company ? pick(companies) : name,
      taxNumber: company ? `91110108MA0${int(1000000, 9999999)}X` : '',
      email: `demo${order.studentId}@example.com`,
      amount: order.amount,
      rejectReason: status === 'rejected' ? '税号有误，请核对后重新申请' : null,
      pdfFile: file,
      issuedAt: status === 'issued' ? earliest(after(createdAt, int(1, 5) * DAY), now) : null,
      handledByStaffId: status === 'requested' ? null : finance.id,
      createdAt,
    })
    .run()
  invoiceCount++
}

// 学员档案 for most students who came more than once.
const levels = ['beginner', 'elementary', 'intermediate', 'advanced'] as const
const tagPool = [
  '准备比赛',
  '周末班',
  '怕冷场',
  '左手持拍',
  '家长陪同',
  '体能好',
  '需多鼓励',
  '学过羽毛球',
]
const profileNotes = [
  '',
  '',
  '正手动作有习惯性问题，需持续纠正',
  '喜欢多球训练',
  '希望半年内能打业余比赛',
  '孩子比较内向，多表扬',
]
let profileCount = 0
for (const s of studentList) {
  if (s.bookedDays.size < 2 || !chance(0.7)) continue
  db.insert(studentProfiles)
    .values({
      studentId: s.id,
      level: s.kind === 'kid' ? pick(['beginner', 'elementary'] as const) : pick(levels),
      grip: chance(0.85) ? 'shakehand' : 'penhold',
      tags: [...new Set([pick(tagPool), ...(chance(0.4) ? [pick(tagPool)] : [])])],
      note: pick(profileNotes),
      updatedAt: before(now, int(1, 60) * DAY),
    })
    .run()
  profileCount++
}

// Banners.
mkdirSync(config.uploadsDir, { recursive: true })
const images = [
  { file: 'demo-banner-1.png', png: gradientPng([31, 79, 168], [17, 43, 92]) },
  { file: 'demo-banner-2.png', png: gradientPng([232, 98, 15], [31, 79, 168]) },
]
for (const image of images) writeFileSync(join(config.uploadsDir, image.file), image.png)
db.insert(banners)
  .values([
    {
      imageUrl: `/api/uploads/${images[0]?.file}`,
      title: '新学员体验课 ¥99',
      linkKind: 'lesson_type',
      linkId: trial.id,
      sort: 1,
    },
    {
      imageUrl: `/api/uploads/${images[1]?.file}`,
      title: '私教 20 次卡',
      linkKind: 'package',
      linkId: twentyPack.id,
      sort: 2,
    },
  ])
  .run()

const packageCount = [...packagesOf.values()].flat().length
console.log(
  `Seeded ${config.databasePath}: ${coachList.length} coaches, ${studentList.length} students, ` +
    `${slotCount} past and scheduled slots, ${bookingRows.length} bookings, ${orderCount} orders, ` +
    `${packageCount} packages, ${feedbackRows} 点评, ${invoiceCount} 发票, ${profileCount} 学员档案.`,
)
