import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  addVenueDays,
  can,
  groupSettingsError,
  instantString,
  isGroup,
  LINK_TARGET_MESSAGE,
  linkShape,
  linkTargetValid,
  MAX_CAPACITY,
  offlineMethodLabels,
  offlineMethods,
  packageTermsSchema,
  REFUND_SETTLE_WAYS,
  type RuleOverrides,
  ruleNames,
  ruleOverrides,
  ruleShortLabels,
  ruleText,
  SCHEDULE_STEP,
  type StaffRole,
  staffActions,
  staffRoleLabels,
  staffRoles,
  VENUE_PHONE_MESSAGE,
  venueDateKey,
  venueInstant,
  venuePhoneValid,
  venueSettings,
} from '@rs/shared'
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  sql,
} from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { immediate, type Q } from '../db/client'
import {
  banners,
  bookingMoves,
  bookings,
  categoryPayRates,
  categoryPrices,
  coachCategories,
  coaches,
  coachLessonTypes,
  invoices,
  lessonTypes,
  orders,
  packageLedger,
  packageNotices,
  packageProducts,
  packages,
  refunds,
  sessions,
  slots,
  staff,
  students,
} from '../db/schema'
import type { Deps } from '../deps'
import { ApiError, checkVersion, idParam, notFound, parseBody, parseQuery } from '../errors'
import { accountDeleted, personColumns } from '../services/account'
import {
  cancelOutcome,
  describeBooking,
  listActions,
  logAction,
  venueMoment,
  venueSpan,
  yuan,
} from '../services/action-log'
import { frontDeskLessons, setAttendance } from '../services/attendance'
import {
  type AdminVars,
  bearer,
  limitedCheckAsync,
  loginAdmin,
  logout,
  need,
  requireAdmin,
} from '../services/auth'
import { cancelBooking, LIVE } from '../services/bookings'
import { newCoachBindCode, unbindCoach } from '../services/coaches'
import { buildExport, describeExport, type ExportKind, exportKinds } from '../services/exports'
import {
  adminFeedback,
  adminFeedbackCount,
  feedbackStates,
  imageType,
  readLessonPhoto,
  setFeedbackHidden,
  studentFeedback,
} from '../services/feedback'
import { bookForStudent, frontDeskQuote } from '../services/front-desk'
import { stripImageMetadata } from '../services/image-meta'
import {
  adminInvoice,
  adminInvoices,
  invoiceLabel,
  invoicePdf,
  issueInvoice,
  markRefundSeen,
  rejectInvoice,
} from '../services/invoices'
import { checkLinkTarget } from '../services/links'
import {
  bookingPayParam,
  bookingStatusParam,
  bookingWhere,
  countAll,
  flag,
  openAnomaly,
  orderKindParam,
  orderWhere,
  pageParams,
  providerParam,
  refundWhere,
  searchParam,
  setTotal,
  sourceParam,
  studentSearch,
  titleKindParam,
} from '../services/lists'
import { resolveMapLink } from '../services/map-links'
import { moveBooking } from '../services/moves'
import { nextSort, orderedLists, saveOrder } from '../services/order'
import { EXPIRING_SOON_MS } from '../services/package-notices'
import {
  approvePackageRefund,
  deskRefundQuote,
  extendPackage,
  grantLessons,
  refundDeskPackage,
  rejectPackageRefund,
  sellPackageOffline,
} from '../services/packages'
import { confirmMonth, unconfirmMonth } from '../services/pay-months'
import { markOfflineRefundPaid, retryRefund, settleFailedRefund } from '../services/refunds'
import { monthlyReport } from '../services/reports'
import { cleanRichText } from '../services/rich-text'
import {
  addException,
  dayPlan,
  openTimes,
  removeException,
  saveHours,
  scheduleConflicts,
  scheduleView,
  upcomingClosures,
} from '../services/schedule'
import { cancelSession, createSessions, setSessionCapacity } from '../services/sessions'
import { getSettings, ownRules, saveSettings } from '../services/settings'
import {
  createStaff,
  findStaff,
  setStaffPassword,
  staffView,
  updateStaff,
  verifyPassword,
} from '../services/staff'
import { dashboard, dormantStudents, statsReport } from '../services/stats'
import {
  createDeskStudent,
  deleteDeskStudent,
  isDeskOpenid,
  newStudentBindCode,
  samePhone,
  unlinkedSql,
  wechatOpenid,
} from '../services/student-link'
import { profileInput, saveStudentProfile, studentProfile } from '../services/student-profiles'
import { slotsWithoutTable } from '../services/tables'
import { bookingStatus, bookingViews, packageViews } from '../services/views'
import { exceptionBody, weeklyHoursBody } from './coach'
import { dateKey, monthKey, oneTarget, targetFields, toTarget } from './target'

const instant = instantString.transform((s) => new Date(s))
const id = z.coerce.number().int().positive().optional()
// A query parameter that only some kinds of a request take; the others refuse it.
const only = <T extends z.ZodType>(allowed: boolean, schema: T) =>
  allowed ? schema : z.undefined().optional()
const nullableInstant = instant.nullable()
const fen = z.number().int().min(0).max(10_000_000)
const MAX_SLOTS_PER_REQUEST = 500
// Rows per page of the admin's long lists; the admin loads more on request.
const PAGE_SIZE = 50
// Refinements, so the client shows these messages rather than a generic field error.
const password = z
  .string()
  .refine((v) => v.length >= 8 && v.length <= 100, { message: '密码需为 8 到 100 位' })
  .refine((v) => v.trim() === v, { message: '密码不能以空格开头或结尾' })
const username = z
  .string()
  .trim()
  .toLowerCase()
  .refine((v) => /^[a-z0-9_.-]{3,20}$/.test(v), {
    message: '登录名需为 3 到 20 位，可以用字母、数字和 _ . -',
  })
const staffName = z.string().trim().min(1).max(20)
const roles = z
  .array(z.enum(staffRoles))
  // A refinement, so the message is shown as written.
  .refine((v) => v.length > 0, { message: '请选择角色' })
  .max(staffRoles.length)
  .transform((r) => staffRoles.filter((role) => r.includes(role)))
const rolesText = (r: readonly StaffRole[]) => r.map((role) => staffRoleLabels[role]).join('、')
const offlineMethod = z.enum(offlineMethods)
const settingsSectionLabel = {
  venue: '场馆信息',
  booking: '默认预约规则',
  payment: '支付',
  notice: '公告',
  policies: '须知与协议',
  legal: '运营主体',
} as const

/** A price and its sale, if any, as one line for the action log. */
function priceLine(
  price: number,
  sale: string | null,
  startsAt: Date | null,
  endsAt: Date | null,
  now: Date,
) {
  if (!sale || !startsAt || !endsAt) return yuan(price)
  return `${yuan(price)}，${sale}（${venueMoment(startsAt, now)} 至 ${venueMoment(endsAt, now)}）`
}

const coachBody = z.object({
  name: z.string().trim().min(1).max(20),
  categoryId: z.number().int().positive().nullable().default(null),
  title: z.string().trim().max(30).default(''),
  tags: z.array(z.string().trim().min(1).max(10)).max(6).default([]),
  profile: z.string().max(50_000).transform(cleanRichText).default(''),
  avatarUrl: z.string().max(300).default(''),
  active: z.boolean().default(true),
  /** Lesson types this coach teaches. */
  lessonTypeIds: z.array(z.number().int().positive()).max(100).default([]),
})

const categoryBody = z.object({
  name: z.string().trim().min(1).max(10),
  /** Prices for some lesson types; the rest use the lesson type's own price. */
  prices: z
    .array(z.object({ lessonTypeId: z.number().int().positive(), price: fen }))
    .max(100)
    .default([]),
  /** What a coach in the category is paid per lesson; lesson types without one show as unset. */
  payRates: z
    .array(z.object({ lessonTypeId: z.number().int().positive(), rate: fen }))
    .max(100)
    .default([]),
})

const lessonTypeBody = z
  .object({
    name: z.string().trim().min(1).max(30),
    description: z.string().trim().max(500).default(''),
    durationMinutes: z
      .number()
      .int()
      .min(15)
      .max(480)
      .refine((m) => m % SCHEDULE_STEP === 0, `时长需为 ${SCHEDULE_STEP} 分钟的整数倍`),
    price: fen,
    isTrial: z.boolean().default(false),
    adminOnly: z.boolean().default(false),
    active: z.boolean().default(true),
    salePercent: z.number().int().min(1).max(99).nullable().default(null),
    saleStartsAt: nullableInstant.default(null),
    saleEndsAt: nullableInstant.default(null),
    capacity: z.number().int().min(1).max(MAX_CAPACITY).default(1),
    minStudents: z.number().int().min(2).max(MAX_CAPACITY).nullable().default(null),
    studentsPerTable: z.number().int().min(1).max(MAX_CAPACITY).nullable().default(null),
    // A rule left out follows the venue's 默认预约规则. Left out altogether, an edit keeps them.
    rules: ruleOverrides.optional(),
  })
  .superRefine((v, ctx) => saleDatesCheck(ctx, '折扣', v.salePercent, v.saleStartsAt, v.saleEndsAt))
  .superRefine((v, ctx) => {
    const error = groupSettingsError(v)
    if (error) ctx.addIssue({ code: 'custom', message: error, path: ['capacity'] })
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
  })
  .superRefine((v, ctx) => saleDatesCheck(ctx, '限时价', v.salePrice, v.saleStartsAt, v.saleEndsAt))

const bannerBody = z
  .object({
    // An image uploaded here, not a lesson photo: anything else could point the app elsewhere.
    imageUrl: z
      .string()
      .max(300)
      .refine((u) => /^\/api\/uploads\/(?!fb)[\w-]+\.(jpg|png|webp)$/.test(u), {
        message: '请上传图片',
      }),
    title: z.string().trim().max(30).default(''),
    ...linkShape,
    startsAt: nullableInstant.default(null),
    endsAt: nullableInstant.default(null),
    active: z.boolean().default(true),
  })
  .refine(linkTargetValid, { message: LINK_TARGET_MESSAGE, path: ['linkId'] })
  .refine((v) => !v.startsAt || !v.endsAt || v.startsAt < v.endsAt, {
    message: '结束时间需晚于开始时间',
  })

const orderBody = z.object({ ids: z.array(z.number().int().positive()).max(500) })

/** A sale needs a start and an end, the end after the start. */
function saleDatesCheck(
  ctx: z.RefinementCtx,
  what: string,
  value: number | null,
  startsAt: Date | null,
  endsAt: Date | null,
) {
  if (value === null) return
  if (startsAt === null || endsAt === null) {
    ctx.addIssue({ code: 'custom', message: `${what}需要设置开始和结束时间` })
  } else if (startsAt >= endsAt) {
    ctx.addIssue({ code: 'custom', message: '结束时间要晚于开始时间' })
  }
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
    return c.json(await loginAdmin(deps, body.username, body.password, client))
  })

  // Any session may end itself, a deactivated login's too: it needs no access to anything.
  app.post('/logout', (c) => {
    logout(deps, c.req.header('Authorization'))
    return c.body(null, 204)
  })

  app.use('*', async (c, next) => {
    if (c.req.path.endsWith('/admin/login') || c.req.path.endsWith('/admin/logout')) return next()
    return requireAdmin(deps)(c, next)
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

  app.get('/me', need('view'), (c) => c.json(staffView(findStaff(db, c.get('staffId')))))

  app.put('/me/password', need('view'), async (c) => {
    const body = await parseBody(c, z.object({ current: z.string().max(200), password }))
    const me = findStaff(db, c.get('staffId'))
    // Limited like logins, so a session left open cannot guess its way to the password.
    await limitedCheckAsync(
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

  app.get('/staff', need('manage'), (c) =>
    c.json(db.select().from(staff).orderBy(desc(staff.active), asc(staff.id)).all().map(staffView)),
  )

  app.post('/staff', need('manage'), async (c) => {
    const body = await parseBody(c, z.object({ name: staffName, username, password, roles }))
    const row = createStaff(deps, body)
    log(c.get('staffId'), {
      action: 'staff.create',
      summary: `新增员工 ${row.name}（${row.username}），${rolesText(row.roles)}`,
      target: { kind: 'staff', id: row.id },
    })
    return c.json(staffView(row), 201)
  })

  app.patch('/staff/:id', need('manage'), async (c) => {
    const body = await parseBody(
      c,
      z
        .object({
          name: staffName.optional(),
          active: z.boolean().optional(),
          roles: roles.optional(),
        })
        .refine((b) => Object.keys(b).length > 0, { message: '没有要修改的内容' }),
    )
    const { before, after } = updateStaff(deps, c.get('staffId'), idParam(c), body)
    // Logged on its own, so the log can be filtered for who changed what someone may do.
    if (rolesText(before.roles) !== rolesText(after.roles)) {
      log(c.get('staffId'), {
        action: 'staff.roles',
        summary: `${after.name}（${after.username}）角色由 ${rolesText(before.roles)} 改为 ${rolesText(after.roles)}`,
        target: { kind: 'staff', id: after.id },
      })
    }
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

  app.put('/staff/:id/password', need('manage'), async (c) => {
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

  app.get('/actions', need('manage'), (c) => {
    const q = parseQuery(
      c,
      z.object({
        staffId: z.coerce.number().int().positive().optional(),
        coachId: z.coerce.number().int().positive().optional(),
        studentId: z.coerce.number().int().positive().optional(),
        slotId: z.coerce.number().int().positive().optional(),
        // Comma separated.
        actions: z
          .string()
          .optional()
          .transform((v) => (v ? v.split(',') : undefined))
          .pipe(z.array(z.enum(staffActions)).optional()),
        from: instant.optional(),
        to: instant.optional(),
        q: searchParam,
        before: z.coerce.number().int().positive().optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      }),
    )
    const { rows, total } = listActions(db, q)
    setTotal(c, total)
    return c.json(rows)
  })

  // Settings

  app.get('/settings', need('manage'), (c) => c.json(getSettings(db)))

  app.get('/map', need('manage'), (c) => c.json({ tencentKey: deps.tencentMapKey ?? null }))

  // Coordinates from a map share link the admin pasted, in GCJ-02. Changes nothing, so a repeat
  // is harmless.
  app.post('/map/resolve', need('manage'), async (c) => {
    const { url } = await parseBody(c, z.object({ url: z.string().trim().min(1).max(2000) }))
    if (!deps.mapFetch) throw new ApiError(503, 'map_unavailable', '暂时无法读取地图链接')
    return c.json(await resolveMapLink(url, deps.mapFetch))
  })

  app.put('/settings', need('manage'), async (c) => {
    const body = await parseBody(c, venueSettings)
    const { before, after } = immediate(db, (tx) => {
      const before = getSettings(tx)
      checkVersion(c, before)
      // Only a changed phone is checked, so one saved before the check does not block the rest.
      if (body.venue.phone !== before.venue.phone && !venuePhoneValid(body.venue.phone)) {
        throw new ApiError(400, 'invalid_body', VENUE_PHONE_MESSAGE)
      }
      checkLinkTarget(tx, body.notice)
      saveSettings(tx, body, deps.now())
      return { before, after: getSettings(tx) }
    })
    const changed = (Object.keys(settingsSectionLabel) as (keyof typeof settingsSectionLabel)[])
      .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
      .map((k) => settingsSectionLabel[k])
    if (changed.length) {
      log(c.get('staffId'), { action: 'settings.update', summary: `修改${changed.join('、')}` })
    }
    // Logged with the pay rates, since it changes what coaches are paid.
    if (JSON.stringify(before.pay) !== JSON.stringify(after.pay)) {
      const counts = (on: boolean) => (on ? '计入' : '不计入')
      log(c.get('staffId'), {
        action: 'price.coach_pay',
        summary: `课时费计算：缺席${counts(after.pay.noShows)}，学员逾时取消${counts(after.pay.lateCancels)}`,
      })
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

  app.get('/coaches', need('view'), (c) => {
    // A live bind code would let whoever reads it sign in as the coach.
    const binds = can(c.get('roles'), 'manage')
    return c.json(
      db
        .select({ id: coaches.id })
        .from(coaches)
        .orderBy(asc(coaches.sort), asc(coaches.id))
        .all()
        .map((r) => coachView(r.id))
        .map((v) => (binds ? v : { ...v, bindCode: null, bindCodeExpiresAt: null })),
    )
  })

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
        .values({ ...fields, tags, sort: nextSort(tx, coaches) })
        .returning({ id: coaches.id })
        .get().id
    } else {
      const changed = tx
        .update(coaches)
        .set({ ...fields, tags })
        .where(eq(coaches.id, coachId))
        .run()
      if (changed.changes === 0) throw notFound('教练')
      // As for staff: a deactivated coach's phones sign out for good, so turning the coach back
      // on later does not bring back a session on a phone that was lost meanwhile.
      if (!fields.active) tx.delete(sessions).where(eq(sessions.coachId, coachId)).run()
    }
    tx.delete(coachLessonTypes).where(eq(coachLessonTypes.coachId, coachId)).run()
    for (const lessonTypeId of new Set(lessonTypeIds)) {
      tx.insert(coachLessonTypes).values({ coachId, lessonTypeId }).run()
    }
    return coachId
  }

  const categoryName = (id: number | null) => {
    if (id === null) return '无类别'
    const row = db
      .select({ name: coachCategories.name })
      .from(coachCategories)
      .where(eq(coachCategories.id, id))
      .get()
    return `类别「${row?.name ?? `#${id}`}」`
  }

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
          ? `新增教练 ${coach.name}，${categoryName(coach.categoryId)}`
          : `${coach.name}：${categoryName(before)} 改为 ${categoryName(coach.categoryId)}`,
      target: { kind: 'coach', id: coach.id },
    })
  }

  app.post('/coaches', need('manage'), async (c) => {
    const body = await parseBody(c, coachBody)
    const id = immediate(db, (tx) => saveCoach(tx, null, body))
    const view = coachView(id)
    logCoachCategory(c.get('staffId'), view, undefined)
    return c.json(view, 201)
  })

  app.put('/coaches/:id', need('manage'), async (c) => {
    const id = idParam(c)
    const body = await parseBody(c, coachBody)
    const before = immediate(db, (tx) => {
      // Binding comes and goes on its own (codes expire), so only the edited fields count.
      const { bound: _b, bindCode: _c, bindCodeExpiresAt: _e, ...editable } = coachView(id)
      checkVersion(c, editable)
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
    const rates = db.select().from(categoryPayRates).all()
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
        payRates: rates
          .filter((r) => r.categoryId === cat.id)
          .map(({ lessonTypeId, rate }) => ({ lessonTypeId, rate })),
      }))
  }

  const categoryView = (id: number) => {
    const view = categoryViews().find((cat) => cat.id === id)
    if (!view) throw notFound('教练类别')
    return view
  }

  const saveCategory = (tx: Q, id: number | null, body: z.infer<typeof categoryBody>) => {
    const { prices, payRates, ...fields } = body
    checkLessonTypes(
      tx,
      [...prices, ...payRates].map((p) => p.lessonTypeId),
    )
    let categoryId = id
    if (categoryId === null) {
      categoryId = tx
        .insert(coachCategories)
        .values({ ...fields, sort: nextSort(tx, coachCategories) })
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
    tx.delete(categoryPayRates).where(eq(categoryPayRates.categoryId, categoryId)).run()
    for (const [lessonTypeId, rate] of new Map(payRates.map((r) => [r.lessonTypeId, r.rate]))) {
      tx.insert(categoryPayRates).values({ categoryId, lessonTypeId, rate }).run()
    }
    return categoryId
  }

  app.get('/coach-categories', need('manage'), (c) => c.json(categoryViews()))

  type CategoryMoney = Pick<ReturnType<typeof categoryView>, 'prices' | 'payRates'>

  /**
   * Logs the category prices and pay rates that changed, as "一对一私教 ¥200 改为 ¥250", one
   * entry for prices and one for pay.
   */
  const logCategoryPrices = (
    staffId: number,
    category: ReturnType<typeof categoryView>,
    before: CategoryMoney,
  ) => {
    const names = new Map(
      db
        .select({ id: lessonTypes.id, name: lessonTypes.name })
        .from(lessonTypes)
        .all()
        .map((t) => [t.id, t.name]),
    )
    const diff = (old: Map<number, number>, now: Map<number, number>, unset: string) =>
      [...new Set([...old.keys(), ...now.keys()])].flatMap((id) => {
        const name = names.get(id) ?? `课程 #${id}`
        const was = old.get(id)
        const value = now.get(id)
        if (value === undefined) return [`${name} ${unset}`]
        if (was === undefined) return [`${name} ${yuan(value)}`]
        return was === value ? [] : [`${name} ${yuan(was)} 改为 ${yuan(value)}`]
      })
    const prices = diff(
      new Map(before.prices.map((p) => [p.lessonTypeId, p.price])),
      new Map(category.prices.map((p) => [p.lessonTypeId, p.price])),
      '改为按课程标价',
    )
    if (prices.length) {
      log(staffId, {
        action: 'price.coach',
        summary: `类别「${category.name}」：${prices.join('；')}`,
        target: { kind: 'category', id: category.id },
      })
    }
    const pay = diff(
      new Map(before.payRates.map((r) => [r.lessonTypeId, r.rate])),
      new Map(category.payRates.map((r) => [r.lessonTypeId, r.rate])),
      '改为未设置',
    )
    if (pay.length) {
      log(staffId, {
        action: 'price.coach_pay',
        summary: `类别「${category.name}」课时费：${pay.join('；')}`,
        target: { kind: 'category', id: category.id },
      })
    }
  }

  app.post('/coach-categories', need('manage'), async (c) => {
    const body = await parseBody(c, categoryBody)
    const id = immediate(db, (tx) => saveCategory(tx, null, body))
    const view = categoryView(id)
    logCategoryPrices(c.get('staffId'), view, { prices: [], payRates: [] })
    return c.json(view, 201)
  })

  app.put('/coach-categories/:id', need('manage'), async (c) => {
    const id = idParam(c)
    const body = await parseBody(c, categoryBody)
    const before = immediate(db, (tx) => {
      const old = categoryView(id)
      checkVersion(c, old)
      saveCategory(tx, id, body)
      return old
    })
    const view = categoryView(id)
    logCategoryPrices(c.get('staffId'), view, before)
    return c.json(view)
  })

  app.delete('/coach-categories/:id', need('manage'), (c) => {
    const id = idParam(c)
    immediate(db, (tx) => {
      const used = tx
        .select({ id: coaches.id })
        .from(coaches)
        .where(eq(coaches.categoryId, id))
        .get()
      if (used) throw new ApiError(409, 'category_in_use', '还有教练属于该类别')
      tx.delete(categoryPrices).where(eq(categoryPrices.categoryId, id)).run()
      tx.delete(categoryPayRates).where(eq(categoryPayRates.categoryId, id)).run()
      const changed = tx.delete(coachCategories).where(eq(coachCategories.id, id)).run()
      if (changed.changes === 0) throw notFound('教练类别')
    })
    return c.body(null, 204)
  })

  app.post('/coaches/:id/bind-code', need('manage'), (c) =>
    c.json(newCoachBindCode(deps, idParam(c)), 201),
  )

  app.delete('/coaches/:id/binding', need('manage'), (c) => {
    unbindCoach(deps, idParam(c))
    return c.body(null, 204)
  })

  // 排班

  const coachName = (id: number) =>
    db.select({ name: coaches.name }).from(coaches).where(eq(coaches.id, id)).get()?.name ?? ''
  const spanText = (startsAt: Date, endsAt: Date) => venueSpan(startsAt, endsAt, deps.now())

  app.get('/coaches/:id/hours', need('view'), (c) =>
    c.json(scheduleView(db, deps.now(), idParam(c))),
  )

  app.put('/coaches/:id/hours', need('bookings'), async (c) => {
    const body = await parseBody(c, weeklyHoursBody)
    const id = idParam(c)
    const from = body.from ?? venueDateKey(deps.now())
    const { conflicts, changed } = saveHours(deps, id, { from, hours: body.hours }, (current) =>
      checkVersion(c, current),
    )
    if (changed) {
      log(c.get('staffId'), {
        action: 'schedule.hours',
        summary: `${coachName(id)}：每周时间（${from} 起）`,
        target: { kind: 'coach', id },
      })
    }
    return c.json({ conflicts })
  })

  app.post('/coaches/:id/exceptions', need('bookings'), async (c) => {
    const body = await parseBody(c, exceptionBody)
    const id = idParam(c)
    const { created, ...result } = addException(deps, { ...body, coachId: id }, c.get('staffId'))
    if (created)
      log(c.get('staffId'), {
        action: 'schedule.add',
        summary: `${coachName(id)}：${body.kind === 'off' ? '请假' : '加班'} ${spanText(body.startsAt, body.endsAt)}`,
        target: { kind: 'coach', id },
      })
    return c.json(result, 201)
  })

  // 闭馆: time nobody at the venue takes lessons.
  app.get('/closures', need('view'), (c) => c.json(upcomingClosures(db, deps.now())))

  app.post('/closures', need('manage'), async (c) => {
    const body = await parseBody(
      c,
      z.object({
        startsAt: instant,
        endsAt: instant,
        note: z.string().trim().max(40).default(''),
      }),
    )
    const { created, ...result } = addException(
      deps,
      { ...body, kind: 'off', coachId: null },
      c.get('staffId'),
    )
    if (created)
      log(c.get('staffId'), {
        action: 'schedule.add',
        summary: `闭馆 ${spanText(body.startsAt, body.endsAt)}${body.note ? `（${body.note}）` : ''}`,
      })
    return c.json(result, 201)
  })

  const logRemoved = (staffId: number, { row }: ReturnType<typeof removeException>) => {
    if (!row) return
    const what =
      row.coachId === null
        ? '闭馆'
        : `${coachName(row.coachId)}：${row.kind === 'off' ? '请假' : '加班'}`
    log(staffId, {
      action: row.shortenedTo ? 'schedule.end' : 'schedule.remove',
      summary: row.shortenedTo
        ? `${what} ${spanText(row.startsAt, row.endsAt)} 提前结束，改为 ${spanText(row.startsAt, row.shortenedTo)}`
        : `${what} ${spanText(row.startsAt, row.endsAt)}`,
      target: row.coachId === null ? undefined : { kind: 'coach', id: row.coachId },
    })
  }

  app.delete('/coaches/:id/exceptions/:exceptionId', need('bookings'), (c) => {
    const exceptionId = Number(c.req.param('exceptionId'))
    if (!Number.isInteger(exceptionId) || exceptionId <= 0) throw notFound('请假/加班')
    const removed = removeException(deps, exceptionId, idParam(c))
    logRemoved(c.get('staffId'), removed)
    // Removing a 加班 leaves its lessons outside 排班, for the desk to move or cancel.
    return c.json({ conflicts: removed.conflicts })
  })

  app.delete('/closures/:id', need('manage'), (c) => {
    logRemoved(c.get('staffId'), removeException(deps, idParam(c), null))
    return c.body(null, 204)
  })

  // Lessons and sessions yet to start that the desk has to move or cancel.
  app.get('/schedule/conflicts', need('view'), (c) => c.json(scheduleConflicts(db, deps.now())))

  // A day for the 日程 board: each coach's working time and 请假, and tables in use.
  app.get('/schedule/day', need('view'), (c) => {
    const q = parseQuery(c, z.object({ date: dateKey }))
    return c.json(dayPlan(db, q.date))
  })

  // Start times a private lesson can be booked or moved to, for 代约 and 改约.
  app.get('/open-times', need('view'), (c) => {
    const q = parseQuery(
      c,
      z.object({
        date: dateKey,
        lessonTypeId: z.coerce.number().int().positive().optional(),
        coachId: z.coerce.number().int().positive().optional(),
        // A booking being moved: its coach's other coaches may take it, at its length.
        moving: z.coerce.number().int().positive().optional(),
      }),
    )
    const moving = q.moving
      ? db.select().from(bookings).where(eq(bookings.id, q.moving)).get()
      : undefined
    if (q.moving && !moving) throw notFound('预约')
    const lessonTypeId = q.lessonTypeId ?? moving?.lessonTypeId
    if (!lessonTypeId) throw new ApiError(400, 'invalid_query', '请选择课程')
    const lessonType = db.select().from(lessonTypes).where(eq(lessonTypes.id, lessonTypeId)).get()
    if (!lessonType) throw notFound('课程')
    if (isGroup(lessonType)) return c.json([])
    const coachIds = db
      .select({ id: coaches.id })
      .from(coachLessonTypes)
      .innerJoin(coaches, eq(coaches.id, coachLessonTypes.coachId))
      .where(and(eq(coachLessonTypes.lessonTypeId, lessonType.id), eq(coaches.active, true)))
      .orderBy(asc(coaches.sort), asc(coaches.id))
      .all()
      .map((r) => r.id)
      .filter((id) => !q.coachId || id === q.coachId)
    const times = openTimes(db, {
      coachIds,
      dates: [q.date],
      minutes: moving
        ? (moving.endsAt.getTime() - moving.startsAt.getTime()) / 60_000
        : lessonType.durationMinutes,
      notBefore: deps.now(),
      except: moving?.id,
    })
    return c.json(
      times.map((t) => ({
        coachId: t.coachId,
        startsAt: t.startsAt.toISOString(),
        endsAt: t.endsAt.toISOString(),
        tableFull: t.tableFull,
      })),
    )
  })

  // Lesson types

  // Rules are shown as they apply: one saved under an older shape is left out.
  const lessonTypeView = (row: typeof lessonTypes.$inferSelect) => ({
    ...row,
    rules: ownRules(row.rules),
  })

  /** Which rules a lesson type sets on its own, for the action log. */
  const rulesLine = (name: string, rules: RuleOverrides) => {
    const own = ruleNames.flatMap((n) =>
      rules[n] === undefined ? [] : [`${ruleShortLabels[n]} ${ruleText(n, rules[n])}`],
    )
    return `课程「${name}」的预约规则：${own.length ? `单独设置${own.join('，')}` : '全部按默认'}`
  }

  app.get('/lesson-types', need('view'), (c) =>
    c.json(
      db
        .select()
        .from(lessonTypes)
        .orderBy(asc(lessonTypes.sort), asc(lessonTypes.id))
        .all()
        .map(lessonTypeView),
    ),
  )

  const lessonPriceLine = (t: z.infer<typeof lessonTypeBody>) =>
    priceLine(
      t.price,
      t.salePercent ? `${t.salePercent}%` : null,
      t.saleStartsAt,
      t.saleEndsAt,
      deps.now(),
    )

  app.post('/lesson-types', need('manage'), async (c) => {
    const body = await parseBody(c, lessonTypeBody)
    const row = db
      .insert(lessonTypes)
      .values({ ...body, rules: body.rules ?? {}, sort: nextSort(db, lessonTypes) })
      .returning()
      .get()
    log(c.get('staffId'), {
      action: 'price.lesson_type',
      summary: `新建课程 ${row.name}，${lessonPriceLine(body)}`,
      target: { kind: 'lesson_type', id: row.id },
    })
    if (Object.keys(row.rules).length) {
      log(c.get('staffId'), {
        action: 'rules.lesson_type',
        summary: rulesLine(row.name, row.rules),
        target: { kind: 'lesson_type', id: row.id },
      })
    }
    return c.json(lessonTypeView(row), 201)
  })

  app.put('/lesson-types/:id', need('manage'), async (c) => {
    const id = idParam(c)
    const body = await parseBody(c, lessonTypeBody)
    const existing = db.select().from(lessonTypes).where(eq(lessonTypes.id, id)).get()
    if (!existing) throw notFound('课程')
    checkVersion(c, lessonTypeView(existing))
    const used = db
      .select({ id: bookings.id })
      .from(bookings)
      .where(eq(bookings.lessonTypeId, id))
      .get()
    const scheduled = db
      .select({ id: slots.id })
      .from(slots)
      .where(eq(slots.lessonTypeId, id))
      .get()
    // Sessions are scheduled at the class's length; a new length would leave them unbookable.
    if ((used || scheduled) && body.durationMinutes !== existing.durationMinutes) {
      throw new ApiError(409, 'duration_locked', '已有预约或排课的课程不能修改时长，请新建课程')
    }
    // Trial limits count past bookings by their lesson type, so the flag must not change under them.
    if (used && body.isTrial !== existing.isTrial) {
      throw new ApiError(409, 'trial_locked', '已有预约的课程不能更改是否为体验课，请新建课程')
    }
    // Sessions, bookings and slots are kept apart by whether the class is a group class.
    if (isGroup(body) !== isGroup(existing)) {
      if (used || scheduled) {
        throw new ApiError(
          409,
          'capacity_locked',
          '已有预约或排课的课程不能在一对一和小班课之间切换，请新建课程',
        )
      }
    }
    if (body.isTrial && !existing.isTrial) {
      const sold = db
        .select({ id: packageProducts.id })
        .from(packageProducts)
        .where(eq(packageProducts.lessonTypeId, id))
        .get()
      if (sold) throw new ApiError(409, 'trial_has_packages', '有课时包的课程不能设为体验课')
    }
    const was = ownRules(existing.rules)
    const rules = body.rules ?? was
    const row = db
      .update(lessonTypes)
      .set({ ...body, rules })
      .where(eq(lessonTypes.id, id))
      .returning()
      .get()
    // Compared rule by rule, so the order the keys were saved in does not matter.
    if (ruleNames.some((n) => JSON.stringify(was[n]) !== JSON.stringify(rules[n]))) {
      log(c.get('staffId'), {
        action: 'rules.lesson_type',
        summary: rulesLine(body.name, rules),
        target: { kind: 'lesson_type', id },
      })
    }
    const priceWas = lessonPriceLine(existing)
    const priceNow = lessonPriceLine(body)
    if (priceWas !== priceNow) {
      log(c.get('staffId'), {
        action: 'price.lesson_type',
        summary: `${body.name}：${priceWas} 改为 ${priceNow}`,
        target: { kind: 'lesson_type', id },
      })
    }
    return c.json(lessonTypeView(row))
  })

  // Slots

  app.get('/slots', need('view'), (c) => {
    const q = parseQuery(
      c,
      z.object({
        from: instant,
        to: instant,
        coachId: z.coerce.number().int().positive().optional(),
        // A booking being moved, which gives up its table.
        moving: z.coerce.number().int().positive().optional(),
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
            lessonTypeId: bookings.lessonTypeId,
            attendance: bookings.attendance,
            seat: bookings.seat,
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
            .select(personColumns)
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
    const bySlot = new Map<number, typeof live>()
    for (const b of live) bySlot.set(b.slotId, [...(bySlot.get(b.slotId) ?? []), b])
    const noTable = slotsWithoutTable(db, rows, q.moving)
    const now = deps.now()
    return c.json(
      rows
        // A private lesson row left free by a cancel is not a lesson.
        .filter((s) => s.lessonTypeId !== null || bySlot.has(s.id))
        .map((s) => {
          const seats = (bySlot.get(s.id) ?? []).map((b) => ({
            id: b.id,
            status: bookingStatus({ status: b.status, endsAt: s.endsAt }, now),
            lessonTypeId: b.lessonTypeId,
            attendance: b.attendance,
            student: byStudent.get(b.studentId) ?? null,
          }))
          // `booking` is the one lesson in a private slot; a group session lists `bookings`.
          return {
            ...s,
            tableFull: noTable.has(s.id),
            booking: s.lessonTypeId === null ? (seats[0] ?? null) : null,
            bookings: seats,
          }
        }),
    )
  })

  // One lesson for 课程详情: its seats come from GET /bookings?slotId=.
  app.get('/slots/:id', need('view'), (c) => {
    const slot = db
      .select()
      .from(slots)
      .where(eq(slots.id, idParam(c)))
      .get()
    if (!slot) throw notFound('课程')
    const coach = db
      .select({ id: coaches.id, name: coaches.name })
      .from(coaches)
      .where(eq(coaches.id, slot.coachId))
      .get()
    const lessonType = slot.lessonTypeId
      ? (db
          .select({ id: lessonTypes.id, name: lessonTypes.name })
          .from(lessonTypes)
          .where(eq(lessonTypes.id, slot.lessonTypeId))
          .get() ?? null)
      : null
    // A private lesson moved elsewhere leaves its time empty: where it went.
    const moved =
      slot.lessonTypeId === null
        ? db
            .select({ slotId: bookings.slotId, startsAt: bookings.startsAt })
            .from(bookingMoves)
            .innerJoin(bookings, eq(bookings.id, bookingMoves.bookingId))
            .where(
              and(
                eq(bookingMoves.fromCoachId, slot.coachId),
                eq(bookingMoves.fromStartsAt, slot.startsAt),
                eq(bookingMoves.fromEndsAt, slot.endsAt),
                ne(bookings.slotId, slot.id),
              ),
            )
            .orderBy(desc(bookingMoves.id))
            .get()
        : undefined
    return c.json({
      ...slot,
      coach: coach ?? { id: slot.coachId, name: '' },
      lessonType,
      tableFull: slotsWithoutTable(db, [slot]).has(slot.id),
      movedTo: moved ? { slotId: moved.slotId, startsAt: moved.startsAt.toISOString() } : null,
    })
  })

  app.patch('/slots/:id', need('bookings'), async (c) => {
    const body = await parseBody(
      c,
      z.object({
        open: z.boolean().optional(),
        capacity: z.number().int().min(2).max(MAX_CAPACITY).optional(),
      }),
    )
    const id = idParam(c)
    const changed = immediate(db, (tx) => {
      const slot = tx.select().from(slots).where(eq(slots.id, id)).get()
      if (!slot) throw notFound('时段')
      if (slot.lessonTypeId === null) {
        throw new ApiError(409, 'not_group', '私教课的时间由教练排班决定')
      }
      if (body.open && slot.cancelledAt) {
        throw new ApiError(409, 'session_cancelled', '已取消的小班课不能重新开放')
      }
      const capacity =
        body.capacity !== undefined && body.capacity !== slot.capacity
          ? setSessionCapacity(tx, id, body.capacity)
          : null
      if (body.open !== undefined) {
        tx.update(slots).set({ open: body.open }).where(eq(slots.id, id)).run()
      }
      return { slot, capacity }
    })
    if (changed.capacity) {
      const { slot, before } = changed.capacity
      log(c.get('staffId'), {
        action: 'session.update',
        summary: `${await sessionName(slot)}：人数 ${before} 改为 ${body.capacity}`,
        target: { kind: 'slot', id },
      })
    }
    return c.body(null, 204)
  })

  /** A session as the action log names it: time, coach and class. */
  const sessionName = async (slot: {
    startsAt: Date
    coachId: number
    lessonTypeId: number | null
  }) => {
    const coach = db
      .select({ name: coaches.name })
      .from(coaches)
      .where(eq(coaches.id, slot.coachId))
      .get()
    const lessonType = slot.lessonTypeId
      ? db
          .select({ name: lessonTypes.name })
          .from(lessonTypes)
          .where(eq(lessonTypes.id, slot.lessonTypeId))
          .get()
      : undefined
    return `${venueMoment(slot.startsAt, deps.now())} ${coach?.name ?? ''} ${lessonType?.name ?? ''}`
  }

  // 小班课: sessions of a group class the venue schedules.
  app.post('/sessions', need('bookings'), async (c) => {
    const body = await parseBody(
      c,
      z.object({
        lessonTypeId: z.number().int().positive(),
        capacity: z.number().int().min(2).max(MAX_CAPACITY),
        sessions: z
          .array(
            z.object({ coachId: z.number().int().positive(), startsAt: instant, endsAt: instant }),
          )
          .min(1)
          .max(MAX_SLOTS_PER_REQUEST),
      }),
    )
    const { ids, lessonType } = immediate(db, (tx) => createSessions(tx, deps.now(), body))
    const first = body.sessions[0]
    if (first) {
      log(c.get('staffId'), {
        action: 'session.create',
        summary:
          ids.length === 1
            ? `${await sessionName({ ...first, lessonTypeId: lessonType.id })}，${body.capacity} 人`
            : `${lessonType.name} ${ids.length} 节，每节 ${body.capacity} 人，首节 ${venueMoment(first.startsAt, deps.now())}`,
        target: { kind: 'slot', id: ids[0] ?? 0 },
      })
    }
    return c.json({ ids }, 201)
  })

  app.post('/slots/:id/cancel', need('bookings'), async (c) => {
    const { reason } = await parseBody(c, z.object({ reason: z.string().trim().min(1).max(100) }))
    const id = idParam(c)
    const before = db.select().from(slots).where(eq(slots.id, id)).get()
    const cancelled = await cancelSession(deps, id, reason)
    // A repeat of a cancel that went through logs nothing.
    if (before && (!before.cancelledAt || cancelled.length)) {
      log(c.get('staffId'), {
        action: 'session.cancel',
        summary: `${await sessionName(before)}，原因：${before.cancelReason ?? reason}，取消 ${cancelled.length} 人的预约`,
        target: { kind: 'slot', id },
      })
    }
    return c.body(null, 204)
  })

  app.delete('/slots/:id', need('bookings'), (c) => {
    const id = idParam(c)
    immediate(db, (tx) => {
      const slot = tx.select().from(slots).where(eq(slots.id, id)).get()
      if (!slot) throw notFound('时段')
      if (slot.lessonTypeId === null) {
        throw new ApiError(409, 'not_group', '私教课的时间由教练排班决定')
      }
      const used = tx
        .select({ id: bookings.id })
        .from(bookings)
        .where(eq(bookings.slotId, id))
        .get()
      if (used) throw new ApiError(409, 'slot_has_bookings', '该时段有预约记录，只能关闭，不能删除')
      tx.delete(slots).where(eq(slots.id, id)).run()
    })
    return c.body(null, 204)
  })

  // Bookings

  app.get('/bookings', need('view'), (c) => {
    const q = parseQuery(
      c,
      z.object({
        from: instant.optional(),
        to: instant.optional(),
        studentId: z.coerce.number().int().positive().optional(),
        coachId: z.coerce.number().int().positive().optional(),
        lessonTypeId: z.coerce.number().int().positive().optional(),
        // The seats of one lesson, or one booking, for 课程详情.
        slotId: z.coerce.number().int().positive().optional(),
        id: z.coerce.number().int().positive().optional(),
        status: bookingStatusParam.optional(),
        order: z.enum(['asc', 'desc']).default('asc'),
        // Only bookings with no attendance marked, for the overview's 待签到.
        unmarked: flag,
        q: searchParam,
        pay: bookingPayParam.optional(),
        source: sourceParam.optional(),
        ...pageParams,
      }),
    )
    const now = deps.now()
    const where = and(
      bookingWhere(q, now),
      q.slotId ? eq(bookings.slotId, q.slotId) : undefined,
      q.id ? eq(bookings.id, q.id) : undefined,
    )
    const count = db
      .select({ n: countAll })
      .from(bookings)
      .innerJoin(slots, eq(slots.id, bookings.slotId))
      .where(where)
      .get()
    setTotal(c, count?.n ?? 0)
    const rows = db
      .select({ booking: bookings })
      .from(bookings)
      .innerJoin(slots, eq(slots.id, bookings.slotId))
      .where(where)
      .orderBy(
        q.order === 'asc' ? asc(bookings.startsAt) : desc(bookings.startsAt),
        asc(bookings.id),
      )
      .limit(q.limit)
      .offset(q.offset)
      .all()
      .map((r) => r.booking)
    const views = bookingViews(db, rows, now)
    const people = new Map(
      rows.length
        ? db
            .select(personColumns)
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
    return c.json(
      views.map((v, i) => ({
        ...v,
        student: people.get(rows[i]?.studentId ?? 0) ?? null,
        coachNote: rows[i]?.coachNote ?? '',
        bookedBy: bookedBy.get(rows[i]?.bookedByStaffId ?? 0) ?? null,
      })),
    )
  })

  const frontDeskTarget = {
    studentId: z.number().int().positive(),
    ...targetFields,
    lessonTypeId: z.number().int().positive(),
    // A private lesson outside the coach's 排班, which the desk agreed with the coach.
    anyTime: z.boolean().default(false),
  }

  app.post('/bookings/quote', need('bookings'), async (c) => {
    const body = await parseBody(c, z.object(frontDeskTarget).refine(oneTarget, '请选择上课时间'))
    return c.json(frontDeskQuote(deps, { ...body, target: toTarget(body) }))
  })

  // 代约: the front desk books a lesson for a student.
  app.post('/bookings', need('bookings'), async (c) => {
    const body = await parseBody(
      c,
      z
        .discriminatedUnion('payWith', [
          z.object({
            ...frontDeskTarget,
            payWith: z.literal('package'),
            expectedPackageId: z.number().int().positive().optional(),
          }),
          z.object({
            ...frontDeskTarget,
            payWith: z.literal('offline'),
            amount: fen,
            method: offlineMethod.optional(),
            note: z.string().trim().max(100).default(''),
          }),
        ])
        .refine(oneTarget, '请选择上课时间'),
    )
    const listedPriceOnly = !can(c.get('roles'), 'manage')
    return c.json(
      bookForStudent(deps, c.get('staffId'), { ...body, target: toTarget(body), listedPriceOnly }),
      201,
    )
  })

  // The 签到码 dialog: the venue name it prints, and whether students can scan it at all.
  app.get('/check-in-code', need('attendance'), (c) => {
    const settings = getSettings(db)
    return c.json({
      venueName: settings.venue.name,
      selfCheckIn: settings.attendance.selfCheckIn,
    })
  })

  // The front desk's 签到 list: every student's lesson on one venue day.
  app.get('/front-desk', need('attendance'), (c) => {
    const q = parseQuery(c, z.object({ date: dateKey.optional() }))
    return c.json(frontDeskLessons(deps, q.date ?? venueDateKey(deps.now())))
  })

  app.put('/bookings/:id/attendance', need('attendance'), async (c) => {
    const { attendance } = await parseBody(
      c,
      z.object({ attendance: z.enum(['attended', 'no_show']).nullable() }),
    )
    const id = idParam(c)
    // Also logged when the desk takes over the student's or coach's own mark.
    if (setAttendance(deps, id, attendance, { staffId: c.get('staffId') })) {
      const { what, studentId } = describeBooking(db, id, deps.now())
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

  app.post('/bookings/:id/cancel', need('bookings'), async (c) => {
    const { reason } = await parseBody(c, z.object({ reason: z.string().trim().min(1).max(100) }))
    const id = idParam(c)
    const cancelled = await cancelBooking(deps, id, 'venue', { reason })
    const booking = db.select().from(bookings).where(eq(bookings.id, id)).get()
    // A repeat cancelled nothing, and a payment that landed meanwhile may have expired the
    // booking instead.
    if (!cancelled || booking?.status !== 'cancelled' || booking.cancelledBy !== 'venue') {
      return c.body(null, 204)
    }
    const { what, studentId } = describeBooking(db, id, deps.now())
    const outcome = cancelOutcome(db, id)
    log(c.get('staffId'), {
      action: 'booking.cancel',
      summary: `${what}，原因：${reason}${outcome.text}`,
      amount: outcome.refunded,
      studentId,
      target: { kind: 'booking', id },
    })
    return c.body(null, 204)
  })

  app.post('/bookings/:id/move', need('bookings'), async (c) => {
    const body = await parseBody(
      c,
      z
        .object({ ...targetFields, anyTime: z.boolean().default(false) })
        .refine(oneTarget, '请选择上课时间'),
    )
    const id = idParam(c)
    const before = describeBooking(db, id, deps.now())
    // A repeat of a move that already happened logs nothing.
    const moved = moveBooking(deps, id, toTarget(body), 'venue', { anyTime: body.anyTime })
    if (moved === 'agreed') {
      log(c.get('staffId'), {
        action: 'booking.move',
        summary: `${before.what}：已与教练确认在排班外上课`,
        studentId: before.studentId,
        target: { kind: 'booking', id },
      })
    } else if (moved) {
      const to = db
        .select({ startsAt: slots.startsAt, coach: coaches.name })
        .from(bookings)
        .innerJoin(slots, eq(slots.id, bookings.slotId))
        .innerJoin(coaches, eq(coaches.id, slots.coachId))
        .where(eq(bookings.id, id))
        .get()
      log(c.get('staffId'), {
        action: 'booking.move',
        summary: `${before.what} 改到 ${to ? `${venueMoment(to.startsAt, deps.now())} ${to.coach}` : ''}`,
        studentId: before.studentId,
        target: { kind: 'booking', id },
      })
    }
    return c.body(null, 204)
  })

  // 课后点评

  app.get('/feedback', need('bookings'), (c) => {
    const q = parseQuery(
      c,
      z.object({
        from: instant.optional(),
        to: instant.optional(),
        coachId: z.coerce.number().int().positive().optional(),
        studentId: z.coerce.number().int().positive().optional(),
        lessonTypeId: z.coerce.number().int().positive().optional(),
        slotId: z.coerce.number().int().positive().optional(),
        q: searchParam,
        state: z.enum(feedbackStates).optional(),
        ...pageParams,
      }),
    )
    setTotal(c, adminFeedbackCount(db, q))
    return c.json(adminFeedback(db, q))
  })

  // Lesson photos as staff see them: also of feedback the student does not see, and to those who
  // moderate feedback, of feedback the venue hid. Those are not kept on the computer.
  app.get('/feedback-photos/:name', need('view'), (c) => {
    const name = c.req.param('name')
    const viewer = can(c.get('roles'), 'bookings') ? 'moderator' : 'staff'
    const photo = /^[\w-]+\.(jpg|png|webp)$/.test(name) ? readLessonPhoto(deps, name, viewer) : null
    if (!photo) throw notFound('照片')
    return c.body(photo.data, 200, {
      'Content-Type': photo.type,
      'Cache-Control': photo.restricted ? 'private, no-store' : 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    })
  })

  app.put('/feedback/:id/hidden', need('bookings'), async (c) => {
    const { hidden } = await parseBody(c, z.object({ hidden: z.boolean() }))
    const id = idParam(c)
    const changed = setFeedbackHidden(deps, id, c.get('staffId'), hidden)
    const [item] = adminFeedback(db, { ids: [id] })
    if (!item) throw notFound('点评')
    // A repeat changed nothing and logs nothing.
    if (changed) {
      const { what, studentId } = describeBooking(db, item.bookingId, deps.now())
      log(c.get('staffId'), {
        action: hidden ? 'feedback.hide' : 'feedback.show',
        summary: `${what} 的课后点评`,
        studentId,
        target: { kind: 'booking', id: item.bookingId },
      })
    }
    return c.json(item)
  })

  // Package products

  app.get('/package-products', need('view'), (c) =>
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
      deps.now(),
    )

  app.post('/package-products', need('manage'), async (c) => {
    const body = await parseBody(c, productBody)
    checkProduct(body)
    const row = db
      .insert(packageProducts)
      .values({ ...body, sort: nextSort(db, packageProducts) })
      .returning()
      .get()
    log(c.get('staffId'), {
      action: 'price.product',
      summary: `新建课时包 ${row.name}，${productPriceLine(body)}`,
      target: { kind: 'product', id: row.id },
    })
    return c.json(row, 201)
  })

  app.put('/package-products/:id', need('manage'), async (c) => {
    const id = idParam(c)
    const body = await parseBody(c, productBody)
    checkProduct(body)
    // A package is created from the product when its payment lands, so its terms cannot change
    // while someone is paying for it. Price and sale edits are fine: the order already has its amount.
    const existing = db.select().from(packageProducts).where(eq(packageProducts.id, id)).get()
    if (!existing) throw notFound('课时包')
    checkVersion(c, existing)
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

  app.get('/students', need('view'), (c) => {
    const { q, expiring, desk, lessons, deleted, tester, from, to, limit, before, offset } =
      parseQuery(
        c,
        z.object({
          q: z.string().trim().max(30).default(''),
          // 即将到期: students with lessons left on a package that expires soon, soonest first.
          expiring: flag,
          // Front-desk students who have not linked their WeChat yet.
          desk: flag,
          // Students with lessons left on a package they can still use.
          lessons: flag,
          deleted: flag,
          tester: flag,
          // When they joined.
          from: instant.optional(),
          to: instant.optional(),
          // Pages of the plain list, newest first: by position, or up to `limit` students older
          // than `before`.
          limit: z.coerce.number().int().min(1).max(500).default(PAGE_SIZE),
          before: z.coerce.number().int().positive().optional(),
          offset: z.coerce.number().int().min(0).default(0),
        }),
      )
    const search = studentSearch(q)
    const columns = {
      id: students.id,
      name: students.name,
      phone: students.phone,
      tester: students.tester,
      deletedAt: students.deletedAt,
      createdAt: students.createdAt,
      // A deleted account is bound to no one: its openid is a placeholder.
      wechatBound: sql<boolean>`(not ${unlinkedSql} and ${students.deletedAt} is null)`.mapWith(
        Boolean,
      ),
      // Someone else has the same phone: the desk tells them apart by 学员编号.
      phoneShared:
        sql<boolean>`students.phone != '' and exists (select 1 from students as other where other.phone = students.phone and other.id != students.id and other.deleted_at is null)`.mapWith(
          Boolean,
        ),
    }
    if (!expiring) {
      const where = and(
        search,
        desk ? unlinkedSql : undefined,
        lessons
          ? exists(
              db
                .select({ id: packages.id })
                .from(packages)
                .where(
                  and(
                    eq(packages.studentId, students.id),
                    eq(packages.status, 'active'),
                    gt(packages.lessonsRemaining, 0),
                    gt(packages.expiresAt, deps.now()),
                  ),
                ),
            )
          : undefined,
        // As with 即将到期, an account deleted keeps its packages but is left out.
        lessons ? isNull(students.deletedAt) : undefined,
        deleted ? isNotNull(students.deletedAt) : undefined,
        tester ? eq(students.tester, true) : undefined,
        from ? gte(students.createdAt, from) : undefined,
        to ? lt(students.createdAt, to) : undefined,
      )
      setTotal(c, db.select({ n: countAll }).from(students).where(where).get()?.n ?? 0)
      return c.json(
        db
          .select(columns)
          .from(students)
          .where(and(where, before ? lt(students.id, before) : undefined))
          .orderBy(desc(students.id))
          .limit(limit)
          .offset(before ? 0 : offset)
          .all(),
      )
    }
    const now = deps.now()
    const rows = db
      .select({
        ...columns,
        packageId: packages.id,
        packageName: packages.name,
        lessonsRemaining: packages.lessonsRemaining,
        expiresAt: packages.expiresAt,
        // The expiry message for its current expiry date, once tried.
        notice: sql<
          'sent' | 'refused' | null
        >`(select ${packageNotices.result} from ${packageNotices} where ${packageNotices.packageId} = ${packages.id} and ${packageNotices.kind} = 'expiring' and ${packageNotices.expiresAt} = ${packages.expiresAt} and ${packageNotices.result} in ('sent', 'refused'))`,
      })
      .from(packages)
      .innerJoin(students, eq(students.id, packages.studentId))
      .where(
        and(
          search,
          isNull(students.deletedAt),
          eq(packages.status, 'active'),
          gt(packages.lessonsRemaining, 0),
          gt(packages.expiresAt, now),
          lte(packages.expiresAt, new Date(now.getTime() + EXPIRING_SOON_MS)),
        ),
      )
      .orderBy(asc(packages.expiresAt), asc(packages.id))
      .all()
    // One row per student, for the package that expires first, with how many more do.
    const byStudent = new Map<number, (typeof rows)[number] & { more: number }>()
    for (const r of rows) {
      const first = byStudent.get(r.id)
      if (first) first.more++
      else byStudent.set(r.id, { ...r, more: 0 })
    }
    setTotal(c, byStudent.size)
    return c.json(
      [...byStudent.values()]
        .slice(offset, offset + limit)
        .map(({ packageId, packageName, lessonsRemaining, expiresAt, notice, more, ...s }) => ({
          ...s,
          expiring: {
            packageId,
            name: packageName,
            lessonsRemaining,
            expiresAt,
            notice,
            more,
          },
        })),
    )
  })

  app.get('/students/:id', need('view'), (c) => {
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
      wechatBound: wechatOpenid(student.openid) !== null,
      samePhone: student.phone && !student.deletedAt ? samePhone(db, student.phone, id) : [],
      profile: studentProfile(db, id, now),
      feedback: student.deletedAt ? [] : studentFeedback(db, id),
      packages: packageViews(db, pkgRows, now),
      bookings: bookingViews(db, bookingRows, now),
    })
  })

  // 前台建档: a student who has not used the mini program yet. `force` adds them even though
  // another student has the same phone.
  app.post('/students', need('students'), async (c) => {
    const body = await parseBody(
      c,
      z.object({
        name: z.string().trim().min(1, '请填写姓名').max(20),
        phone: z
          .string()
          .trim()
          .regex(/^1\d{10}$/, '请填写正确的手机号'),
        force: z.boolean().default(false),
      }),
    )
    return c.json(createDeskStudent(deps, c.get('staffId'), body), 201)
  })

  // A one-time code, with its 小程序码 when WeChat is set up, for the student to link their WeChat.
  app.post('/students/:id/bind-code', need('students'), async (c) => {
    const id = idParam(c)
    const { code, expiresAt } = newStudentBindCode(deps, id)
    let qr: string | null = null
    if (deps.miniCode) {
      try {
        const image = await deps.miniCode(code, 'pages/link/index')
        qr = `data:image/jpeg;base64,${Buffer.from(image).toString('base64')}`
      } catch (e) {
        // The code can still be typed in.
        deps.log('mini code failed', { studentId: id, error: (e as Error).message })
      }
    }
    return c.json({ code, expiresAt, qr }, 201)
  })

  // For the bind dialog, which waits for the student to use the code.
  app.get('/students/:id/bound', need('view'), (c) => {
    const s = db
      .select({ openid: students.openid, deletedAt: students.deletedAt })
      .from(students)
      .where(eq(students.id, idParam(c)))
      .get()
    if (!s) throw notFound('学员')
    if (s.deletedAt) throw accountDeleted()
    return c.json({ wechatBound: !isDeskOpenid(s.openid) })
  })

  app.delete('/students/:id', need('manage'), (c) => {
    deleteDeskStudent(deps, c.get('staffId'), idParam(c))
    return c.body(null, 204)
  })

  app.put('/students/:id/profile', need('students'), async (c) => {
    const body = await parseBody(c, profileInput)
    const id = idParam(c)
    const changed = saveStudentProfile(deps, id, body, { staffId: c.get('staffId') }, (current) =>
      checkVersion(c, current),
    )
    // Field names only: the log keeps no copy of what the venue wrote about the student.
    if (changed.length) {
      log(c.get('staffId'), {
        action: 'student.update',
        summary: `修改档案：${changed.join('、')}`,
        studentId: id,
        target: { kind: 'student', id },
      })
    }
    return c.json(studentProfile(db, id, deps.now()))
  })

  app.patch('/students/:id', need('students'), async (c) => {
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
    // Testers see admin-only lesson types, so only 管理员 may make one.
    if (body.tester !== undefined && !can(c.get('roles'), 'manage')) {
      throw new ApiError(403, 'forbidden', '没有权限，请联系管理员')
    }
    const id = idParam(c)
    const before = db.select().from(students).where(eq(students.id, id)).get()
    if (!before) throw notFound('学员')
    if (before.deletedAt) throw accountDeleted()
    // The desk edits the name and phone the student also keeps in the mini program.
    checkVersion(c, { name: before.name, phone: before.phone })
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

  app.get('/packages/:id/ledger', need('view'), (c) =>
    c.json(
      db
        .select()
        .from(packageLedger)
        .where(eq(packageLedger.packageId, idParam(c)))
        .orderBy(desc(packageLedger.id))
        .all(),
    ),
  )

  app.post('/packages/:id/grant', need('manage'), async (c) => {
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

  app.post('/packages/:id/extend', need('manage'), async (c) => {
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

  // A package sold at the front desk, refunded there: the suggested amount for the dialog.
  app.get('/packages/:id/desk-refund', need('finance'), (c) =>
    c.json(deskRefundQuote(deps, idParam(c))),
  )

  // Refunds the unused lessons of a package sold at the front desk, handed back there at once.
  app.post('/packages/:id/desk-refund', need('finance'), async (c) => {
    const { amount } = await parseBody(c, z.object({ amount: fen.min(1) }))
    const id = idParam(c)
    // The amount was worked out from the package as staff saw it.
    if (!c.req.header('If-Match')) throw new ApiError(428, 'version_required', '请刷新后再操作')
    const done = refundDeskPackage(deps, id, amount, (current) =>
      checkVersion(c, packageViews(db, [current], deps.now())[0]),
    )
    const pkg = db.select().from(packages).where(eq(packages.id, id)).get()
    log(c.get('staffId'), {
      action: 'package.refund',
      summary: `课时包「${pkg?.name}」前台退款 ${yuan(amount)}`,
      amount,
      studentId: pkg?.studentId,
      target: { kind: 'package', id },
    })
    return c.json({ refundId: done.refundId })
  })

  app.post('/packages/offline-sale', need('students'), async (c) => {
    const body = await parseBody(
      c,
      z.object({
        studentId: z.number().int().positive(),
        productId: z.number().int().positive(),
        amount: fen,
        method: offlineMethod,
        note: z.string().trim().max(100).default(''),
        /** What the dialog showed the package grants. */
        expectedTerms: packageTermsSchema.optional(),
      }),
    )
    const listedPriceOnly = !can(c.get('roles'), 'manage')
    const packageId = sellPackageOffline(deps, { ...body, listedPriceOnly })
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

  app.get('/orders', need('finance'), (c) => {
    const q = parseQuery(
      c,
      z.object({
        status: z.enum(['pending', 'paid', 'closed']).optional(),
        studentId: z.coerce.number().int().positive().optional(),
        // When the order was placed.
        from: instant.optional(),
        to: instant.optional(),
        kind: orderKindParam.optional(),
        provider: providerParam.optional(),
        q: searchParam,
        // 支付异常 not yet handled, as the overview counts them.
        anomaly: flag,
        ...pageParams,
        before: z.coerce.number().int().positive().optional(),
      }),
    )
    const where = orderWhere(q)
    setTotal(c, db.select({ n: countAll }).from(orders).where(where).get()?.n ?? 0)
    const rows = db
      .select({
        order: orders,
        student: personColumns,
      })
      .from(orders)
      .innerJoin(students, eq(students.id, orders.studentId))
      .where(and(where, q.before ? lt(orders.id, q.before) : undefined))
      .orderBy(desc(orders.id))
      .limit(q.limit)
      .offset(q.before ? 0 : q.offset)
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

  // Staff sorted out a flagged payment (refunded it on the merchant platform, say).
  app.post('/orders/:id/anomaly-handled', need('finance'), async (c) => {
    const id = idParam(c)
    const { note } = await parseBody(c, z.object({ note: z.string().trim().min(1).max(100) }))
    const order = db.select().from(orders).where(eq(orders.id, id)).get()
    if (!order) throw notFound('订单')
    if (!order.anomaly) throw new ApiError(409, 'no_anomaly', '该订单没有支付异常')
    // A repeat of a mark already made.
    if (order.anomalyHandledAt) return c.body(null, 204)
    db.update(orders)
      .set({ anomalyHandledAt: deps.now(), anomalyNote: note })
      .where(and(eq(orders.id, id), isNull(orders.anomalyHandledAt)))
      .run()
    log(c.get('staffId'), {
      action: 'order.anomaly_handled',
      summary: `支付异常已处理：订单 ${order.outTradeNo}，${note}`,
      studentId: order.studentId,
      target: { kind: 'order', id },
    })
    return c.body(null, 204)
  })

  app.get('/refunds', need('finance'), (c) => {
    const q = parseQuery(
      c,
      z.object({
        status: z
          .enum(['requested', 'pending', 'processing', 'succeeded', 'failed', 'rejected'])
          .optional(),
        // When the refund was asked for.
        from: instant.optional(),
        to: instant.optional(),
        provider: providerParam.optional(),
        q: searchParam,
        // 退款异常: WeChat Pay could not send the money back, as the overview counts them.
        abnormal: flag,
        // 待核对: settled outside the system, then reported otherwise by WeChat Pay.
        check: flag,
        ...pageParams,
        before: z.coerce.number().int().positive().optional(),
      }),
    )
    const where = refundWhere(q)
    setTotal(
      c,
      db
        .select({ n: countAll })
        .from(refunds)
        .innerJoin(orders, eq(orders.id, refunds.orderId))
        .where(where)
        .get()?.n ?? 0,
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
        student: personColumns,
      })
      .from(refunds)
      .innerJoin(orders, eq(orders.id, refunds.orderId))
      .innerJoin(students, eq(students.id, orders.studentId))
      .where(and(where, q.before ? lt(refunds.id, q.before) : undefined))
      .orderBy(desc(refunds.id))
      .limit(q.limit)
      .offset(q.before ? 0 : q.offset)
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
    // The lessons a package had left when it was refunded: once refunded, it shows none.
    const lessonsRefunded = new Map(
      packageIds.length
        ? db
            .select({ packageId: packageLedger.packageId, delta: packageLedger.delta })
            .from(packageLedger)
            .where(
              and(inArray(packageLedger.packageId, packageIds), eq(packageLedger.kind, 'refund')),
            )
            .all()
            .map((l) => [l.packageId, -l.delta])
        : [],
    )
    const orderIds = [...new Set(rows.map((r) => r.order.id))]
    // A refund on an order with an invoice means the invoice may need voiding in the tax system.
    const invoiced = new Map(
      orderIds.length
        ? db
            .select({ orderId: invoices.orderId, status: invoices.status })
            .from(invoices)
            .where(
              and(
                inArray(invoices.orderId, orderIds),
                inArray(invoices.status, ['requested', 'issued']),
              ),
            )
            .all()
            .map((i) => [i.orderId, i.status])
        : [],
    )
    return c.json(
      rows.map((r) => ({
        ...r.refund,
        order: r.order,
        student: r.student,
        package: r.refund.packageId ? (pkgs.get(r.refund.packageId) ?? null) : null,
        // Not on a request still open or turned down, which left the package as it was.
        lessonsRefunded:
          r.refund.packageId && r.refund.status !== 'requested' && r.refund.status !== 'rejected'
            ? (lessonsRefunded.get(r.refund.packageId) ?? null)
            : null,
        invoiceStatus: invoiced.get(r.order.id) ?? null,
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

  const refundOutcome = (id: number) => {
    const row = db
      .select({ status: refunds.status, failure: refunds.failure })
      .from(refunds)
      .where(eq(refunds.id, id))
      .get()
    if (!row) throw notFound('退款')
    return row
  }

  app.post('/refunds/:id/approve', need('finance'), async (c) => {
    const { amount } = await parseBody(c, z.object({ amount: fen.min(1) }))
    const id = idParam(c)
    if (await approvePackageRefund(deps, id, amount)) {
      const r = refundContext(id)
      log(c.get('staffId'), {
        action: 'refund.approve',
        summary: `同意${r.what}退款 ${yuan(amount)}`,
        amount,
        studentId: r.studentId,
        target: { kind: 'refund', id },
      })
    }
    // WeChat can refuse at once (merchant balance too low), so the page says how it went.
    return c.json(refundOutcome(id))
  })

  app.post('/refunds/:id/reject', need('finance'), async (c) => {
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

  app.post('/refunds/:id/paid-back', need('finance'), (c) => {
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

  // A failed WeChat Pay refund staff settled outside the system, in cash or on the merchant
  // platform.
  app.post('/refunds/:id/settled', need('finance'), async (c) => {
    const { how, note } = await parseBody(
      c,
      z.object({
        how: z.enum(['platform', 'offline']),
        note: z.string().trim().min(1, '请填写处理说明').max(100),
      }),
    )
    const id = idParam(c)
    const done = await settleFailedRefund(deps, id, how, note)
    if (done === 'settled' || done === 'updated') {
      const r = refundContext(id)
      log(c.get('staffId'), {
        action: done === 'settled' ? 'refund.settled' : 'refund.synced',
        summary:
          done === 'settled'
            ? `${r.what}退款 ${yuan(r.amount)} 已另行退款（${REFUND_SETTLE_WAYS[how]}）：${note}`
            : `${r.what}退款 ${yuan(r.amount)} 状态已按微信支付更新`,
        amount: r.amount,
        studentId: r.studentId,
        target: { kind: 'refund', id },
      })
    }
    const now = db
      .select({
        status: refunds.status,
        failure: refunds.failure,
        abnormal: refunds.abnormal,
        note: refunds.settledNote,
        how: refunds.settledHow,
      })
      .from(refunds)
      .where(eq(refunds.id, id))
      .get()
    // Settled only if the refund ends up settled with this note: a retry or WeChat Pay may have
    // got there first, and then it is as they left it.
    const settled = now?.status === 'succeeded' && now.note === note && now.how === how
    return c.json({
      status: now?.status,
      failure: now?.failure ?? null,
      settled,
      message: settled
        ? null
        : now?.status === 'succeeded'
          ? now.note !== null
            ? '该退款已标为另行退款'
            : '微信支付已退款，无需另行退款'
          : now?.status === 'pending' || (now?.status === 'processing' && !now.abnormal)
            ? '退款已在微信支付处理中，无需另行退款'
            : '退款状态已变更，请刷新后查看',
    })
  })

  app.post('/refunds/:id/retry', need('finance'), async (c) => {
    const id = idParam(c)
    const done = await retryRefund(deps, id)
    if (done) {
      const r = refundContext(id)
      // `updated`: WeChat Pay already had it as done or on its way, so nothing was sent again.
      log(c.get('staffId'), {
        action: done === 'resent' ? 'refund.retry' : 'refund.synced',
        summary:
          done === 'resent'
            ? `重试${r.what}退款 ${yuan(r.amount)}`
            : `${r.what}退款 ${yuan(r.amount)} 状态已按微信支付更新`,
        amount: r.amount,
        studentId: r.studentId,
        target: { kind: 'refund', id },
      })
    }
    return c.json({ ...refundOutcome(id), resent: done === 'resent' })
  })

  // Invoices

  app.get('/invoices', need('finance'), (c) => {
    const q = parseQuery(
      c,
      z.object({
        status: z.enum(['requested', 'issued', 'rejected']).optional(),
        flagged: flag,
        studentId: z.coerce.number().int().positive().optional(),
        // When the invoice was asked for.
        from: instant.optional(),
        to: instant.optional(),
        titleKind: titleKindParam.optional(),
        q: searchParam,
        ...pageParams,
      }),
    )
    const { rows, total } = adminInvoices(db, q)
    setTotal(c, total)
    return c.json(rows)
  })

  app.post('/invoices/:id/issue', need('finance'), async (c) => {
    const id = idParam(c)
    const form = await c.req.formData().catch(() => null)
    const file = form?.get('file')
    if (!(file instanceof File)) throw new ApiError(400, 'no_file', '请选择发票 PDF')
    const replaced = issueInvoice(
      deps,
      c.get('staffId'),
      id,
      new Uint8Array(await file.arrayBuffer()),
    )
    const view = adminInvoice(db, id)
    const { what, studentId } = invoiceLabel(db, id)
    log(c.get('staffId'), {
      action: 'invoice.issue',
      summary: replaced ? `重新上传${what}的发票` : `${what}开票 ${yuan(view.amount)}`,
      amount: replaced ? null : view.amount,
      studentId,
      target: { kind: 'invoice', id },
    })
    return c.json(view)
  })

  app.post('/invoices/:id/reject', need('finance'), async (c) => {
    const { reason } = await parseBody(c, z.object({ reason: z.string().trim().min(1).max(100) }))
    const id = idParam(c)
    if (rejectInvoice(deps, c.get('staffId'), id, reason)) {
      const { what, studentId } = invoiceLabel(db, id)
      log(c.get('staffId'), {
        action: 'invoice.reject',
        summary: `拒绝${what}的开票申请：${reason}`,
        studentId,
        target: { kind: 'invoice', id },
      })
    }
    return c.json(adminInvoice(db, id))
  })

  app.post('/invoices/:id/refund-seen', need('finance'), (c) => {
    const id = idParam(c)
    if (markRefundSeen(deps, id)) {
      const { what, studentId } = invoiceLabel(db, id)
      log(c.get('staffId'), {
        action: 'invoice.refund_seen',
        summary: `${what}开票后的退款已处理`,
        studentId,
        target: { kind: 'invoice', id },
      })
    }
    return c.json(adminInvoice(db, id))
  })

  app.get('/invoices/:id/pdf', need('finance'), (c) => {
    const id = idParam(c)
    return c.body(invoicePdf(deps, id), 200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="invoice-${id}.pdf"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    })
  })

  // Exports

  const exportStatuses: Record<ExportKind, [string, ...string[]] | null> = {
    students: null,
    bookings: ['pending_payment', 'confirmed', 'completed', 'cancelled', 'expired'],
    orders: ['pending', 'paid', 'closed'],
    refunds: ['requested', 'pending', 'processing', 'succeeded', 'failed', 'rejected'],
    packages: ['active', 'expired', 'used_up', 'refund_requested', 'refunded'],
    invoices: ['requested', 'issued', 'rejected'],
  }

  app.get('/exports/:kind', need('finance'), (c) => {
    const kind = c.req.param('kind')
    if (!Object.hasOwn(exportKinds, kind)) throw notFound('导出类型')
    const k = kind as ExportKind
    const statuses = exportStatuses[k]
    const q = parseQuery(
      c,
      z.object({
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        status: statuses ? z.enum(statuses).optional() : z.undefined().optional(),
        // The filters of the export's list, each only where that list has it.
        coachId: only(k === 'bookings', id),
        lessonTypeId: only(k === 'bookings', id),
        q: only(k !== 'packages', searchParam),
        pay: only(k === 'bookings', bookingPayParam.optional()),
        source: only(k === 'bookings', sourceParam.optional()),
        kind: only(k === 'orders', orderKindParam.optional()),
        provider: only(k === 'orders' || k === 'refunds', providerParam.optional()),
        titleKind: only(k === 'invoices', titleKindParam.optional()),
        flagged: only(k === 'invoices', flag),
        unmarked: only(k === 'bookings', flag),
      }),
    )
    const { csv, rows } = buildExport(db, k, q, deps.now())
    log(c.get('staffId'), {
      action: 'data.export',
      summary: `${describeExport(db, k, q)}，${rows} 行`,
    })
    const name = `${exportKinds[k]}-${q.from}-${q.to}.csv`
    return c.body(csv, 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${k}-${q.from}-${q.to}.csv"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Cache-Control': 'private, no-store',
    })
  })

  // Hand-arranged order of the coach, category, lesson type, package and banner lists.
  app.put('/order/:list', need('manage'), async (c) => {
    const list = c.req.param('list')
    if (!Object.hasOwn(orderedLists, list)) throw notFound('列表')
    const { ids } = await parseBody(c, orderBody)
    saveOrder(db, orderedLists[list as keyof typeof orderedLists], ids)
    return c.body(null, 204)
  })

  // Banners and uploads

  app.get('/banners', need('manage'), (c) =>
    c.json(db.select().from(banners).orderBy(asc(banners.sort), asc(banners.id)).all()),
  )

  app.post('/banners', need('manage'), async (c) => {
    const body = await parseBody(c, bannerBody)
    const row = immediate(db, (tx) => {
      checkLinkTarget(tx, body)
      return tx
        .insert(banners)
        .values({ ...body, sort: nextSort(tx, banners) })
        .returning()
        .get()
    })
    return c.json(row, 201)
  })

  app.put('/banners/:id', need('manage'), async (c) => {
    const body = await parseBody(c, bannerBody)
    const id = idParam(c)
    const row = immediate(db, (tx) => {
      const current = tx.select().from(banners).where(eq(banners.id, id)).get()
      if (!current) throw notFound('轮播图')
      checkVersion(c, current)
      checkLinkTarget(tx, body)
      return tx.update(banners).set(body).where(eq(banners.id, id)).returning().get()
    })
    return c.json(row)
  })

  app.delete('/banners/:id', need('manage'), (c) => {
    const changed = db
      .delete(banners)
      .where(eq(banners.id, idParam(c)))
      .run()
    if (changed.changes === 0) throw notFound('轮播图')
    return c.body(null, 204)
  })

  app.post('/uploads', need('manage'), async (c) => {
    const form = await c.req.formData().catch(() => null)
    const file = form?.get('file')
    if (!(file instanceof File)) throw new ApiError(400, 'no_file', '请选择图片')
    if (file.size > 2 * 1024 * 1024) throw new ApiError(400, 'too_large', '图片不能超过 2MB')
    // What the file is, from its first bytes rather than the type the browser sent.
    const data = Buffer.from(await file.arrayBuffer())
    const ext = imageType(data)
    if (!ext) throw new ApiError(400, 'bad_type', '只支持 JPG、PNG、WebP 图片')
    const name = `${Date.now()}-${randomBytes(6).toString('hex')}.${ext}`
    mkdirSync(deps.uploadsDir, { recursive: true })
    // Public images: no GPS position or camera details go with them.
    writeFileSync(join(deps.uploadsDir, name), stripImageMetadata(data, ext))
    return c.json({ url: `/api/uploads/${name}` }, 201)
  })

  app.get('/reports/monthly', need('finance'), (c) => {
    const { month } = parseQuery(c, z.object({ month: monthKey }))
    return c.json(monthlyReport(deps, month))
  })

  const monthParam = (c: { req: { param: (name: string) => string } }) => {
    const month = c.req.param('month')
    if (!monthKey.safeParse(month).success) throw new ApiError(400, 'invalid_query', '月份无效')
    return month
  }

  /** Fixes a month's coach pay. The body carries the version of the amounts staff looked at. */
  app.post('/reports/pay-months/:month/confirm', need('finance'), async (c) => {
    const month = monthParam(c)
    const { version } = await parseBody(c, z.object({ version: z.string().min(1).max(20) }))
    const done = immediate(db, (tx) =>
      confirmMonth(tx, month, version, c.get('staffId'), deps.now()),
    )
    if (done) {
      log(c.get('staffId'), {
        action: 'pay.confirm',
        summary: `确认 ${month} 课时费，${done.coaches} 位教练，合计 ${yuan(done.total)}`,
        amount: done.total,
      })
    }
    return c.json(monthlyReport(deps, month))
  })

  /** Reopens the last confirmed month. */
  app.delete('/reports/pay-months/:month', need('manage'), (c) => {
    const month = monthParam(c)
    if (immediate(db, (tx) => unconfirmMonth(tx, month))) {
      log(c.get('staffId'), { action: 'pay.unconfirm', summary: `撤销 ${month} 课时费确认` })
    }
    return c.json(monthlyReport(deps, month))
  })

  app.get('/reports/stats', need('finance'), (c) => {
    const { from, to } = parseQuery(c, z.object({ from: dateKey, to: dateKey }))
    return c.json(statsReport(deps, from, to))
  })

  app.get('/reports/dormant', need('finance'), (c) => {
    const { limit, offset } = parseQuery(c, z.object(pageParams))
    const all = dormantStudents(deps)
    setTotal(c, all.length)
    return c.json(all.slice(offset, offset + limit))
  })

  // Dashboard numbers for the admin home page.
  app.get('/summary', need('view'), (c) => {
    const now = deps.now()
    const count = (where: ReturnType<typeof and>) =>
      db.select({ n: sql<number>`count(*)` }).from(bookings).where(where).get()?.n ?? 0
    const refundCount = (where: ReturnType<typeof and>) =>
      db
        .select({ n: sql<number>`count(*)` })
        .from(refunds)
        .innerJoin(orders, eq(orders.id, refunds.orderId))
        .where(where)
        .get()?.n ?? 0
    const { revenue, ...today } = dashboard(deps)
    // Money is left out for staff without finance, who could not act on it anyway.
    const money = can(c.get('roles'), 'finance')
    // 待上课 opens 预约 on today and the next 13 days with 待上课, which leaves out lessons
    // already over, so it counts those the same way.
    const day = venueDateKey(now)
    const upcoming = and(
      eq(bookings.status, 'confirmed'),
      gt(bookings.endsAt, now),
      gte(bookings.startsAt, venueInstant(day, 0)),
      lt(bookings.startsAt, venueInstant(addVenueDays(day, 13), 24 * 60)),
    )
    return c.json({
      upcomingBookings: count(upcoming),
      pendingPayments: count(eq(bookings.status, 'pending_payment')),
      refundRequests: money ? refundCount(eq(refunds.status, 'requested')) : null,
      failedRefunds: money ? refundCount(eq(refunds.status, 'failed')) : null,
      // WeChat Pay could not send the money back to the card; staff handle it on the merchant
      // platform.
      abnormalRefunds: money
        ? refundCount(and(eq(refunds.status, 'processing'), eq(refunds.abnormal, true)))
        : null,
      // Payments WeChat Pay reported that could not be applied, for staff to sort out.
      orderAnomalies: money
        ? (db.select({ n: sql<number>`count(*)` }).from(orders).where(openAnomaly).get()?.n ?? 0)
        : null,
      // Refunds of front-desk payments, waiting for staff to hand the money back.
      offlineRefundsOwed: money
        ? refundCount(and(eq(refunds.status, 'pending'), eq(orders.provider, 'offline')))
        : null,
      ...today,
      revenue: money ? revenue : null,
    })
  })

  return app
}
