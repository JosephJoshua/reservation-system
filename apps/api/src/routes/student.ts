import {
  type AccountDeletionDto,
  bookingWindowError,
  type CatalogDto,
  type CoachDetailDto,
  defaultAgreementText,
  type HomeDto,
  type LessonTypeDto,
  type MeDto,
  type OrderStatusDto,
  type PackageProductDto,
  POLICY_VERSION,
  packagePrice,
  privacyPolicyText,
  type SlotDto,
  studentNoticeKinds,
  type VenueSettings,
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
import {
  agreePolicies,
  deleteAccount,
  deletionBlockers,
  hasAgreedPolicies,
  requireConsent,
} from '../services/account'
import { type AuthVars, loginStudent, logout, requireStudent } from '../services/auth'
import { cancelBooking, createBooking, LIVE, quoteBooking } from '../services/bookings'
import { coachViews, visibleTo } from '../services/catalog'
import { invoicePdf, requestInvoice, studentInvoices } from '../services/invoices'
import { moveBooking, moveOptions } from '../services/moves'
import { startPayment, syncOrder } from '../services/orders'
import { purchasePackage, requestPackageRefund } from '../services/packages'
import { getSettings } from '../services/settings'
import { bookingStatus, bookingViews, studentPackages } from '../services/views'

const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const positiveId = z.coerce.number().int().positive()

function policies(settings: VenueSettings): CatalogDto['policies'] {
  return {
    booking: settings.policies.booking,
    agreement: settings.policies.agreement.trim() || defaultAgreementText(settings),
    privacy: privacyPolicyText(settings),
    version: POLICY_VERSION,
  }
}

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

  // Public, so the policies can be read before anything is collected.
  app.get('/policies', (c) => c.json(policies(getSettings(db))))

  app.use('/me', requireStudent(deps))
  app.use('/me/*', requireStudent(deps))
  app.use('/catalog', requireStudent(deps))
  app.use('/coaches/*', requireStudent(deps))
  app.use('/slots', requireStudent(deps))
  app.use('/bookings', requireStudent(deps))
  app.use('/bookings/*', requireStudent(deps))
  app.use('/orders/*', requireStudent(deps))
  app.use('/packages', requireStudent(deps))
  app.use('/invoices', requireStudent(deps))
  app.use('/invoices/*', requireStudent(deps))
  app.use('/packages/*', requireStudent(deps))

  const me = (studentId: number) => {
    const s = db.select().from(students).where(eq(students.id, studentId)).get()
    if (!s || s.deletedAt) throw new ApiError(401, 'unauthorized', '请重新登录')
    return s
  }

  app.get('/me', (c) => {
    const s = me(c.get('studentId'))
    // Coaches use the same WeChat account, so the profile page can offer the coach mode.
    const coach = db
      .select({ id: coaches.id })
      .from(coaches)
      .where(and(eq(coaches.openid, s.openid), eq(coaches.active, true)))
      .get()
    return c.json({
      id: s.id,
      name: s.name,
      phone: s.phone,
      isCoach: Boolean(coach),
      noticeTemplates: Object.fromEntries(
        studentNoticeKinds.flatMap((kind) => {
          const id = deps.notifier?.template(`student_${kind}`)?.id
          return id ? [[kind, id]] : []
        }),
      ),
      agreedPolicies: hasAgreedPolicies(s),
    } satisfies MeDto)
  })

  // PUT rather than PATCH because wx.request cannot send PATCH. Fields left out are kept.
  app.put('/me', async (c) => {
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
        })
        .refine((b) => Object.keys(b).length > 0, { message: '没有要修改的内容' }),
    )
    requireConsent(db, c.get('studentId'))
    db.update(students)
      .set(body)
      .where(eq(students.id, c.get('studentId')))
      .run()
    const s = me(c.get('studentId'))
    return c.json({ id: s.id, name: s.name, phone: s.phone })
  })

  app.post('/me/consent', async (c) => {
    const { version } = await parseBody(c, z.object({ version: z.string().max(20) }))
    agreePolicies(deps, c.get('studentId'), version)
    return c.body(null, 204)
  })

  app.get('/me/deletion', (c) =>
    c.json({
      blockers: deletionBlockers(db, me(c.get('studentId')).id, deps.now()),
    } satisfies AccountDeletionDto),
  )

  app.delete('/me', (c) => {
    deleteAccount(deps, c.get('studentId'))
    return c.body(null, 204)
  })

  app.post('/me/logout', (c) => {
    logout(deps, c.req.header('Authorization'))
    return c.body(null, 204)
  })

  const activeCoaches = () =>
    db
      .select()
      .from(coaches)
      .where(eq(coaches.active, true))
      .orderBy(asc(coaches.sort), asc(coaches.id))
      .all()

  /** Lesson types a student can book now. */
  const bookableTypes = (student: { tester: boolean }) => {
    const settings = getSettings(db)
    return db
      .select()
      .from(lessonTypes)
      .orderBy(asc(lessonTypes.sort), asc(lessonTypes.id))
      .all()
      .filter((t) => visibleTo(t, student) && (!t.isTrial || settings.payment.trialEnabled))
  }

  app.get('/coaches/:id', (c) => {
    const student = me(c.get('studentId'))
    const coach = db
      .select()
      .from(coaches)
      .where(eq(coaches.id, idParam(c)))
      .get()
    if (!coach?.active) throw notFound('教练')
    const [view] = coachViews(db, [coach], bookableTypes(student), deps.now())
    if (!view) throw notFound('教练')
    return c.json({ ...view, profile: coach.profile } satisfies CoachDetailDto)
  })

  app.get('/catalog', (c) => {
    const now = deps.now()
    const student = me(c.get('studentId'))
    const settings = getSettings(db)
    const types = bookableTypes(student)
    const coachDtos = coachViews(db, activeCoaches(), types, now)
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
        minNoticeMinutes: settings.booking.minNoticeMinutes,
        cancelDeadlineHours: settings.booking.cancelDeadlineHours,
        lateCancel: settings.booking.lateCancel,
      },
      policies: policies(settings),
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
    requireConsent(db, c.get('studentId'))
    return c.json(await createBooking(deps, c.get('studentId'), body), 201)
  })

  app.get('/bookings/quote', (c) => {
    const q = parseQuery(c, z.object({ slotId: positiveId, lessonTypeId: positiveId }))
    return c.json(quoteBooking(deps, c.get('studentId'), q.slotId, q.lessonTypeId))
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

  /** The student's own booking as they see it. */
  const ownBookingView = (id: number, studentId: number) => {
    const row = db.select().from(bookings).where(eq(bookings.id, id)).get()
    if (!row || row.studentId !== studentId) throw notFound('预约')
    const [view] = bookingViews(db, [row], getSettings(db).booking, deps.now())
    return view
  }

  app.get('/bookings/:id', (c) => c.json(ownBookingView(idParam(c), c.get('studentId'))))

  app.post('/bookings/:id/cancel', async (c) => {
    const id = idParam(c)
    const { acceptLate } = await parseBody(
      c,
      z.object({ acceptLate: z.boolean().default(false) }).default({ acceptLate: false }),
    )
    await cancelBooking(deps, id, 'student', { studentId: c.get('studentId'), acceptLate })
    return c.json(ownBookingView(id, c.get('studentId')))
  })

  app.get('/bookings/:id/move-options', (c) =>
    c.json(moveOptions(deps, idParam(c), c.get('studentId'))),
  )

  app.post('/bookings/:id/move', async (c) => {
    const id = idParam(c)
    const { slotId } = await parseBody(c, z.object({ slotId: z.number().int().positive() }))
    moveBooking(deps, id, slotId, { studentId: c.get('studentId') })
    return c.json(ownBookingView(id, c.get('studentId')))
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
    requireConsent(db, c.get('studentId'))
    return c.json(await purchasePackage(deps, c.get('studentId'), productId), 201)
  })

  app.post('/packages/:id/refund-request', (c) => {
    requestPackageRefund(deps, c.get('studentId'), idParam(c))
    const pkg = studentPackages(db, c.get('studentId'), deps.now()).find((p) => p.id === idParam(c))
    return c.json(pkg)
  })

  app.get('/invoices', (c) => c.json(studentInvoices(db, c.get('studentId'))))

  app.post('/invoices', async (c) => {
    const { orderId, ...title } = await parseBody(
      c,
      z.object({
        orderId: z.number().int().positive(),
        kind: z.enum(['personal', 'company']),
        name: z.string().max(100),
        taxNumber: z.string().max(40).default(''),
        email: z.string().max(200),
      }),
    )
    requireConsent(db, c.get('studentId'))
    const id = requestInvoice(deps, c.get('studentId'), orderId, title)
    const order = studentInvoices(db, c.get('studentId')).orders.find((o) => o.orderId === orderId)
    return c.json({ id, order }, 201)
  })

  app.get('/invoices/:id/pdf', (c) => {
    const id = idParam(c)
    return c.body(invoicePdf(deps, id, c.get('studentId')), 200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="invoice-${id}.pdf"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    })
  })

  return app
}
