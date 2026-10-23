import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  offlineMethodLabels,
  offlineMethods,
  staffActions,
  venueParts,
  venueSettings,
} from '@rs/shared'
import { and, asc, desc, eq, gt, gte, inArray, like, lt, lte, or, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { immediate, type Q } from '../db/client'
import {
  banners,
  bookings,
  categoryPrices,
  coachCategories,
  coaches,
  coachLessonTypes,
  lessonTypes,
  orders,
  packageLedger,
  packageProducts,
  packages,
  refunds,
  slots,
  staff,
  students,
} from '../db/schema'
import type { Deps } from '../deps'
import { ApiError, checkVersion, idParam, notFound, parseBody, parseQuery } from '../errors'
import { describeBooking, listActions, logAction, venueMoment, yuan } from '../services/action-log'
import { accountDeleted } from '../services/account'
import {
  type AdminVars,
  bearer,
  limitedCheck,
  loginAdmin,
  logout,
  requireAdmin,
} from '../services/auth'
import { cancelBooking, LIVE } from '../services/bookings'
import { hoursView, newBindCode, saveHours, setDayOff, unbindCoach } from '../services/coaches'
import { bookForStudent, frontDeskQuote } from '../services/front-desk'
import { setAttendance } from '../services/lessons'
import {
  approvePackageRefund,
  extendPackage,
  grantLessons,
  rejectPackageRefund,
  sellPackageOffline,
} from '../services/packages'
import { markOfflineRefundPaid, retryRefund } from '../services/refunds'
import { monthlyReport } from '../services/reports'
import { cleanRichText } from '../services/rich-text'
import { getSettings, saveSettings } from '../services/settings'
import {
  createStaff,
  findStaff,
  setStaffPassword,
  staffView,
  updateStaff,
  verifyPassword,
} from '../services/staff'
import { bookingStatus, bookingViews, packageViews } from '../services/views'
import { weeklyHoursBody } from './coach'

const instant = z.iso.datetime({ offset: true }).transform((s) => new Date(s))
const nullableInstant = instant.nullable()
const fen = z.number().int().min(0).max(10_000_000)
const MAX_SLOTS_PER_REQUEST = 500
// Refinements, so the client shows these messages rather than a generic field error.
const password = z
  .string()
  .refine((v) => v.length >= 8 && v.length <= 100, { message: '密码需为 8 到 100 位' })
const username = z
  .string()
  .trim()
  .toLowerCase()
  .refine((v) => /^[a-z0-9_.-]{3,20}$/.test(v), {
    message: '登录名需为 3 到 20 位字母、数字或 _ . -',
  })
const staffName = z.string().trim().min(1).max(20)
const offlineMethod = z.enum(offlineMethods)
const settingsSectionLabel = {
  venue: '场馆信息',
  booking: '预约规则',
  payment: '支付',
  notice: '公告',
  policies: '须知与协议',
} as const

/** A price and its sale, if any, as one line for the action log. */
function priceLine(price: number, sale: string | null, startsAt: Date | null, endsAt: Date | null) {
  if (!sale || !startsAt || !endsAt) return yuan(price)
  return `${yuan(price)}，${sale}（${venueMoment(startsAt)} 至 ${venueMoment(endsAt)}）`
}

const coachBody = z.object({
  name: z.string().trim().min(1).max(20),
  categoryId: z.number().int().positive().nullable().default(null),
  title: z.string().trim().max(30).default(''),
  tags: z.array(z.string().trim().min(1).max(10)).max(6).default([]),
  profile: z.string().max(50_000).transform(cleanRichText).default(''),
  avatarUrl: z.string().max(300).default(''),
  active: z.boolean().default(true),
  sort: z.number().int().default(0),
  /** Lesson types this coach teaches. */
  lessonTypeIds: z.array(z.number().int().positive()).max(100).default([]),
})

const categoryBody = z.object({
  name: z.string().trim().min(1).max(10),
  sort: z.number().int().default(0),
  /** Prices for some lesson types; the rest use the lesson type's own price. */
  prices: z
    .array(z.object({ lessonTypeId: z.number().int().positive(), price: fen }))
    .max(100)
    .default([]),
})

const lessonTypeBody = z
  .object({
    name: z.string().trim().min(1).max(30),
    description: z.string().trim().max(500).default(''),
    durationMinutes: z.number().int().min(15).max(480),
    price: fen,
    isTrial: z.boolean().default(false),
    adminOnly: z.boolean().default(false),
    active: z.boolean().default(true),
    salePercent: z.number().int().min(1).max(99).nullable().default(null),
    saleStartsAt: nullableInstant.default(null),
    saleEndsAt: nullableInstant.default(null),
    sort: z.number().int().default(0),
  })
  .refine((v) => saleDatesValid(v.salePercent, v.saleStartsAt, v.saleEndsAt), {
    message: '折扣需要设置开始和结束时间',
  })

const productBody = z
  .object({
    name: z.string().trim().min(1).max(30),
    description: z.string().trim().max(500).default(''),
    lessonTypeId: z.number().int().positive(),
    coachIds: z.array(z.number().int().positive()).max(50).default([]),
    lessonCount: z.number().int().min(1).max(200),
    price: fen.min(1),
    validityDays: z.number().int().min(1).max(3650),
    onSale: z.boolean().default(true),
    salePrice: fen.min(1).nullable().default(null),
    saleStartsAt: nullableInstant.default(null),
    saleEndsAt: nullableInstant.default(null),
    sort: z.number().int().default(0),
  })
  .refine((v) => saleDatesValid(v.salePrice, v.saleStartsAt, v.saleEndsAt), {
    message: '限时价需要设置开始和结束时间',
  })

const bannerBody = z
  .object({
    imageUrl: z.string().min(1).max(300),
    title: z.string().trim().max(30).default(''),
    linkKind: z.enum(['none', 'package', 'lesson_type']).default('none'),
    linkId: z.number().int().positive().nullable().default(null),
    startsAt: nullableInstant.default(null),
    endsAt: nullableInstant.default(null),
    active: z.boolean().default(true),
    sort: z.number().int().default(0),
  })
  .refine((v) => (v.linkKind === 'none') === (v.linkId === null), { message: '请选择跳转目标' })
  .refine((v) => !v.startsAt || !v.endsAt || v.startsAt < v.endsAt, {
    message: '结束时间需晚于开始时间',
  })

function saleDatesValid(value: number | null, startsAt: Date | null, endsAt: Date | null) {
  if (value === null) return true
  return startsAt !== null && endsAt !== null && startsAt < endsAt
}

export function adminRoutes(deps: Deps) {
  const { db } = deps
  const app = new Hono<AdminVars>()

  app.post('/login', async (c) => {
    const body = await parseBody(
      c,
      z.object({
        username: z.string().trim().toLowerCase().max(40),
        password: z.string().max(200),
      }),
    )
    // Behind the reverse proxy, the last X-Forwarded-For entry is the address it saw.
    const client = c.req.header('X-Forwarded-For')?.split(',').pop()?.trim() || 'direct'
    return c.json(loginAdmin(deps, body.username, body.password, client))
  })

  app.use('*', async (c, next) => {
    if (c.req.path.endsWith('/admin/login')) return next()
    return requireAdmin(deps)(c, next)
  })

  app.post('/logout', (c) => {
    logout(deps, c.req.header('Authorization'))
    return c.body(null, 204)
  })

  /**
   * Records an action by the signed-in staff member, after the change itself has committed. A
   * failed write is reported rather than thrown: the change is done, and an error would invite a
   * retry that repeats it.
   */
  const log = (staffId: number, entry: Parameters<typeof logAction>[3]) => {
    try {
      logAction(db, deps.now(), staffId, entry)
    } catch (e) {
      deps.log('action log write failed', { staffId, entry, error: String(e) })
    }
  }
  const ownToken = (c: { req: { header: (name: string) => string | undefined } }) =>
    bearer(c.req.header('Authorization'))

  // Staff logins and the action log

  app.get('/me', (c) => c.json(staffView(findStaff(db, c.get('staffId')))))

  app.put('/me/password', async (c) => {
    const body = await parseBody(c, z.object({ current: z.string().max(200), password }))
    const me = findStaff(db, c.get('staffId'))
    // Limited like logins, so a session left open cannot guess its way to the password.
    limitedCheck(
      deps,
      `password:${me.id}`,
      () => verifyPassword(body.current, me.passwordHash),
      new ApiError(403, 'bad_password', '当前密码不对'),
    )
    // Sessions on other devices end; this one stays.
    setStaffPassword(deps, me.id, body.password, ownToken(c))
    log(me.id, {
      action: 'staff.password',
      summary: '修改自己的密码',
      target: { kind: 'staff', id: me.id },
    })
    return c.body(null, 204)
  })

  app.get('/staff', (c) =>
    c.json(db.select().from(staff).orderBy(desc(staff.active), asc(staff.id)).all().map(staffView)),
  )

  app.post('/staff', async (c) => {
    const body = await parseBody(c, z.object({ name: staffName, username, password }))
    const row = createStaff(deps, body)
    log(c.get('staffId'), {
      action: 'staff.create',
      summary: `新增员工 ${row.name}（${row.username}）`,
      target: { kind: 'staff', id: row.id },
    })
    return c.json(staffView(row), 201)
  })

  app.patch('/staff/:id', async (c) => {
    const body = await parseBody(
      c,
      z
        .object({ name: staffName.optional(), active: z.boolean().optional() })
        .refine((b) => Object.keys(b).length > 0, { message: '没有要修改的内容' }),
    )
    const { before, after } = updateStaff(deps, c.get('staffId'), idParam(c), body)
    const changes = [
      before.name !== after.name && `姓名改为 ${after.name}`,
      before.active !== after.active && (after.active ? '启用账号' : '停用账号'),
    ].filter(Boolean)
    if (changes.length) {
      log(c.get('staffId'), {
        action: 'staff.update',
        summary: `${before.name}（${after.username}）${changes.join('，')}`,
        target: { kind: 'staff', id: after.id },
      })
    }
    return c.json(staffView(after))
  })

  app.put('/staff/:id/password', async (c) => {
    const body = await parseBody(c, z.object({ password }))
    const target = findStaff(db, idParam(c))
    // Your own password needs the current one, so a session left open cannot take the account.
    if (target.id === c.get('staffId')) {
      throw new ApiError(409, 'own_password', '修改自己的密码请用“修改我的密码”')
    }
    setStaffPassword(deps, target.id, body.password)
    log(c.get('staffId'), {
      action: 'staff.password',
      summary: `重置 ${target.name}（${target.username}）的密码`,
      target: { kind: 'staff', id: target.id },
    })
    return c.body(null, 204)
  })

  app.get('/actions', (c) => {
    const q = parseQuery(
      c,
      z.object({
        staffId: z.coerce.number().int().positive().optional(),
        studentId: z.coerce.number().int().positive().optional(),
        // Comma separated.
        actions: z
          .string()
          .optional()
          .transform((v) => (v ? v.split(',') : undefined))
          .pipe(z.array(z.enum(staffActions)).optional()),
        from: instant.optional(),
        to: instant.optional(),
        before: z.coerce.number().int().positive().optional(),
      }),
    )
    return c.json(listActions(db, q))
  })

  // Settings

  app.get('/settings', (c) => c.json(getSettings(db)))

  app.put('/settings', async (c) => {
    const body = await parseBody(c, venueSettings)
    const { before, after } = immediate(db, (tx) => {
      const before = getSettings(tx)
      checkVersion(c, before)
      saveSettings(tx, body, deps.now())
      return { before, after: getSettings(tx) }
    })
    const changed = (Object.keys(settingsSectionLabel) as (keyof typeof settingsSectionLabel)[])
      .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
      .map((k) => settingsSectionLabel[k])
    if (changed.length) {
      log(c.get('staffId'), { action: 'settings.update', summary: `修改${changed.join('、')}` })
    }
    return c.json(after)
  })

  // Coaches

  const coachView = (id: number) => {
    const row = db.select().from(coaches).where(eq(coaches.id, id)).get()
    if (!row) throw notFound('教练')
    const lessonTypeIds = db
      .select({ id: coachLessonTypes.lessonTypeId })
      .from(coachLessonTypes)
      .where(eq(coachLessonTypes.coachId, id))
      .all()
      .map((r) => r.id)
    const { openid, bindCode, bindCodeExpiresAt, ...coach } = row
    const codeLive = bindCode && bindCodeExpiresAt && bindCodeExpiresAt > deps.now()
    return {
      ...coach,
      lessonTypeIds,
      bound: openid !== null,
      bindCode: codeLive ? bindCode : null,
      bindCodeExpiresAt: codeLive ? bindCodeExpiresAt : null,
    }
  }

  app.get('/coaches', (c) =>
    c.json(
      db
        .select({ id: coaches.id })
        .from(coaches)
        .orderBy(asc(coaches.sort), asc(coaches.id))
        .all()
        .map((r) => coachView(r.id)),
    ),
  )

  const checkLessonTypes = (tx: Q, ids: number[]) => {
    const known = new Set(
      tx
        .select({ id: lessonTypes.id })
        .from(lessonTypes)
        .all()
        .map((r) => r.id),
    )
    if (ids.some((id) => !known.has(id))) throw notFound('课程')
  }

  const saveCoach = (tx: Q, id: number | null, body: z.infer<typeof coachBody>) => {
    const { lessonTypeIds, ...fields } = body
    checkLessonTypes(tx, lessonTypeIds)
    if (
      fields.categoryId !== null &&
      !tx.select().from(coachCategories).where(eq(coachCategories.id, fields.categoryId)).get()
    ) {
      throw notFound('教练类别')
    }
    const tags = [...new Set(fields.tags)]
    let coachId = id
    if (coachId === null) {
      coachId = tx
        .insert(coaches)
        .values({ ...fields, tags })
        .returning({ id: coaches.id })
        .get().id
    } else {
      const changed = tx
        .update(coaches)
        .set({ ...fields, tags })
        .where(eq(coaches.id, coachId))
        .run()
      if (changed.changes === 0) throw notFound('教练')
    }
    tx.delete(coachLessonTypes).where(eq(coachLessonTypes.coachId, coachId)).run()
    for (const lessonTypeId of new Set(lessonTypeIds)) {
      tx.insert(coachLessonTypes).values({ coachId, lessonTypeId }).run()
    }
    return coachId
  }

  const categoryName = (id: number | null) =>
    id === null
      ? '无类别'
      : `「${db.select({ name: coachCategories.name }).from(coachCategories).where(eq(coachCategories.id, id)).get()?.name ?? `#${id}`}」`

  /** Logs a coach's category change, since the category sets the coach's prices. */
  const logCoachCategory = (
    staffId: number,
    coach: ReturnType<typeof coachView>,
    before: number | null | undefined,
  ) => {
    if (before === undefined && coach.categoryId === null) return
    if (before !== undefined && before === coach.categoryId) return
    log(staffId, {
      action: 'price.coach',
      summary:
        before === undefined
          ? `新增教练 ${coach.name}，类别${categoryName(coach.categoryId)}`
          : `${coach.name}：类别${categoryName(before)}改为${categoryName(coach.categoryId)}`,
      target: { kind: 'coach', id: coach.id },
    })
  }

  app.post('/coaches', async (c) => {
    const body = await parseBody(c, coachBody)
    const id = immediate(db, (tx) => saveCoach(tx, null, body))
    const view = coachView(id)
    logCoachCategory(c.get('staffId'), view, undefined)
    return c.json(view, 201)
  })

  app.put('/coaches/:id', async (c) => {
    const id = idParam(c)
    const body = await parseBody(c, coachBody)
    const before = immediate(db, (tx) => {
      const old = tx
        .select({ categoryId: coaches.categoryId })
        .from(coaches)
        .where(eq(coaches.id, id))
        .get()
      saveCoach(tx, id, body)
      return old?.categoryId ?? null
    })
    const view = coachView(id)
    logCoachCategory(c.get('staffId'), view, before)
    return c.json(view)
  })

  // Coach categories

  const categoryViews = () => {
    const prices = db.select().from(categoryPrices).all()
    return db
      .select()
      .from(coachCategories)
      .orderBy(asc(coachCategories.sort), asc(coachCategories.id))
      .all()
      .map((cat) => ({
        ...cat,
        prices: prices
          .filter((p) => p.categoryId === cat.id)
          .map(({ lessonTypeId, price }) => ({ lessonTypeId, price })),
      }))
  }

  const categoryView = (id: number) => {
    const view = categoryViews().find((cat) => cat.id === id)
    if (!view) throw notFound('教练类别')
    return view
  }

  const saveCategory = (tx: Q, id: number | null, body: z.infer<typeof categoryBody>) => {
    const { prices, ...fields } = body
    checkLessonTypes(
      tx,
      prices.map((p) => p.lessonTypeId),
    )
    let categoryId = id
    if (categoryId === null) {
      categoryId = tx
        .insert(coachCategories)
        .values(fields)
        .returning({ id: coachCategories.id })
        .get().id
    } else {
      const changed = tx
        .update(coachCategories)
        .set(fields)
        .where(eq(coachCategories.id, categoryId))
        .run()
      if (changed.changes === 0) throw notFound('教练类别')
    }
    tx.delete(categoryPrices).where(eq(categoryPrices.categoryId, categoryId)).run()
    const unique = new Map(prices.map((p) => [p.lessonTypeId, p.price]))
    for (const [lessonTypeId, price] of unique) {
      tx.insert(categoryPrices).values({ categoryId, lessonTypeId, price }).run()
    }
    return categoryId
  }

  app.get('/coach-categories', (c) => c.json(categoryViews()))

  /** Logs the category prices that changed, as "一对一私教 ¥200 改为 ¥250". */
  const logCategoryPrices = (
    staffId: number,
    category: ReturnType<typeof categoryView>,
    before: { lessonTypeId: number; price: number }[],
  ) => {
    const names = new Map(
      db
        .select({ id: lessonTypes.id, name: lessonTypes.name })
        .from(lessonTypes)
        .all()
        .map((t) => [t.id, t.name]),
    )
    const old = new Map(before.map((p) => [p.lessonTypeId, p.price]))
    const now = new Map(category.prices.map((p) => [p.lessonTypeId, p.price]))
    const changes = [...new Set([...old.keys(), ...now.keys()])].flatMap((id) => {
      const name = names.get(id) ?? `课程 #${id}`
      const was = old.get(id)
      const price = now.get(id)
      if (price === undefined) return [`${name} 改为按课程标价`]
      if (was === undefined) return [`${name} ${yuan(price)}`]
      return was === price ? [] : [`${name} ${yuan(was)} 改为 ${yuan(price)}`]
    })
    if (changes.length) {
      log(staffId, {
        action: 'price.coach',
        summary: `类别「${category.name}」：${changes.join('；')}`,
        target: { kind: 'category', id: category.id },
      })
    }
  }

  app.post('/coach-categories', async (c) => {
    const body = await parseBody(c, categoryBody)
    const id = immediate(db, (tx) => saveCategory(tx, null, body))
    const view = categoryView(id)
    logCategoryPrices(c.get('staffId'), view, [])
    return c.json(view, 201)
  })

  app.put('/coach-categories/:id', async (c) => {
    const id = idParam(c)
    const body = await parseBody(c, categoryBody)
    const before = immediate(db, (tx) => {
      const old = tx
        .select({ lessonTypeId: categoryPrices.lessonTypeId, price: categoryPrices.price })
        .from(categoryPrices)
        .where(eq(categoryPrices.categoryId, id))
        .all()
      saveCategory(tx, id, body)
      return old
    })
    const view = categoryView(id)
    logCategoryPrices(c.get('staffId'), view, before)
    return c.json(view)
  })

  app.delete('/coach-categories/:id', (c) => {
    const id = idParam(c)
    immediate(db, (tx) => {
      const used = tx
        .select({ id: coaches.id })
        .from(coaches)
        .where(eq(coaches.categoryId, id))
        .get()
      if (used) throw new ApiError(409, 'category_in_use', '还有教练属于该类别')
      tx.delete(categoryPrices).where(eq(categoryPrices.categoryId, id)).run()
      const changed = tx.delete(coachCategories).where(eq(coachCategories.id, id)).run()
      if (changed.changes === 0) throw notFound('教练类别')
    })
    return c.body(null, 204)
  })

  app.post('/coaches/:id/bind-code', (c) => c.json(newBindCode(deps, idParam(c)), 201))

  app.delete('/coaches/:id/binding', (c) => {
    unbindCoach(deps, idParam(c))
    return c.body(null, 204)
  })

  app.get('/coaches/:id/hours', (c) => c.json(hoursView(deps, idParam(c))))

  app.put('/coaches/:id/hours', async (c) => {
    const { hours } = await parseBody(c, weeklyHoursBody)
    return c.json(saveHours(deps, idParam(c), hours))
  })

  app.put('/coaches/:id/days-off/:date', (c) =>
    c.json(setDayOff(deps, idParam(c), c.req.param('date'), true)),
  )

  app.delete('/coaches/:id/days-off/:date', (c) =>
    c.json(setDayOff(deps, idParam(c), c.req.param('date'), false)),
  )

  // Lesson types

  app.get('/lesson-types', (c) =>
    c.json(db.select().from(lessonTypes).orderBy(asc(lessonTypes.sort), asc(lessonTypes.id)).all()),
  )

  const lessonPriceLine = (t: z.infer<typeof lessonTypeBody>) =>
    priceLine(t.price, t.salePercent ? `${t.salePercent}%` : null, t.saleStartsAt, t.saleEndsAt)

  app.post('/lesson-types', async (c) => {
    const body = await parseBody(c, lessonTypeBody)
    const row = db.insert(lessonTypes).values(body).returning().get()
    log(c.get('staffId'), {
      action: 'price.lesson_type',
      summary: `新建课程 ${row.name}，${lessonPriceLine(body)}`,
      target: { kind: 'lesson_type', id: row.id },
    })
    return c.json(row, 201)
  })

  app.put('/lesson-types/:id', async (c) => {
    const id = idParam(c)
    const body = await parseBody(c, lessonTypeBody)
    const existing = db.select().from(lessonTypes).where(eq(lessonTypes.id, id)).get()
    if (!existing) throw notFound('课程')
    const used = db
      .select({ id: bookings.id })
      .from(bookings)
      .where(eq(bookings.lessonTypeId, id))
      .get()
    if (used && body.durationMinutes !== existing.durationMinutes) {
      throw new ApiError(409, 'duration_locked', '已有预约的课程不能修改时长，请新建课程')
    }
    // Trial limits count past bookings by their lesson type, so the flag must not change under them.
    if (used && body.isTrial !== existing.isTrial) {
      throw new ApiError(409, 'trial_locked', '已有预约的课程不能更改是否为体验课，请新建课程')
    }
    if (body.isTrial && !existing.isTrial) {
      const sold = db
        .select({ id: packageProducts.id })
        .from(packageProducts)
        .where(eq(packageProducts.lessonTypeId, id))
        .get()
      if (sold) throw new ApiError(409, 'trial_has_packages', '有课时包的课程不能设为体验课')
    }
    const row = db.update(lessonTypes).set(body).where(eq(lessonTypes.id, id)).returning().get()
    const was = lessonPriceLine(existing)
    const now = lessonPriceLine(body)
    if (was !== now) {
      log(c.get('staffId'), {
        action: 'price.lesson_type',
        summary: `${body.name}：${was} 改为 ${now}`,
        target: { kind: 'lesson_type', id },
      })
    }
    return c.json(row)
  })

  // Slots

  app.get('/slots', (c) => {
    const q = parseQuery(
      c,
      z.object({
        from: instant,
        to: instant,
        coachId: z.coerce.number().int().positive().optional(),
      }),
    )
    const rows = db
      .select()
      .from(slots)
      .where(
        and(
          gte(slots.startsAt, q.from),
          lt(slots.startsAt, q.to),
          q.coachId ? eq(slots.coachId, q.coachId) : undefined,
        ),
      )
      .orderBy(asc(slots.startsAt), asc(slots.coachId))
      .limit(2000)
      .all()
    const live = rows.length
      ? db
          .select({
            slotId: bookings.slotId,
            id: bookings.id,
            status: bookings.status,
            studentId: bookings.studentId,
            attendance: bookings.attendance,
          })
          .from(bookings)
          .where(
            and(
              inArray(
                bookings.slotId,
                rows.map((r) => r.id),
              ),
              inArray(bookings.status, LIVE),
            ),
          )
          .all()
      : []
    const byStudent = new Map(
      live.length
        ? db
            .select({ id: students.id, name: students.name, phone: students.phone })
            .from(students)
            .where(
              inArray(
                students.id,
                live.map((b) => b.studentId),
              ),
            )
            .all()
            .map((s) => [s.id, s])
        : [],
    )
    const bySlot = new Map(live.map((b) => [b.slotId, b]))
    const now = deps.now()
    return c.json(
      rows.map((s) => {
        const b = bySlot.get(s.id)
        return {
          ...s,
          booking: b
            ? {
                id: b.id,
                status: bookingStatus({ status: b.status, endsAt: s.endsAt }, now),
                attendance: b.attendance,
                student: byStudent.get(b.studentId) ?? null,
              }
            : null,
        }
      }),
    )
  })

  app.post('/slots', async (c) => {
    const body = await parseBody(
      c,
      z.object({
        slots: z
          .array(
            z.object({ coachId: z.number().int().positive(), startsAt: instant, endsAt: instant }),
          )
          .min(1)
          .max(MAX_SLOTS_PER_REQUEST),
      }),
    )
    const now = deps.now()
    const created = immediate(db, (tx) => {
      const coachIds = new Set(
        tx
          .select({ id: coaches.id })
          .from(coaches)
          .all()
          .map((r) => r.id),
      )
      const ids: number[] = []
      body.slots.forEach((s) => {
        if (!coachIds.has(s.coachId)) throw notFound('教练')
        if (s.endsAt <= s.startsAt) {
          throw new ApiError(400, 'invalid_slot', '结束时间需晚于开始时间')
        }
        if (s.startsAt <= now) throw new ApiError(400, 'slot_in_past', '不能给已过去的时间排课')
        if (s.endsAt.getTime() - s.startsAt.getTime() > 8 * 3_600_000) {
          throw new ApiError(400, 'invalid_slot', '单个时段不能超过 8 小时')
        }
        // Overlaps with existing slots and with earlier slots in this request (already inserted).
        const overlap = tx
          .select({ id: slots.id })
          .from(slots)
          .where(
            and(
              eq(slots.coachId, s.coachId),
              lt(slots.startsAt, s.endsAt),
              gt(slots.endsAt, s.startsAt),
            ),
          )
          .get()
        if (overlap) {
          const t = venueParts(s.startsAt)
          const pad = (n: number) => String(n).padStart(2, '0')
          throw new ApiError(
            409,
            'slot_overlap',
            `${t.month}月${t.day}日 ${pad(t.hours)}:${pad(t.minutes)} 与该教练已有时段重叠`,
          )
        }
        ids.push(tx.insert(slots).values(s).returning({ id: slots.id }).get().id)
      })
      return ids
    })
    return c.json({ ids: created }, 201)
  })

  app.patch('/slots/:id', async (c) => {
    const { open } = await parseBody(c, z.object({ open: z.boolean() }))
    const changed = db
      .update(slots)
      .set({ open, closedBySync: false })
      .where(eq(slots.id, idParam(c)))
      .run()
    if (changed.changes === 0) throw notFound('时段')
    return c.body(null, 204)
  })

  app.delete('/slots/:id', (c) => {
    const id = idParam(c)
    immediate(db, (tx) => {
      const used = tx
        .select({ id: bookings.id })
        .from(bookings)
        .where(eq(bookings.slotId, id))
        .get()
      if (used) throw new ApiError(409, 'slot_has_bookings', '该时段有预约记录，只能关闭，不能删除')
      // Deleting it would only bring it back at the next sync.
      const generated = tx
        .select({ id: slots.id })
        .from(slots)
        .where(and(eq(slots.id, id), eq(slots.source, 'hours')))
        .get()
      if (generated) {
        throw new ApiError(
          409,
          'slot_from_hours',
          '该时段来自教练的每周时间，请关闭时段或修改每周时间',
        )
      }
      const changed = tx.delete(slots).where(eq(slots.id, id)).run()
      if (changed.changes === 0) throw notFound('时段')
    })
    return c.body(null, 204)
  })

  // Bookings

  app.get('/bookings', (c) => {
    const q = parseQuery(
      c,
      z.object({
        from: instant.optional(),
        to: instant.optional(),
        studentId: z.coerce.number().int().positive().optional(),
        coachId: z.coerce.number().int().positive().optional(),
        status: z
          .enum(['pending_payment', 'confirmed', 'completed', 'cancelled', 'expired'])
          .optional(),
        order: z.enum(['asc', 'desc']).default('asc'),
      }),
    )
    const now = deps.now()
    // A confirmed booking that has ended shows as completed, so the two filters split on endsAt.
    const status =
      q.status === 'confirmed'
        ? and(eq(bookings.status, 'confirmed'), gt(bookings.endsAt, now))
        : q.status === 'completed'
          ? and(eq(bookings.status, 'confirmed'), lte(bookings.endsAt, now))
          : q.status
            ? eq(bookings.status, q.status)
            : undefined
    const rows = db
      .select({ booking: bookings })
      .from(bookings)
      .innerJoin(slots, eq(slots.id, bookings.slotId))
      .where(
        and(
          q.from ? gte(bookings.startsAt, q.from) : undefined,
          q.to ? lt(bookings.startsAt, q.to) : undefined,
          q.studentId ? eq(bookings.studentId, q.studentId) : undefined,
          q.coachId ? eq(slots.coachId, q.coachId) : undefined,
          status,
        ),
      )
      .orderBy(
        q.order === 'asc' ? asc(bookings.startsAt) : desc(bookings.startsAt),
        asc(bookings.id),
      )
      .limit(500)
      .all()
      .map((r) => r.booking)
    const views = bookingViews(db, rows, getSettings(db).booking, now)
    const people = new Map(
      rows.length
        ? db
            .select({ id: students.id, name: students.name, phone: students.phone })
            .from(students)
            .where(
              inArray(
                students.id,
                rows.map((r) => r.studentId),
              ),
            )
            .all()
            .map((s) => [s.id, s])
        : [],
    )
    const staffIds = [
      ...new Set(rows.flatMap((r) => (r.bookedByStaffId ? [r.bookedByStaffId] : []))),
    ]
    const bookedBy = new Map(
      staffIds.length
        ? db
            .select({ id: staff.id, name: staff.name })
            .from(staff)
            .where(inArray(staff.id, staffIds))
            .all()
            .map((s) => [s.id, s])
        : [],
    )
    // Paid at the front desk, so a refund is handed back there.
    const paidOffline = new Set(
      rows.length
        ? db
            .select({ bookingId: orders.bookingId })
            .from(orders)
            .where(
              and(
                inArray(
                  orders.bookingId,
                  rows.map((r) => r.id),
                ),
                eq(orders.provider, 'offline'),
              ),
            )
            .all()
            .map((o) => o.bookingId)
        : [],
    )
    return c.json(
      views.map((v, i) => ({
        ...v,
        student: people.get(rows[i]?.studentId ?? 0) ?? null,
        coachNote: rows[i]?.coachNote ?? '',
        bookedBy: bookedBy.get(rows[i]?.bookedByStaffId ?? 0) ?? null,
        paidOffline: paidOffline.has(v.id),
      })),
    )
  })

  const frontDeskTarget = {
    studentId: z.number().int().positive(),
    slotId: z.number().int().positive(),
    lessonTypeId: z.number().int().positive(),
  }

  app.post('/bookings/quote', async (c) => {
    const body = await parseBody(c, z.object(frontDeskTarget))
    return c.json(frontDeskQuote(deps, body))
  })

  // 代约: the front desk books a lesson for a student.
  app.post('/bookings', async (c) => {
    const body = await parseBody(
      c,
      z.discriminatedUnion('payWith', [
        z.object({ ...frontDeskTarget, payWith: z.literal('package') }),
        z.object({
          ...frontDeskTarget,
          payWith: z.literal('offline'),
          amount: fen,
          method: offlineMethod.optional(),
          note: z.string().trim().max(100).default(''),
        }),
      ]),
    )
    return c.json(bookForStudent(deps, c.get('staffId'), body), 201)
  })

  app.put('/bookings/:id/attendance', async (c) => {
    const { attendance } = await parseBody(
      c,
      z.object({ attendance: z.enum(['attended', 'no_show']).nullable() }),
    )
    const id = idParam(c)
    const before = db
      .select({ attendance: bookings.attendance })
      .from(bookings)
      .where(eq(bookings.id, id))
      .get()
    setAttendance(deps, id, attendance, 'admin')
    if (before && before.attendance !== attendance) {
      const { what, studentId } = describeBooking(db, id)
      const label = { attended: '到课', no_show: '缺席' }
      log(c.get('staffId'), {
        action: 'booking.attendance',
        summary: `${what}：${attendance ? `记为${label[attendance]}` : '清除签到'}`,
        studentId,
        target: { kind: 'booking', id },
      })
    }
    return c.body(null, 204)
  })

  app.post('/bookings/:id/cancel', async (c) => {
    const { reason } = await parseBody(c, z.object({ reason: z.string().trim().min(1).max(100) }))
    const id = idParam(c)
    const cancelled = await cancelBooking(deps, id, 'venue', { reason })
    const booking = db.select().from(bookings).where(eq(bookings.id, id)).get()
    // A repeat cancelled nothing, and a payment that landed meanwhile may have expired the
    // booking instead.
    if (!cancelled || booking?.status !== 'cancelled' || booking.cancelledBy !== 'venue') {
      return c.body(null, 204)
    }
    const { what, studentId } = describeBooking(db, id)
    const refund = db
      .select({ amount: refunds.amount, provider: orders.provider })
      .from(refunds)
      .innerJoin(orders, eq(orders.id, refunds.orderId))
      .where(eq(refunds.bookingId, id))
      .orderBy(desc(refunds.id))
      .get()
    const returned = db
      .select({ id: packageLedger.id })
      .from(packageLedger)
      .where(and(eq(packageLedger.bookingId, id), eq(packageLedger.kind, 'return')))
      .get()
    // An unpaid hold was simply released.
    const outcome = refund
      ? `，${refund.provider === 'offline' ? '待线下退还' : '退款'} ${yuan(refund.amount)}`
      : returned
        ? '，退回课时 1 节'
        : ''
    log(c.get('staffId'), {
      action: 'booking.cancel',
      summary: `${what}，原因：${reason}${outcome}`,
      amount: refund?.amount ?? null,
      studentId,
      target: { kind: 'booking', id },
    })
    return c.body(null, 204)
  })

  // Package products

  app.get('/package-products', (c) =>
    c.json(
      db
        .select()
        .from(packageProducts)
        .orderBy(asc(packageProducts.sort), asc(packageProducts.id))
        .all(),
    ),
  )

  const checkProduct = (body: z.infer<typeof productBody>) => {
    const lessonType = db
      .select()
      .from(lessonTypes)
      .where(eq(lessonTypes.id, body.lessonTypeId))
      .get()
    if (!lessonType) throw notFound('课程')
    if (lessonType.isTrial) throw new ApiError(409, 'trial_package', '体验课不能做成课时包')
    if (body.salePrice !== null && body.salePrice >= body.price) {
      throw new ApiError(400, 'invalid_sale', '优惠价需低于原价')
    }
  }

  const productPriceLine = (p: z.infer<typeof productBody>) =>
    priceLine(
      p.price,
      p.salePrice === null ? null : `限时价 ${yuan(p.salePrice)}`,
      p.saleStartsAt,
      p.saleEndsAt,
    )

  app.post('/package-products', async (c) => {
    const body = await parseBody(c, productBody)
    checkProduct(body)
    const row = db.insert(packageProducts).values(body).returning().get()
    log(c.get('staffId'), {
      action: 'price.product',
      summary: `新建课时包 ${row.name}，${productPriceLine(body)}`,
      target: { kind: 'product', id: row.id },
    })
    return c.json(row, 201)
  })

  app.put('/package-products/:id', async (c) => {
    const id = idParam(c)
    const body = await parseBody(c, productBody)
    checkProduct(body)
    // A package is created from the product when its payment lands, so its terms cannot change
    // while someone is paying for it. Price and sale edits are fine: the order already has its amount.
    const existing = db.select().from(packageProducts).where(eq(packageProducts.id, id)).get()
    if (!existing) throw notFound('课时包')
    const termsChanged =
      body.lessonTypeId !== existing.lessonTypeId ||
      body.lessonCount !== existing.lessonCount ||
      body.validityDays !== existing.validityDays ||
      JSON.stringify([...body.coachIds].sort()) !== JSON.stringify([...existing.coachIds].sort())
    const paying = db
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.productId, id), eq(orders.status, 'pending')))
      .get()
    if (termsChanged && paying) {
      throw new ApiError(409, 'product_in_payment', '有学员正在支付该课时包，请几分钟后再修改')
    }
    const row = db
      .update(packageProducts)
      .set(body)
      .where(eq(packageProducts.id, id))
      .returning()
      .get()
    const was = productPriceLine(existing)
    const now = productPriceLine(body)
    if (was !== now) {
      log(c.get('staffId'), {
        action: 'price.product',
        summary: `${body.name}：${was} 改为 ${now}`,
        target: { kind: 'product', id },
      })
    }
    return c.json(row)
  })

  // Students and their packages

  app.get('/students', (c) => {
    const { q } = parseQuery(c, z.object({ q: z.string().trim().max(30).default('') }))
    const pattern = `%${q.replace(/[%_]/g, '')}%`
    return c.json(
      db
        .select({
          id: students.id,
          name: students.name,
          phone: students.phone,
          tester: students.tester,
          deletedAt: students.deletedAt,
          createdAt: students.createdAt,
        })
        .from(students)
        .where(q ? or(like(students.name, pattern), like(students.phone, pattern)) : undefined)
        .orderBy(desc(students.id))
        .limit(100)
        .all(),
    )
  })

  app.get('/students/:id', (c) => {
    const id = idParam(c)
    const student = db.select().from(students).where(eq(students.id, id)).get()
    if (!student) throw notFound('学员')
    const now = deps.now()
    const pkgRows = db
      .select()
      .from(packages)
      .where(eq(packages.studentId, id))
      .orderBy(desc(packages.id))
      .all()
    const bookingRows = db
      .select()
      .from(bookings)
      .where(eq(bookings.studentId, id))
      .orderBy(desc(bookings.startsAt))
      .limit(100)
      .all()
    return c.json({
      id: student.id,
      name: student.name,
      phone: student.phone,
      tester: student.tester,
      deletedAt: student.deletedAt,
      createdAt: student.createdAt,
      packages: packageViews(db, pkgRows, now),
      bookings: bookingViews(db, bookingRows, getSettings(db).booking, now),
    })
  })

  app.patch('/students/:id', async (c) => {
    const body = await parseBody(
      c,
      z
        .object({
          name: z.string().trim().min(1).max(20).optional(),
          phone: z
            .string()
            .trim()
            .regex(/^1\d{10}$/)
            .optional(),
          tester: z.boolean().optional(),
        })
        .refine((b) => Object.keys(b).length > 0, { message: '没有要修改的内容' }),
    )
    const id = idParam(c)
    const before = db.select().from(students).where(eq(students.id, id)).get()
    if (!before) throw notFound('学员')
    if (before.deletedAt) throw accountDeleted()
    const changed = db.update(students).set(body).where(eq(students.id, id)).run()
    if (changed.changes === 0) throw notFound('学员')
    // Field names only: the log keeps no copy of a student's name or phone.
    const changes = [
      body.name !== undefined && body.name !== before.name && '修改姓名',
      body.phone !== undefined && body.phone !== before.phone && '修改手机号',
      body.tester !== undefined &&
        body.tester !== before.tester &&
        (body.tester ? '设为测试学员' : '取消测试学员'),
    ].filter((x): x is string => Boolean(x))
    if (changes.length) {
      log(c.get('staffId'), {
        action: 'student.update',
        summary: changes.join('，'),
        studentId: id,
        target: { kind: 'student', id },
      })
    }
    return c.body(null, 204)
  })

  app.get('/packages/:id/ledger', (c) =>
    c.json(
      db
        .select()
        .from(packageLedger)
        .where(eq(packageLedger.packageId, idParam(c)))
        .orderBy(desc(packageLedger.id))
        .all(),
    ),
  )

  app.post('/packages/:id/grant', async (c) => {
    const body = await parseBody(
      c,
      z.object({
        lessons: z.number().int().min(1).max(50),
        note: z.string().trim().min(1).max(100),
      }),
    )
    const id = idParam(c)
    grantLessons(deps, id, body.lessons, body.note)
    const pkg = db.select().from(packages).where(eq(packages.id, id)).get()
    log(c.get('staffId'), {
      action: 'package.grant',
      summary: `课时包「${pkg?.name}」赠送 ${body.lessons} 节：${body.note}`,
      studentId: pkg?.studentId,
      target: { kind: 'package', id },
    })
    return c.body(null, 204)
  })

  app.post('/packages/:id/extend', async (c) => {
    const body = await parseBody(
      c,
      z.object({
        days: z.number().int().min(1).max(365),
        note: z.string().trim().max(100).default(''),
      }),
    )
    const id = idParam(c)
    extendPackage(deps, id, body.days, body.note)
    const pkg = db.select().from(packages).where(eq(packages.id, id)).get()
    log(c.get('staffId'), {
      action: 'package.extend',
      summary: `课时包「${pkg?.name}」延长 ${body.days} 天${body.note ? `：${body.note}` : ''}`,
      studentId: pkg?.studentId,
      target: { kind: 'package', id },
    })
    return c.body(null, 204)
  })

  app.post('/packages/offline-sale', async (c) => {
    const body = await parseBody(
      c,
      z.object({
        studentId: z.number().int().positive(),
        productId: z.number().int().positive(),
        amount: fen,
        method: offlineMethod,
        note: z.string().trim().max(100).default(''),
      }),
    )
    const packageId = sellPackageOffline(deps, body)
    const pkg = db.select().from(packages).where(eq(packages.id, packageId)).get()
    log(c.get('staffId'), {
      action: 'package.sell',
      summary: `售出课时包「${pkg?.name}」，${offlineMethodLabels[body.method]} ${yuan(body.amount)}`,
      amount: body.amount,
      studentId: body.studentId,
      target: { kind: 'package', id: packageId },
    })
    return c.json({ packageId }, 201)
  })

  // Orders and refunds

  app.get('/orders', (c) => {
    const q = parseQuery(
      c,
      z.object({
        status: z.enum(['pending', 'paid', 'closed']).optional(),
        studentId: z.coerce.number().int().positive().optional(),
      }),
    )
    const rows = db
      .select({
        order: orders,
        student: { id: students.id, name: students.name, phone: students.phone },
      })
      .from(orders)
      .innerJoin(students, eq(students.id, orders.studentId))
      .where(
        and(
          q.status ? eq(orders.status, q.status) : undefined,
          q.studentId ? eq(orders.studentId, q.studentId) : undefined,
        ),
      )
      .orderBy(desc(orders.id))
      .limit(500)
      .all()
    const refunded = new Map(
      rows.length
        ? db
            .select({ orderId: refunds.orderId, total: sql<number>`sum(${refunds.amount})` })
            .from(refunds)
            .where(
              and(
                inArray(
                  refunds.orderId,
                  rows.map((r) => r.order.id),
                ),
                eq(refunds.status, 'succeeded'),
              ),
            )
            .groupBy(refunds.orderId)
            .all()
            .map((r) => [r.orderId, Number(r.total)])
        : [],
    )
    return c.json(
      rows.map(({ order, student }) => ({
        ...order,
        prepayId: undefined,
        student,
        refunded: refunded.get(order.id) ?? 0,
      })),
    )
  })

  app.get('/refunds', (c) => {
    const q = parseQuery(
      c,
      z.object({
        status: z
          .enum(['requested', 'pending', 'processing', 'succeeded', 'failed', 'rejected'])
          .optional(),
      }),
    )
    const rows = db
      .select({
        refund: refunds,
        order: {
          id: orders.id,
          amount: orders.amount,
          provider: orders.provider,
          kind: orders.kind,
          description: orders.description,
        },
        student: { id: students.id, name: students.name, phone: students.phone },
      })
      .from(refunds)
      .innerJoin(orders, eq(orders.id, refunds.orderId))
      .innerJoin(students, eq(students.id, orders.studentId))
      .where(q.status ? eq(refunds.status, q.status) : undefined)
      .orderBy(desc(refunds.id))
      .limit(500)
      .all()
    const packageIds = rows.flatMap((r) => (r.refund.packageId ? [r.refund.packageId] : []))
    const pkgs = new Map(
      packageViews(
        db,
        packageIds.length
          ? db.select().from(packages).where(inArray(packages.id, packageIds)).all()
          : [],
        deps.now(),
      ).map((p) => [p.id, p]),
    )
    return c.json(
      rows.map((r) => ({
        ...r.refund,
        order: r.order,
        student: r.student,
        package: r.refund.packageId ? (pkgs.get(r.refund.packageId) ?? null) : null,
      })),
    )
  })

  /** "课时包「十节课」的" or "订单「一对一私教」的", with the refund's amount and student. */
  const refundContext = (refundId: number) => {
    const row = db
      .select({ refund: refunds, order: orders })
      .from(refunds)
      .innerJoin(orders, eq(orders.id, refunds.orderId))
      .where(eq(refunds.id, refundId))
      .get()
    const pkg = row?.refund.packageId
      ? db.select().from(packages).where(eq(packages.id, row.refund.packageId)).get()
      : undefined
    return {
      what: pkg ? `课时包「${pkg.name}」` : `订单「${row?.order.description ?? ''}」`,
      amount: row?.refund.amount ?? 0,
      studentId: row?.order.studentId ?? null,
    }
  }

  app.post('/refunds/:id/approve', async (c) => {
    const { amount } = await parseBody(c, z.object({ amount: fen.min(1) }))
    const id = idParam(c)
    if (!(await approvePackageRefund(deps, id, amount))) return c.body(null, 204)
    const r = refundContext(id)
    log(c.get('staffId'), {
      action: 'refund.approve',
      summary: `同意${r.what}退款 ${yuan(amount)}`,
      amount,
      studentId: r.studentId,
      target: { kind: 'refund', id },
    })
    return c.body(null, 204)
  })

  app.post('/refunds/:id/reject', async (c) => {
    const { note } = await parseBody(c, z.object({ note: z.string().trim().min(1).max(100) }))
    const id = idParam(c)
    if (!rejectPackageRefund(deps, id, note)) return c.body(null, 204)
    const r = refundContext(id)
    log(c.get('staffId'), {
      action: 'refund.reject',
      summary: `拒绝${r.what}退款：${note}`,
      studentId: r.studentId,
      target: { kind: 'refund', id },
    })
    return c.body(null, 204)
  })

  app.post('/refunds/:id/paid-back', (c) => {
    const id = idParam(c)
    if (!markOfflineRefundPaid(deps, id)) return c.body(null, 204)
    const r = refundContext(id)
    log(c.get('staffId'), {
      action: 'refund.paid_back',
      summary: `${r.what}线下退还 ${yuan(r.amount)}`,
      amount: r.amount,
      studentId: r.studentId,
      target: { kind: 'refund', id },
    })
    return c.body(null, 204)
  })

  app.post('/refunds/:id/retry', async (c) => {
    const id = idParam(c)
    if (!(await retryRefund(deps, id))) return c.body(null, 204)
    const r = refundContext(id)
    log(c.get('staffId'), {
      action: 'refund.retry',
      summary: `重试${r.what}退款 ${yuan(r.amount)}`,
      amount: r.amount,
      studentId: r.studentId,
      target: { kind: 'refund', id },
    })
    return c.body(null, 204)
  })

  // Banners and uploads

  app.get('/banners', (c) =>
    c.json(db.select().from(banners).orderBy(asc(banners.sort), asc(banners.id)).all()),
  )

  app.post('/banners', async (c) => {
    const body = await parseBody(c, bannerBody)
    return c.json(db.insert(banners).values(body).returning().get(), 201)
  })

  app.put('/banners/:id', async (c) => {
    const body = await parseBody(c, bannerBody)
    const id = idParam(c)
    const row = immediate(db, (tx) => {
      const current = tx.select().from(banners).where(eq(banners.id, id)).get()
      if (!current) throw notFound('轮播图')
      checkVersion(c, current)
      return tx.update(banners).set(body).where(eq(banners.id, id)).returning().get()
    })
    return c.json(row)
  })

  app.delete('/banners/:id', (c) => {
    const changed = db
      .delete(banners)
      .where(eq(banners.id, idParam(c)))
      .run()
    if (changed.changes === 0) throw notFound('轮播图')
    return c.body(null, 204)
  })

  app.post('/uploads', async (c) => {
    const form = await c.req.formData().catch(() => null)
    const file = form?.get('file')
    if (!(file instanceof File)) throw new ApiError(400, 'no_file', '请选择图片')
    const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[file.type]
    if (!ext) throw new ApiError(400, 'bad_type', '只支持 JPG、PNG、WebP 图片')
    if (file.size > 2 * 1024 * 1024) throw new ApiError(400, 'too_large', '图片不能超过 2MB')
    const name = `${Date.now()}-${randomBytes(6).toString('hex')}.${ext}`
    mkdirSync(deps.uploadsDir, { recursive: true })
    writeFileSync(join(deps.uploadsDir, name), Buffer.from(await file.arrayBuffer()))
    return c.json({ url: `/api/uploads/${name}` }, 201)
  })

  app.get('/reports/monthly', (c) => {
    const { month } = parseQuery(c, z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }))
    return c.json(monthlyReport(deps, month))
  })

  // Dashboard numbers for the admin home page.
  app.get('/summary', (c) => {
    const now = deps.now()
    const count = (where: ReturnType<typeof and>) =>
      db.select({ n: sql<number>`count(*)` }).from(bookings).where(where).get()?.n ?? 0
    return c.json({
      upcomingBookings: count(and(eq(bookings.status, 'confirmed'), gt(bookings.startsAt, now))),
      pendingPayments: count(eq(bookings.status, 'pending_payment')),
      refundRequests:
        db
          .select({ n: sql<number>`count(*)` })
          .from(refunds)
          .where(eq(refunds.status, 'requested'))
          .get()?.n ?? 0,
      failedRefunds:
        db
          .select({ n: sql<number>`count(*)` })
          .from(refunds)
          .where(eq(refunds.status, 'failed'))
          .get()?.n ?? 0,
    })
  })

  return app
}
