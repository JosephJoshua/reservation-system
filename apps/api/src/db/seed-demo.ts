// Fills an empty development database with a believable venue: coaches, lessons, packages,
// two weeks of slots, banners and a notice. Refuses to touch a database that already has coaches.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { defaultSettings, venueDateKey, venueInstant } from '@rs/shared'
import { config } from '../config'
import { saveSettings } from '../services/settings'
import { openDb } from './client'
import { runMigrations } from './migrate'
import {
  banners,
  categoryPayRates,
  categoryPrices,
  coachCategories,
  coaches,
  coachLessonTypes,
  lessonTypes,
  packageProducts,
  slots,
} from './schema'

/** A 750x300 PNG with a diagonal gradient, so banners have something real to show. */
function gradientPng(from: [number, number, number], to: [number, number, number]): Buffer {
  const width = 750
  const height = 300
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1)
    for (let x = 0; x < width; x++) {
      const t = (x / width) * 0.7 + (y / height) * 0.3
      for (let c = 0; c < 3; c++) {
        raw[row + 1 + x * 3 + c] = Math.round((from[c] ?? 0) + ((to[c] ?? 0) - (from[c] ?? 0)) * t)
      }
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const db = openDb(config.databasePath)
runMigrations(db)
if (db.select().from(coaches).get()) {
  console.error('This database already has coaches; seed an empty database instead.')
  process.exit(1)
}

const now = new Date()
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
    notice: { text: '国庆假期正常营业，欢迎预约', endsAt: null },
    policies: {
      booking:
        '1. 请提前 10 分钟到场热身。\n2. 开课前 24 小时以上可免费取消；之后再取消，则不退费用和课时。\n3. 迟到不顺延下课时间。',
      agreement:
        '本协议是你与飞羽乒乓球馆之间关于使用预约服务的约定。\n\n1. 课时包仅限本人使用，不可转让。\n2. 课时包到期后剩余课时失效。\n3. 退款按实付金额扣除已上课时的单节原价计算。',
    },
  },
  now,
)

const [head, senior] = db
  .insert(coachCategories)
  .values([
    { name: '主教练', sort: 0 },
    { name: '高级教练', sort: 1 },
  ])
  .returning()
  .all()
if (!head || !senior) throw new Error('category insert failed')

const [wang, li, zhao] = db
  .insert(coaches)
  .values([
    {
      name: '王磊',
      categoryId: head.id,
      title: '国家二级运动员',
      tags: ['弧圈球', '步法', '比赛备战'],
      profile:
        '<h3>执教经历</h3><p>执教 8 年，曾任市青少年队教练，带出多名省级比赛前八的学员。</p><h3>比赛成绩</h3><ul><li><p>2014 年全国乒乓球锦标赛（业余组）男单第三名</p></li><li><p>2016 年省运会男团冠军</p></li></ul><h3>教学风格</h3><p>重视基本功和步法，<strong>每节课都有针对性的多球训练</strong>，适合想参加比赛的学员。</p><img src="/api/uploads/demo-coach-1.png" />',
      sort: 1,
    },
    {
      name: '李静',
      categoryId: senior.id,
      title: '省队退役运动员',
      tags: ['零基础', '青少年'],
      profile:
        '<p>耐心细致，擅长从握拍和站位教起，适合零基础成人和 6 岁以上的孩子。</p><ul><li><p>前省队队员，退役后执教 5 年</p></li><li><p>国家二级社会体育指导员</p></li></ul>',
      sort: 2,
    },
    {
      name: '赵鹏',
      categoryId: senior.id,
      title: '前市队主力',
      tags: ['发球', '接发球'],
      profile: '<p>专注发球与接发球技术，帮你在比赛中抢到前三板的主动。</p>',
      sort: 3,
    },
  ])
  .returning()
  .all()
if (!wang || !li || !zhao) throw new Error('coach insert failed')

const [private1, trial, kids] = db
  .insert(lessonTypes)
  .values([
    {
      name: '一对一私教',
      description: '按你的水平定制训练，含多球和对练',
      durationMinutes: 60,
      price: 30000,
      sort: 1,
    },
    {
      name: '体验课',
      description: '首次来馆专享，教练评估你的水平',
      durationMinutes: 60,
      price: 4900,
      isTrial: true,
      sort: 0,
    },
    {
      name: '少儿小班课',
      description: '6-12 岁，基本功和步法',
      durationMinutes: 90,
      price: 12000,
      capacity: 6,
      minStudents: 3,
      sort: 2,
    },
  ])
  .returning()
  .all()
if (!private1 || !trial || !kids) throw new Error('lesson type insert failed')

db.insert(categoryPrices)
  .values({ categoryId: head.id, lessonTypeId: private1.id, price: 36000 })
  .run()

db.insert(categoryPayRates)
  .values([
    { categoryId: head.id, lessonTypeId: private1.id, rate: 15000 },
    { categoryId: senior.id, lessonTypeId: private1.id, rate: 10000 },
    { categoryId: senior.id, lessonTypeId: trial.id, rate: 3000 },
  ])
  .run()

db.insert(coachLessonTypes)
  .values([
    { coachId: wang.id, lessonTypeId: private1.id },
    { coachId: li.id, lessonTypeId: private1.id },
    { coachId: zhao.id, lessonTypeId: private1.id },
    { coachId: li.id, lessonTypeId: trial.id },
    { coachId: li.id, lessonTypeId: kids.id },
    { coachId: zhao.id, lessonTypeId: trial.id },
  ])
  .run()

const saleEnds = venueInstant(venueDateKey(new Date(now.getTime() + 30 * 86400000)), 0)
const [tenPack] = db
  .insert(packageProducts)
  .values([
    {
      name: '私教 10 次卡',
      description: '适合每周练一到两次',
      lessonTypeId: private1.id,
      coachIds: [li.id, zhao.id],
      lessonCount: 10,
      price: 280000,
      salePrice: 260000,
      saleStartsAt: now,
      saleEndsAt: saleEnds,
      validityDays: 180,
      sort: 1,
    },
    {
      name: '私教 20 次卡',
      description: '适合系统提升，单节最划算',
      lessonTypeId: private1.id,
      coachIds: [],
      lessonCount: 20,
      price: 480000,
      validityDays: 365,
      sort: 2,
    },
    {
      name: '少儿小班课 10 次卡',
      description: '只用于少儿小班课',
      lessonTypeId: kids.id,
      coachIds: [],
      lessonCount: 10,
      price: 100000,
      validityDays: 180,
      sort: 3,
    },
  ])
  .returning()
  .all()
if (!tenPack) throw new Error('package insert failed')

// Hourly slots 09:00-21:00 for every coach, from today through two weeks out. Zhao starts
// tomorrow, so QA can check that picking him skips ahead to his first open day.
const today = venueDateKey(now)
const zhaoId = zhao.id
const rows: (typeof slots.$inferInsert)[] = []
for (let day = 0; day <= 14; day++) {
  const date = venueDateKey(new Date(Date.parse(`${today}T12:00:00Z`) + day * 86400000))
  const weekend = [0, 6].includes(venueInstant(date, 12 * 60).getUTCDay())
  for (const coach of [wang, li, zhao]) {
    if (coach.id === zhaoId && day === 0) continue
    for (let hour = 9; hour < 21; hour++) {
      // Li teaches the kids' group class 09:00-10:30 at weekends.
      if (weekend && coach.id === li.id && hour < 11) continue
      // Leave each coach a couple of gaps so the grid looks like a real week.
      if ((hour + coach.id + day) % 5 === 0) continue
      const startsAt = venueInstant(date, hour * 60)
      if (startsAt <= now) continue
      rows.push({
        coachId: coach.id,
        startsAt,
        endsAt: venueInstant(date, hour * 60 + 60),
      })
    }
  }
}
for (let day = 0; day <= 14; day++) {
  const date = venueDateKey(new Date(Date.parse(`${today}T12:00:00Z`) + day * 86400000))
  if (![0, 6].includes(venueInstant(date, 12 * 60).getUTCDay())) continue
  const startsAt = venueInstant(date, 9 * 60)
  if (startsAt <= now) continue
  rows.push({
    coachId: li.id,
    startsAt,
    endsAt: venueInstant(date, 10 * 60 + 30),
    lessonTypeId: kids.id,
    capacity: 6,
  })
}
db.insert(slots).values(rows).run()

mkdirSync(config.uploadsDir, { recursive: true })
const images = [
  { file: 'demo-banner-1.png', png: gradientPng([31, 79, 168], [17, 43, 92]) },
  { file: 'demo-banner-2.png', png: gradientPng([232, 98, 15], [31, 79, 168]) },
  { file: 'demo-coach-1.png', png: gradientPng([17, 43, 92], [232, 98, 15]) },
]
for (const image of images) writeFileSync(join(config.uploadsDir, image.file), image.png)
db.insert(banners)
  .values([
    {
      imageUrl: `/api/uploads/${images[0]?.file}`,
      title: '新学员体验课 ¥49',
      linkKind: 'lesson_type',
      linkId: trial.id,
      sort: 1,
    },
    {
      imageUrl: `/api/uploads/${images[1]?.file}`,
      title: '私教 10 次卡限时优惠',
      linkKind: 'package',
      linkId: tenPack.id,
      sort: 2,
    },
  ])
  .run()

console.log(
  `Seeded ${config.databasePath}: 3 coaches, 2 lesson types, 2 packages, ${rows.length} slots.`,
)
