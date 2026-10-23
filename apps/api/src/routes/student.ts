import {
  bookingWindowError,
  type CatalogDto,
  type CoachDto,
  type HomeDto,
  type LessonTypeDto,
  type OrderStatusDto,
  type PackageProductDto,
  packagePrice,
  type SlotDto,
  venueInstant,
} from '@rs/shared'
import { and, asc, desc, eq, gte, inArray, isNull, lt, or } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import {
  banners,
  bookings,
  coaches,
  coachLessonTypes,
  lessonTypes,
  orders,
  packageProducts,
  slots,
  students,
} from '../db/schema'
import type { Deps } from '../deps'
import { ApiError, idParam, notFound, parseBody, parseQuery } from '../errors'
import { type AuthVars, loginStudent, logout, requireStudent } from '../services/auth'
import { cancelBooking, createBooking, LIVE } from '../services/bookings'
import { priceFor, visibleTo } from '../services/catalog'
import { startPayment, syncOrder } from '../services/orders'
import { purchasePackage, requestPackageRefund } from '../services/packages'
import { getSettings } from '../services/settings'
import { bookingStatus, bookingViews, studentPackages } from '../services/views'

const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const positiveId = z.coerce.number().int().positive()

export function studentRoutes(deps: Deps) {
  const { db } = deps
  const app = new Hono<AuthVars>()

  app.post('/auth/student', async (c) => {
    const { code } = await parseBody(c, z.object({ code: z.string().min(1).max(200) }))
    const { token, student } = await loginStudent(deps, code)
    return c.json({ token, student: { id: student.id, name: student.name, phone: student.phone } })
  })

  app.get('/home', (c) => {
    const now = deps.now()
    const settings = getSettings(db)
    const notice =
      settings.notice.text && (!settings.notice.endsAt || new Date(settings.notice.endsAt) > now)
        ? settings.notice.text
        : null
    const rows = db
      .select()
      .from(banners)
      .where(
        and(
          eq(banners.active, true),
          or(isNull(banners.startsAt), lt(banners.startsAt, now)),
          or(isNull(banners.endsAt), gte(banners.endsAt, now)),
        ),
      )
      .orderBy(asc(banners.sort), asc(banners.id))
      .all()
    return c.json({
      venue: settings.venue,
      notice,
      banners: rows.map((b) => ({
        id: b.id,
        imageUrl: b.imageUrl,
        title: b.title,
        linkKind: b.linkKind,
        linkId: b.linkId,
      })),
    } satisfies HomeDto)
  })

  app.use('/me', requireStudent(deps))
  app.use('/me/*', requireStudent(deps))
  app.use('/catalog', requireStudent(deps))
  app.use('/slots', requireStudent(deps))
  app.use('/bookings', requireStudent(deps))
  app.use('/bookings/*', requireStudent(deps))
  app.use('/orders/*', requireStudent(deps))
  app.use('/packages', requireStudent(deps))
  app.use('/packages/*', requireStudent(deps))

  const me = (studentId: number) => {
    const s = db.select().from(students).where(eq(students.id, studentId)).get()
    if (!s) throw new ApiError(401, 'unauthorized', '请重新登录')
    return s
  }

  app.get('/me', (c) => {
    const s = me(c.get('studentId'))
    return c.json({ id: s.id, name: s.name, phone: s.phone })
  })

  app.patch('/me', async (c) => {
    const body = await parseBody(
      c,
      z.object({
        name: z.string().trim().min(1).max(20).optional(),
        phone: z
          .string()
          .trim()
          .regex(/^1\d{10}$/)
          .optional(),
      }),
    )
    db.update(students)
      .set(body)
      .where(eq(students.id, c.get('studentId')))
      .run()
    const s = me(c.get('studentId'))
    return c.json({ id: s.id, name: s.name, phone: s.phone })
  })

  app.post('/me/logout', (c) => {
    logout(deps, c.req.header('Authorization'))
    return c.body(null, 204)
  })

  app.get('/catalog', (c) => {
    const now = deps.now()
    const student = me(c.get('studentId'))
    const settings = getSettings(db)
    const types = db
      .select()
      .from(lessonTypes)
      .orderBy(asc(lessonTypes.sort), asc(lessonTypes.id))
      .all()
      .filter((t) => visibleTo(t, student) && (!t.isTrial || settings.payment.trialEnabled))
    const coachRows = db
      .select()
      .from(coaches)
      .where(eq(coaches.active, true))
      .orderBy(asc(coaches.sort), asc(coaches.id))
      .all()
    const links = db.select().from(coachLessonTypes).all()
    const coachDtos: CoachDto[] = coachRows.map((coach) => ({
      id: coach.id,
      name: coach.name,
      title: coach.title,
      bio: coach.bio,
      avatarUrl: coach.avatarUrl,
      lessons: types.flatMap((t) => {
        if (!links.some((l) => l.coachId === coach.id && l.lessonTypeId === t.id)) return []
        const price = priceFor(db, coach.id, t, now)
        return price ? [{ lessonTypeId: t.id, price }] : []
      }),
    }))
    const typeDtos: LessonTypeDto[] = types.map((t) => {
      const prices = coachDtos.flatMap((cd) => cd.lessons.filter((l) => l.lessonTypeId === t.id))
      const cheapest = prices.reduce<(typeof prices)[number] | null>(
        (min, p) => (!min || p.price.price < min.price.price ? p : min),
        null,
      )
      return {
        id: t.id,
        name: t.name,
        description: t.description,
        durationMinutes: t.durationMinutes,
        isTrial: t.isTrial,
        fromPrice: cheapest?.price ?? null,
      }
    })
    const visibleTypeIds = new Set(types.map((t) => t.id))
    const products: PackageProductDto[] = settings.payment.packagesEnabled
      ? db
          .select()
          .from(packageProducts)
          .where(eq(packageProducts.onSale, true))
          .orderBy(asc(packageProducts.sort), asc(packageProducts.id))
          .all()
          .filter((p) => visibleTypeIds.has(p.lessonTypeId))
          .map((p) => ({
            id: p.id,
            name: p.name,
            description: p.description,
            lessonTypeId: p.lessonTypeId,
            coachIds: p.coachIds,
            lessonCount: p.lessonCount,
            validityDays: p.validityDays,
            price: packagePrice(
              {
                price: p.price,
                salePrice: p.salePrice,
                startsAt: p.saleStartsAt,
                endsAt: p.saleEndsAt,
              },
              now,
            ),
          }))
      : []
    return c.json({
      lessonTypes: typeDtos,
      coaches: coachDtos,
      packageProducts: products,
      payment: {
        trialEnabled: settings.payment.trialEnabled,
        perClassEnabled: settings.payment.perClassEnabled,
        packagesEnabled: settings.payment.packagesEnabled,
      },
      booking: {
        advanceDays: settings.booking.advanceDays,
        cancelDeadlineHours: settings.booking.cancelDeadlineHours,
        lateCancel: settings.booking.lateCancel,
      },
      policies: settings.policies,
    } satisfies CatalogDto)
  })

  app.get('/slots', (c) => {
    const q = parseQuery(
      c,
      z.object({
        date: dateKey,
        coachId: positiveId.optional(),
        lessonTypeId: positiveId.optional(),
      }),
    )
    const now = deps.now()
    let from: Date
    try {
      from = venueInstant(q.date, 0)
    } catch {
      throw new ApiError(400, 'invalid_query', '日期无效')
    }
    const to = venueInstant(q.date, 24 * 60)
    const settings = getSettings(db)
    const lessonType = q.lessonTypeId
      ? db.select().from(lessonTypes).where(eq(lessonTypes.id, q.lessonTypeId)).get()
      : undefined
    if (q.lessonTypeId && !lessonType) throw notFound('课程')
    const teaching = lessonType
      ? new Set(
          db
            .select({ coachId: coachLessonTypes.coachId })
            .from(coachLessonTypes)
            .where(eq(coachLessonTypes.lessonTypeId, lessonType.id))
            .all()
            .map((r) => r.coachId),
        )
      : undefined
    const activeCoaches = new Set(
      db
        .select({ id: coaches.id })
        .from(coaches)
        .where(eq(coaches.active, true))
        .all()
        .map((r) => r.id),
    )
    const rows = db
      .select()
      .from(slots)
      .where(
        and(
          gte(slots.startsAt, from),
          lt(slots.startsAt, to),
          q.coachId ? eq(slots.coachId, q.coachId) : undefined,
        ),
      )
      .orderBy(asc(slots.startsAt), asc(slots.coachId))
      .all()
      .filter(
        (s) =>
          activeCoaches.has(s.coachId) &&
          (!teaching || teaching.has(s.coachId)) &&
          (!lessonType ||
            s.endsAt.getTime() - s.startsAt.getTime() === lessonType.durationMinutes * 60_000),
      )
    const takenIds = new Set(
      rows.length
        ? db
            .select({ slotId: bookings.slotId })
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
            .map((r) => r.slotId)
        : [],
    )
    return c.json(
      rows
        // Closed slots and slots outside the window are hidden; taken ones show as full.
        .filter(
          (s) => s.open && bookingWindowError(s.startsAt, now, settings.booking) !== 'too_far',
        )
        .map(
          (s): SlotDto => ({
            id: s.id,
            coachId: s.coachId,
            startsAt: s.startsAt.toISOString(),
            endsAt: s.endsAt.toISOString(),
            available:
              !takenIds.has(s.id) && bookingWindowError(s.startsAt, now, settings.booking) === null,
          }),
        ),
    )
  })

  app.post('/bookings', async (c) => {
    const body = await parseBody(
      c,
      z.object({
        slotId: z.number().int().positive(),
        lessonTypeId: z.number().int().positive(),
        payWith: z.enum(['package', 'wechat']).optional(),
      }),
    )
    return c.json(await createBooking(deps, c.get('studentId'), body), 201)
  })

  app.get('/bookings', (c) => {
    const q = parseQuery(c, z.object({ scope: z.enum(['upcoming', 'past']).default('upcoming') }))
    const now = deps.now()
    const studentId = c.get('studentId')
    const rows = db
      .select()
      .from(bookings)
      .where(
        q.scope === 'upcoming'
          ? and(
              eq(bookings.studentId, studentId),
              inArray(bookings.status, LIVE),
              gte(bookings.endsAt, now),
            )
          : and(
              eq(bookings.studentId, studentId),
              or(lt(bookings.endsAt, now), inArray(bookings.status, ['cancelled', 'expired'])),
            ),
      )
      .orderBy(q.scope === 'upcoming' ? asc(bookings.startsAt) : desc(bookings.startsAt))
      .limit(100)
      .all()
    return c.json(bookingViews(db, rows, getSettings(db).booking, now))
  })

  app.get('/bookings/:id', (c) => {
    const row = db
      .select()
      .from(bookings)
      .where(eq(bookings.id, idParam(c)))
      .get()
    if (!row || row.studentId !== c.get('studentId')) throw notFound('预约')
    const [view] = bookingViews(db, [row], getSettings(db).booking, deps.now())
    return c.json(view)
  })

  app.post('/bookings/:id/cancel', async (c) => {
    const id = idParam(c)
    await cancelBooking(deps, id, 'student', { studentId: c.get('studentId') })
    const row = db.select().from(bookings).where(eq(bookings.id, id)).get()
    if (!row) throw notFound('预约')
    const [view] = bookingViews(db, [row], getSettings(db).booking, deps.now())
    return c.json(view)
  })

  const ownOrder = (orderId: number, studentId: number) => {
    const order = db.select().from(orders).where(eq(orders.id, orderId)).get()
    if (!order || order.studentId !== studentId) throw notFound('订单')
    return order
  }

  app.get('/orders/:id', async (c) => {
    const id = idParam(c)
    ownOrder(id, c.get('studentId'))
    try {
      await syncOrder(deps, id)
    } catch (e) {
      deps.log('order sync failed', { orderId: id, error: (e as Error).message })
    }
    const order = ownOrder(id, c.get('studentId'))
    const booking = order.bookingId
      ? db.select().from(bookings).where(eq(bookings.id, order.bookingId)).get()
      : undefined
    return c.json({
      id: order.id,
      status: order.status,
      kind: order.kind,
      amount: order.amount,
      bookingId: order.bookingId,
      bookingStatus: booking ? bookingStatus(booking, deps.now()) : null,
    } satisfies OrderStatusDto)
  })

  app.post('/orders/:id/payment', async (c) => {
    const id = idParam(c)
    ownOrder(id, c.get('studentId'))
    const student = me(c.get('studentId'))
    return c.json(await startPayment(deps, id, student.openid))
  })

  app.get('/packages', (c) => c.json(studentPackages(db, c.get('studentId'), deps.now())))

  app.post('/packages/purchase', async (c) => {
    const { productId } = await parseBody(c, z.object({ productId: z.number().int().positive() }))
    return c.json(await purchasePackage(deps, c.get('studentId'), productId), 201)
  })

  app.post('/packages/:id/refund-request', (c) => {
    requestPackageRefund(deps, c.get('studentId'), idParam(c))
    const pkg = studentPackages(db, c.get('studentId'), deps.now()).find((p) => p.id === idParam(c))
    return c.json(pkg)
  })

  return app
}
