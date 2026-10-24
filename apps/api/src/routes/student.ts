import {
  type AccountDeletionDto,
  bookingWindowError,
  type CatalogDto,
  type CoachDetailDto,
  defaultAgreementText,
  type HomeDto,
  isCheckInCode,
  isGroup,
  type LessonTypeDto,
  type MeDto,
  NO_LINK,
  type OrderStatusDto,
  type PackageProductDto,
  POLICY_VERSION,
  packagePrice,
  privacyPolicyText,
  type SlotDto,
  studentNoticeKinds,
  type VenueSettings,
  venueDateKey,
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
import { studentCheckIn } from '../services/attendance'
import { type AuthVars, bearer, loginStudent, logout, requireStudent } from '../services/auth'
import { cancelBooking, createBooking, LIVE, quoteBooking } from '../services/bookings'
import { coachViews, visibleTo } from '../services/catalog'
import { studentFeedback } from '../services/feedback'
import { invoicePdf, requestInvoice, studentInvoices } from '../services/invoices'
import { liveLink } from '../services/links'
import { moveBooking, moveOptions } from '../services/moves'
import { startPayment, syncOrder, syncPendingOrders } from '../services/orders'
import { purchasePackage, requestPackageRefund } from '../services/packages'
import { liveCounts } from '../services/sessions'
import { getSettings, ruleBook } from '../services/settings'
import { linkDeskStudent } from '../services/student-link'
import { slotsWithoutTable } from '../services/tables'
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
      noticeLink: notice ? liveLink(db, settings, settings.notice) : NO_LINK,
      banners: rows.map((b) => ({
        id: b.id,
        imageUrl: b.imageUrl,
        title: b.title,
        ...liveLink(db, settings, b),
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
  app.use('/slots/*', requireStudent(deps))
  app.use('/bookings', requireStudent(deps))
  app.use('/bookings/*', requireStudent(deps))
  app.use('/feedback', requireStudent(deps))
  app.use('/check-in', requireStudent(deps))
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
        [...studentNoticeKinds, 'package' as const].flatMap((kind) => {
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

  // Links this WeChat to the student the front desk added, with the code the desk gave them.
  app.post('/me/link', async (c) => {
    const { code, merge } = await parseBody(
      c,
      z.object({ code: z.string().trim().min(1).max(20), merge: z.boolean().default(false) }),
    )
    linkDeskStudent(deps, bearer(c.req.header('Authorization')) ?? '', code, { merge })
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
    const rules = ruleBook(db)
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
        capacity: t.capacity,
        minStudents: t.minStudents,
        fromPrice: cheapest?.price ?? null,
        rules: rules.of(t.id),
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
      policies: policies(settings),
    } satisfies CatalogDto)
  })

  /**
   * The slots a student sees from `from` to `to`: closed ones hidden, taken ones and ones without a
   * free table unavailable. `moving` is the student's own booking being moved, which gives up its
   * table.
   */
  function studentSlots(
    now: Date,
    from: Date,
    to: Date,
    q: { coachId?: number; lessonTypeId?: number },
    moving?: { id: number; lessonTypeId: number },
    rules = ruleBook(db),
  ) {
    const lessonType = q.lessonTypeId
      ? db.select().from(lessonTypes).where(eq(lessonTypes.id, q.lessonTypeId)).get()
      : undefined
    if (q.lessonTypeId && !lessonType) throw notFound('课程')
    // A private slot has no lesson type of its own: it follows the window of the lesson being
    // booked or moved.
    const windowOf = (s: { lessonTypeId: number | null }) =>
      rules.of(s.lessonTypeId ?? lessonType?.id ?? moving?.lessonTypeId)
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
          // A group class is booked in its own sessions, a private lesson in private slots.
          (lessonType ? s.lessonTypeId === (isGroup(lessonType) ? lessonType.id : null) : true) &&
          (!lessonType ||
            s.endsAt.getTime() - s.startsAt.getTime() === lessonType.durationMinutes * 60_000),
      )
    const taken = liveCounts(
      db,
      rows.map((r) => r.id),
    )
    const noTable = slotsWithoutTable(db, rows, moving?.id)
    return (
      rows
        // Closed slots and slots outside the window are hidden; full ones and ones without a free
        // table show as full.
        .filter((s) => s.open && bookingWindowError(s.startsAt, now, windowOf(s)) !== 'too_far')
        .map((s): SlotDto => {
          const seatsLeft = Math.max(0, s.capacity - (taken.get(s.id) ?? 0))
          return {
            id: s.id,
            coachId: s.coachId,
            startsAt: s.startsAt.toISOString(),
            endsAt: s.endsAt.toISOString(),
            available:
              seatsLeft > 0 &&
              !noTable.has(s.id) &&
              bookingWindowError(s.startsAt, now, windowOf(s)) === null,
            lessonTypeId: s.lessonTypeId,
            capacity: s.capacity,
            seatsLeft,
          }
        })
    )
  }

  const slotFilter = {
    coachId: positiveId.optional(),
    lessonTypeId: positiveId.optional(),
  }

  app.get('/slots', (c) => {
    const q = parseQuery(
      c,
      // `moving`: the student's booking being moved, which gives up its table.
      z.object({ date: dateKey, ...slotFilter, moving: positiveId.optional() }),
    )
    let from: Date
    try {
      from = venueInstant(q.date, 0)
    } catch {
      throw new ApiError(400, 'invalid_query', '日期无效')
    }
    const moving = q.moving
      ? db
          .select({ id: bookings.id, lessonTypeId: bookings.lessonTypeId })
          .from(bookings)
          .where(and(eq(bookings.id, q.moving), eq(bookings.studentId, c.get('studentId'))))
          .get()
      : undefined
    return c.json(studentSlots(deps.now(), from, venueInstant(q.date, 24 * 60), q, moving))
  })

  // The venue days in the booking window with a slot that can be booked now, so the booking page
  // can go straight to a coach's next open day.
  app.get('/slots/open-days', (c) => {
    const q = parseQuery(c, z.object(slotFilter))
    const now = deps.now()
    const typeId = q.lessonTypeId
    const rules = ruleBook(db)
    const days = typeId ? rules.of(typeId).advanceDays : rules.longestAdvanceDays()
    const last = venueDateKey(new Date(now.getTime() + days * 86_400_000))
    const open = studentSlots(
      now,
      venueInstant(venueDateKey(now), 0),
      venueInstant(last, 24 * 60),
      q,
      undefined,
      rules,
    ).filter((s) => s.available)
    return c.json([...new Set(open.map((s) => venueDateKey(new Date(s.startsAt))))])
  })

  app.post('/bookings', async (c) => {
    const body = await parseBody(
      c,
      z.object({
        slotId: z.number().int().positive(),
        lessonTypeId: z.number().int().positive(),
        payWith: z.enum(['package', 'wechat']).optional(),
        /** The price the student was shown, in fen. */
        expectedPrice: z.number().int().nonnegative().optional(),
        /** The package the student was shown, when paying with one. */
        expectedPackageId: z.number().int().positive().optional(),
      }),
    )
    requireConsent(db, c.get('studentId'))
    return c.json(await createBooking(deps, c.get('studentId'), body), 201)
  })

  app.get('/bookings/quote', (c) => {
    const q = parseQuery(c, z.object({ slotId: positiveId, lessonTypeId: positiveId }))
    return c.json(quoteBooking(deps, c.get('studentId'), q.slotId, q.lessonTypeId))
  })

  app.get('/bookings', async (c) => {
    const q = parseQuery(c, z.object({ scope: z.enum(['upcoming', 'past']).default('upcoming') }))
    const studentId = c.get('studentId')
    if (q.scope === 'upcoming') await syncPendingOrders(deps, studentId, 'booking')
    const now = deps.now()
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
    return c.json(bookingViews(db, rows, now))
  })

  /** The student's own booking as they see it. */
  const ownBookingView = (id: number, studentId: number) => {
    const row = db.select().from(bookings).where(eq(bookings.id, id)).get()
    if (!row || row.studentId !== studentId) throw notFound('预约')
    const [view] = bookingViews(db, [row], deps.now(), true)
    return view
  }

  app.get('/bookings/:id', async (c) => {
    await syncPendingOrders(deps, c.get('studentId'), { bookingId: idParam(c) })
    return c.json(ownBookingView(idParam(c), c.get('studentId')))
  })

  // The student scanned the venue's 签到码 at the front desk.
  app.post('/check-in', async (c) => {
    const { code } = await parseBody(c, z.object({ code: z.string().max(500) }))
    if (!isCheckInCode(code)) throw new ApiError(400, 'not_check_in_code', '这不是场馆的签到码')
    return c.json(studentCheckIn(deps, c.get('studentId')))
  })

  // 学习记录
  app.get('/feedback', (c) => c.json(studentFeedback(db, c.get('studentId'))))

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

  app.get('/packages', async (c) => {
    await syncPendingOrders(deps, c.get('studentId'), 'package')
    return c.json(studentPackages(db, c.get('studentId'), deps.now()))
  })

  app.post('/packages/purchase', async (c) => {
    const { productId, expectedPrice } = await parseBody(
      c,
      z.object({
        productId: z.number().int().positive(),
        /** The price the student was shown, in fen. */
        expectedPrice: z.number().int().nonnegative().optional(),
      }),
    )
    requireConsent(db, c.get('studentId'))
    return c.json(await purchasePackage(deps, c.get('studentId'), productId, expectedPrice), 201)
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
