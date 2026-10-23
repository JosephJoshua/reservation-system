import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { venueSettings } from '@rs/shared'
import { and, asc, desc, eq, gt, gte, inArray, like, lt, or, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { immediate } from '../db/client'
import {
  banners,
  bookings,
  coaches,
  coachLessonTypes,
  lessonTypes,
  orders,
  packageLedger,
  packageProducts,
  packages,
  refunds,
  slots,
  students,
} from '../db/schema'
import type { Deps } from '../deps'
import { ApiError, idParam, notFound, parseBody, parseQuery } from '../errors'
import { loginAdmin, logout, requireAdmin } from '../services/auth'
import { cancelBooking, LIVE } from '../services/bookings'
import {
  approvePackageRefund,
  extendPackage,
  grantLessons,
  rejectPackageRefund,
  sellPackageOffline,
} from '../services/packages'
import { retryRefund } from '../services/refunds'
import { getSettings, saveSettings } from '../services/settings'
import { bookingViews, packageViews } from '../services/views'

const instant = z.iso.datetime({ offset: true }).transform((s) => new Date(s))
const nullableInstant = instant.nullable()
const fen = z.number().int().min(0).max(10_000_000)
const MAX_SLOTS_PER_REQUEST = 500

const coachBody = z.object({
  name: z.string().trim().min(1).max(20),
  title: z.string().trim().max(30).default(''),
  bio: z.string().trim().max(500).default(''),
  avatarUrl: z.string().max(300).default(''),
  active: z.boolean().default(true),
  sort: z.number().int().default(0),
  /** Lesson types this coach teaches, each with an optional own price. */
  lessons: z
    .array(z.object({ lessonTypeId: z.number().int().positive(), price: fen.nullable() }))
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
  const app = new Hono()

  app.post('/login', async (c) => {
    const { password } = await parseBody(c, z.object({ password: z.string().max(200) }))
    return c.json(loginAdmin(deps, password))
  })

  app.use('*', async (c, next) => {
    if (c.req.path.endsWith('/admin/login')) return next()
    return requireAdmin(deps)(c, next)
  })

  app.post('/logout', (c) => {
    logout(deps, c.req.header('Authorization'))
    return c.body(null, 204)
  })

  // Settings

  app.get('/settings', (c) => c.json(getSettings(db)))

  app.put('/settings', async (c) => {
    const body = await parseBody(c, venueSettings)
    saveSettings(db, body, deps.now())
    return c.json(getSettings(db))
  })

  // Coaches

  const coachView = (id: number) => {
    const coach = db.select().from(coaches).where(eq(coaches.id, id)).get()
    if (!coach) throw notFound('教练')
    const lessons = db
      .select({ lessonTypeId: coachLessonTypes.lessonTypeId, price: coachLessonTypes.price })
      .from(coachLessonTypes)
      .where(eq(coachLessonTypes.coachId, id))
      .all()
    return { ...coach, lessons }
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

  const saveCoachLessons = (
    tx: Parameters<Parameters<typeof immediate>[1]>[0],
    coachId: number,
    lessons: z.infer<typeof coachBody>['lessons'],
  ) => {
    const known = new Set(
      tx
        .select({ id: lessonTypes.id })
        .from(lessonTypes)
        .all()
        .map((r) => r.id),
    )
    if (lessons.some((l) => !known.has(l.lessonTypeId))) throw notFound('课程')
    tx.delete(coachLessonTypes).where(eq(coachLessonTypes.coachId, coachId)).run()
    const unique = new Map(lessons.map((l) => [l.lessonTypeId, l]))
    for (const l of unique.values()) {
      tx.insert(coachLessonTypes)
        .values({ coachId, lessonTypeId: l.lessonTypeId, price: l.price })
        .run()
    }
  }

  app.post('/coaches', async (c) => {
    const { lessons, ...body } = await parseBody(c, coachBody)
    const id = immediate(db, (tx) => {
      const coach = tx.insert(coaches).values(body).returning({ id: coaches.id }).get()
      saveCoachLessons(tx, coach.id, lessons)
      return coach.id
    })
    return c.json(coachView(id), 201)
  })

  app.put('/coaches/:id', async (c) => {
    const id = idParam(c)
    const { lessons, ...body } = await parseBody(c, coachBody)
    immediate(db, (tx) => {
      const changed = tx.update(coaches).set(body).where(eq(coaches.id, id)).run()
      if (changed.changes === 0) throw notFound('教练')
      saveCoachLessons(tx, id, lessons)
    })
    return c.json(coachView(id))
  })

  // Lesson types

  app.get('/lesson-types', (c) =>
    c.json(db.select().from(lessonTypes).orderBy(asc(lessonTypes.sort), asc(lessonTypes.id)).all()),
  )

  app.post('/lesson-types', async (c) => {
    const body = await parseBody(c, lessonTypeBody)
    return c.json(db.insert(lessonTypes).values(body).returning().get(), 201)
  })

  app.put('/lesson-types/:id', async (c) => {
    const id = idParam(c)
    const body = await parseBody(c, lessonTypeBody)
    const existing = db.select().from(lessonTypes).where(eq(lessonTypes.id, id)).get()
    if (!existing) throw notFound('课程')
    const used = db.select({ id: bookings.id }).from(bookings).where(eq(bookings.lessonTypeId, id)).get()
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
    return c.json(db.update(lessonTypes).set(body).where(eq(lessonTypes.id, id)).returning().get())
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
    return c.json(
      rows.map((s) => {
        const b = bySlot.get(s.id)
        return {
          ...s,
          booking: b
            ? { id: b.id, status: b.status, student: byStudent.get(b.studentId) ?? null }
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
      body.slots.forEach((s, i) => {
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
          throw new ApiError(409, 'slot_overlap', `第 ${i + 1} 个时段与该教练已有时段重叠`)
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
      .set({ open })
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
        status: z.enum(['pending_payment', 'confirmed', 'cancelled', 'expired']).optional(),
      }),
    )
    const rows = db
      .select()
      .from(bookings)
      .where(
        and(
          q.from ? gte(bookings.startsAt, q.from) : undefined,
          q.to ? lt(bookings.startsAt, q.to) : undefined,
          q.studentId ? eq(bookings.studentId, q.studentId) : undefined,
          q.status ? eq(bookings.status, q.status) : undefined,
        ),
      )
      .orderBy(desc(bookings.startsAt))
      .limit(500)
      .all()
    const views = bookingViews(db, rows, getSettings(db).booking, deps.now())
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
    return c.json(
      views.map((v, i) => ({ ...v, student: people.get(rows[i]?.studentId ?? 0) ?? null })),
    )
  })

  app.post('/bookings/:id/cancel', async (c) => {
    const { reason } = await parseBody(c, z.object({ reason: z.string().trim().min(1).max(100) }))
    await cancelBooking(deps, idParam(c), 'venue', { reason })
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

  app.post('/package-products', async (c) => {
    const body = await parseBody(c, productBody)
    checkProduct(body)
    return c.json(db.insert(packageProducts).values(body).returning().get(), 201)
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
    const changed = db
      .update(students)
      .set(body)
      .where(eq(students.id, idParam(c)))
      .run()
    if (changed.changes === 0) throw notFound('学员')
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
    grantLessons(deps, idParam(c), body.lessons, body.note)
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
    extendPackage(deps, idParam(c), body.days, body.note)
    return c.body(null, 204)
  })

  app.post('/packages/offline-sale', async (c) => {
    const body = await parseBody(
      c,
      z.object({
        studentId: z.number().int().positive(),
        productId: z.number().int().positive(),
        amount: fen,
        method: z.enum(['cash', 'alipay', 'wechat', 'transfer']),
        note: z.string().trim().max(100).default(''),
      }),
    )
    return c.json({ packageId: sellPackageOffline(deps, body) }, 201)
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

  app.post('/refunds/:id/approve', async (c) => {
    const { amount } = await parseBody(c, z.object({ amount: fen.min(1) }))
    await approvePackageRefund(deps, idParam(c), amount)
    return c.body(null, 204)
  })

  app.post('/refunds/:id/reject', async (c) => {
    const { note } = await parseBody(c, z.object({ note: z.string().trim().min(1).max(100) }))
    rejectPackageRefund(deps, idParam(c), note)
    return c.body(null, 204)
  })

  app.post('/refunds/:id/retry', async (c) => {
    await retryRefund(deps, idParam(c))
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
    const row = db
      .update(banners)
      .set(body)
      .where(eq(banners.id, idParam(c)))
      .returning()
      .get()
    if (!row) throw notFound('轮播图')
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
