import {
  type AccountDeletionDto,
  addVenueDays,
  bookingTermsSchema,
  bookingWindowError,
  type CatalogDto,
  type CoachDetailDto,
  clashes,
  daysBetween,
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
  packageTermsSchema,
  privacyPolicyText,
  type SlotDto,
  studentNoticeKinds,
  type VenueSettings,
  venueDateKey,
  venueDates,
  venueInstant,
} from '@rs/shared'
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, or } from 'drizzle-orm'
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
  refunds,
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
import { coachViews, payableTrialHolds, trialsUsed, visibleTo } from '../services/catalog'
import { studentFeedback } from '../services/feedback'
import { invoicePdf, requestInvoice, studentInvoices } from '../services/invoices'
import { liveLink } from '../services/links'
import { moveBooking, moveOptions } from '../services/moves'
import { startPayment, syncOrder, syncPendingOrders } from '../services/orders'
import { purchasePackage, requestPackageRefund } from '../services/packages'
import { exceptionsFor, openTimes } from '../services/schedule'
import { liveCounts } from '../services/sessions'
import { getSettings, ruleBook } from '../services/settings'
import { linkDeskStudent } from '../services/student-link'
import { slotsWithoutTable } from '../services/tables'
import { bookingStatus, bookingViews, studentPackages } from '../services/views'
import { dateKey, oneTarget, shownTime, targetFields, toTarget } from './target'

const positiveId = z.coerce.number().int().positive()

const lengthOf = (b: { startsAt: Date; endsAt: Date }) => b.endsAt.getTime() - b.startsAt.getTime()

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
    // A trial still on offer to this student; when not, whether only unpaid holds that can still
    // be paid take it up, so the mini program can say to pay rather than that it is used up.
    const trial = (() => {
      const { trialEnabled, trialLimitPerStudent: limit } = settings.payment
      if (!trialEnabled) return { available: false, pending: false }
      const used = trialsUsed(db, student.id, now)
      if (used < limit) return { available: true, pending: false }
      return { available: false, pending: used - payableTrialHolds(db, student.id, now) < limit }
    })()
    // Active coach and lesson type pairs they teach.
    const teachingNow = new Set(
      db
        .select({ coachId: coachLessonTypes.coachId, lessonTypeId: coachLessonTypes.lessonTypeId })
        .from(coachLessonTypes)
        .innerJoin(coaches, eq(coaches.id, coachLessonTypes.coachId))
        .where(eq(coaches.active, true))
        .all()
        .map((r) => `${r.coachId}:${r.lessonTypeId}`),
    )
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
          // A package kept to coaches of whom none still teaches its lesson can't be used, so it
          // is not sold.
          .filter(
            (p) =>
              visibleTypeIds.has(p.lessonTypeId) &&
              (!p.coachIds.length ||
                p.coachIds.some((id) => teachingNow.has(`${id}:${p.lessonTypeId}`))),
          )
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
        trialAvailable: trial.available,
        trialPending: trial.pending,
        perClassEnabled: settings.payment.perClassEnabled,
        packagesEnabled: settings.payment.packagesEnabled,
      },
      policies: policies(settings),
    } satisfies CatalogDto)
  })

  /**
   * What a student can book from `from` to `to`: group sessions, and for a private lesson type the
   * start times the coaches' 排班 offers. Closed sessions and times beyond the booking window are
   * hidden; full ones, ones without a free table and ones too soon show as unavailable. `moving` is
   * the student's own booking being moved: its length and lesson type apply, and it gives up its
   * time and table. Only lesson types the student can see are listed, and the one of the booking
   * being moved.
   */
  function studentSlots(
    now: Date,
    student: { id: number; tester: boolean },
    from: string,
    to: string,
    q: { coachId?: number; lessonTypeId?: number },
    moving?: typeof bookings.$inferSelect,
    rules = ruleBook(db),
  ) {
    const lessonTypeId = q.lessonTypeId ?? moving?.lessonTypeId
    const seen = new Map(
      db
        .select()
        .from(lessonTypes)
        .all()
        .filter((t) => visibleTo(t, student) || t.id === moving?.lessonTypeId)
        .map((t) => [t.id, t]),
    )
    const lessonType = lessonTypeId ? seen.get(lessonTypeId) : undefined
    if (lessonTypeId && !lessonType) throw notFound('课程')
    // A computed private time has no lesson type of its own: it follows the window of the lesson
    // being booked or moved.
    const windowOf = (lessonTypeId: number | null) => rules.of(lessonTypeId ?? lessonType?.id)
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
    const activeCoaches = db
      .select({ id: coaches.id })
      .from(coaches)
      .where(eq(coaches.active, true))
      .all()
      .map((r) => r.id)
      .filter((id) => (!teaching || teaching.has(id)) && (!q.coachId || q.coachId === id))
    const active = new Set(activeCoaches)
    const shown = (startsAt: Date, typeId: number | null) =>
      bookingWindowError(startsAt, now, windowOf(typeId)) !== 'too_far'
    const open = (startsAt: Date, typeId: number | null) =>
      bookingWindowError(startsAt, now, windowOf(typeId)) === null

    const listed = db
      .select()
      .from(slots)
      .where(
        and(
          isNotNull(slots.lessonTypeId),
          gte(slots.startsAt, venueInstant(from, 0)),
          lt(slots.startsAt, venueInstant(addVenueDays(to, 1), 0)),
          q.coachId ? eq(slots.coachId, q.coachId) : undefined,
        ),
      )
      .orderBy(asc(slots.startsAt), asc(slots.coachId))
      .all()
      .filter(
        (s) =>
          active.has(s.coachId) &&
          s.open &&
          s.lessonTypeId !== null &&
          seen.has(s.lessonTypeId) &&
          shown(s.startsAt, s.lessonTypeId) &&
          (!lessonType || s.lessonTypeId === lessonType.id) &&
          // A moved lesson keeps its length; a new booking takes the lesson type's.
          (moving
            ? lengthOf(s) === lengthOf(moving)
            : !lessonType || lengthOf(s) === lessonType.durationMinutes * 60_000),
      )
    // A session a later 请假 or 闭馆 covers takes no one new, so it is not offered.
    const off = exceptionsFor(db, activeCoaches, {
      startsAt: venueInstant(from, 0),
      endsAt: venueInstant(addVenueDays(to, 1), 0),
    })
    const sessions = listed.filter(
      (s) => !(off.get(s.coachId) ?? []).some((e) => e.kind === 'off' && clashes(s, e)),
    )
    const taken = liveCounts(
      db,
      sessions.map((r) => r.id),
    )
    // The student's own seats in these sessions: booked already, so not offered again. A hold
    // whose payment time is up is not: booking again closes it and books afresh, so its seat is
    // free for them as well. A move does not close it, so for a move it is still their seat.
    const ownRows = sessions.length
      ? db
          .select({
            slotId: bookings.slotId,
            id: bookings.id,
            status: bookings.status,
            payBy: orders.expiresAt,
          })
          .from(bookings)
          .leftJoin(orders, and(eq(orders.bookingId, bookings.id), eq(orders.status, 'pending')))
          .where(
            and(
              eq(bookings.studentId, student.id),
              inArray(bookings.status, LIVE),
              inArray(
                bookings.slotId,
                sessions.map((s) => s.id),
              ),
            ),
          )
          .all()
      : []
    const lapsed = (b: (typeof ownRows)[number]) =>
      !moving && b.status === 'pending_payment' && b.payBy !== null && b.payBy <= now
    const lapsedSeats = new Set(ownRows.filter(lapsed).map((b) => b.slotId))
    const noTable = slotsWithoutTable(db, sessions, moving?.id, lapsedSeats)
    const mine = new Map(
      ownRows
        .filter((b) => !lapsed(b))
        .map((b) => [
          b.slotId,
          {
            bookingId: b.id,
            status:
              b.status === 'pending_payment'
                ? ('pending_payment' as const)
                : ('confirmed' as const),
          },
        ]),
    )
    const out: SlotDto[] = sessions.map((s) => {
      const held = (taken.get(s.id) ?? 0) - (lapsedSeats.has(s.id) ? 1 : 0)
      const seatsLeft = Math.max(0, s.capacity - held)
      const own = mine.get(s.id) ?? null
      return {
        id: s.id,
        coachId: s.coachId,
        startsAt: s.startsAt.toISOString(),
        endsAt: s.endsAt.toISOString(),
        available: !own && seatsLeft > 0 && !noTable.has(s.id) && open(s.startsAt, s.lessonTypeId),
        lessonTypeId: s.lessonTypeId,
        capacity: s.capacity,
        seatsLeft,
        mine: own,
      }
    })

    if (lessonType && !isGroup(lessonType)) {
      const dates = venueDates(venueInstant(from, 12 * 60), daysBetween(from, to) - 1)
      const minutes = moving ? lengthOf(moving) / 60_000 : lessonType.durationMinutes
      const times = openTimes(db, {
        coachIds: activeCoaches,
        dates,
        minutes,
        notBefore: now,
        except: moving?.id,
      })
      // The student's own private hold whose payment time is up: booking that coach and start
      // again closes it first, so that time is free for them. Only that very start is, since a
      // booking at another time does not close it. A move does not close it either.
      if (!moving) {
        const listedAt = new Set(times.map((t) => `${t.coachId}@${t.startsAt.getTime()}`))
        for (const hold of lapsedPrivateHolds(now, student.id, activeCoaches, from, to)) {
          const key = `${hold.coachId}@${hold.startsAt.getTime()}`
          if (listedAt.has(key)) continue
          const freed = openTimes(db, {
            coachIds: [hold.coachId],
            dates: [venueDateKey(hold.startsAt)],
            minutes,
            notBefore: now,
            except: hold.id,
          }).find((t) => t.startsAt.getTime() === hold.startsAt.getTime())
          if (freed) {
            times.push(freed)
            listedAt.add(key)
          }
        }
      }
      for (const t of times) {
        if (!shown(t.startsAt, null)) continue
        out.push({
          id: null,
          coachId: t.coachId,
          startsAt: t.startsAt.toISOString(),
          endsAt: t.endsAt.toISOString(),
          available: !t.tableFull && open(t.startsAt, null),
          lessonTypeId: null,
          capacity: 1,
          seatsLeft: t.tableFull ? 0 : 1,
          mine: null,
        })
      }
    }
    return out.sort(
      (a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || a.coachId - b.coachId,
    )
  }

  /** The student's unpaid private holds with these coaches on these dates whose payment time is up. */
  function lapsedPrivateHolds(
    now: Date,
    studentId: number,
    coachIds: readonly number[],
    from: string,
    to: string,
  ) {
    if (!coachIds.length) return []
    return db
      .select({ id: bookings.id, coachId: slots.coachId, startsAt: bookings.startsAt })
      .from(bookings)
      .innerJoin(slots, eq(slots.id, bookings.slotId))
      .innerJoin(orders, and(eq(orders.bookingId, bookings.id), eq(orders.status, 'pending')))
      .where(
        and(
          eq(bookings.studentId, studentId),
          eq(bookings.status, 'pending_payment'),
          isNull(slots.lessonTypeId),
          inArray(slots.coachId, [...coachIds]),
          gte(bookings.startsAt, venueInstant(from, 0)),
          lt(bookings.startsAt, venueInstant(addVenueDays(to, 1), 0)),
          isNotNull(orders.expiresAt),
          lte(orders.expiresAt, now),
        ),
      )
      .all()
  }

  const slotFilter = {
    coachId: positiveId.optional(),
    lessonTypeId: positiveId.optional(),
  }

  app.get('/slots', (c) => {
    const q = parseQuery(
      c,
      // `moving`: the student's booking being moved, which gives up its time and table.
      z.object({ date: dateKey, ...slotFilter, moving: positiveId.optional() }),
    )
    try {
      venueInstant(q.date, 0)
    } catch {
      throw new ApiError(400, 'invalid_query', '日期无效')
    }
    const moving = q.moving
      ? db
          .select()
          .from(bookings)
          .where(and(eq(bookings.id, q.moving), eq(bookings.studentId, c.get('studentId'))))
          .get()
      : undefined
    return c.json(studentSlots(deps.now(), me(c.get('studentId')), q.date, q.date, q, moving))
  })

  // The venue days in the booking window with something that can be booked now, so the booking
  // page can go straight to a coach's next open day.
  app.get('/slots/open-days', (c) => {
    const q = parseQuery(c, z.object(slotFilter))
    const now = deps.now()
    const typeId = q.lessonTypeId
    const rules = ruleBook(db)
    const days = typeId ? rules.of(typeId).advanceDays : rules.longestAdvanceDays()
    const last = venueDateKey(new Date(now.getTime() + days * 86_400_000))
    const student = me(c.get('studentId'))
    // A lesson type the student can no longer see has no open days.
    if (typeId) {
      const type = db.select().from(lessonTypes).where(eq(lessonTypes.id, typeId)).get()
      if (!type) throw notFound('课程')
      if (!visibleTo(type, student)) return c.json([])
    }
    const open = studentSlots(now, student, venueDateKey(now), last, q, undefined, rules).filter(
      (s) => s.available,
    )
    return c.json([...new Set(open.map((s) => venueDateKey(new Date(s.startsAt))))])
  })

  app.post('/bookings', async (c) => {
    const body = await parseBody(
      c,
      z
        .object({
          ...targetFields,
          lessonTypeId: z.number().int().positive(),
          payWith: z.enum(['package', 'wechat']).optional(),
          /** The price the student was shown, in fen. */
          expectedPrice: z.number().int().nonnegative().optional(),
          /** The package the student was shown, when paying with one. */
          expectedPackageId: z.number().int().positive().optional(),
          /** The cancel and move rules the student was shown. */
          expectedTerms: bookingTermsSchema.optional(),
        })
        .refine(oneTarget, '请选择上课时间'),
    )
    requireConsent(db, c.get('studentId'))
    return c.json(
      await createBooking(deps, c.get('studentId'), {
        target: toTarget(body),
        lessonTypeId: body.lessonTypeId,
        payWith: body.payWith,
        expectedPrice: body.expectedPrice,
        expectedPackageId: body.expectedPackageId,
        expectedTerms: body.expectedTerms,
      }),
      201,
    )
  })

  app.get('/bookings/quote', (c) => {
    const q = parseQuery(
      c,
      z.object({ ...targetFields, lessonTypeId: positiveId }).refine(oneTarget),
    )
    return c.json(quoteBooking(deps, c.get('studentId'), toTarget(q), q.lessonTypeId))
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
              // A lesson in progress the student was marked absent from is over for them.
              or(isNull(bookings.attendance), ne(bookings.attendance, 'no_show')),
            )
          : and(
              eq(bookings.studentId, studentId),
              or(
                lt(bookings.endsAt, now),
                inArray(bookings.status, ['cancelled', 'expired']),
                eq(bookings.attendance, 'no_show'),
              ),
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
    const body = await parseBody(
      c,
      z.object({ ...targetFields, from: shownTime.optional() }).refine(oneTarget, '请选择上课时间'),
    )
    moveBooking(deps, id, toTarget(body), { studentId: c.get('studentId') }, { from: body.from })
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
      refunded: !!db
        .select({ id: refunds.id })
        .from(refunds)
        .where(and(eq(refunds.orderId, order.id), ne(refunds.status, 'rejected')))
        .get(),
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
    const { productId, expectedPrice, expectedTerms } = await parseBody(
      c,
      z.object({
        productId: z.number().int().positive(),
        /** The price the student was shown, in fen. */
        expectedPrice: z.number().int().nonnegative().optional(),
        /** The lessons, validity, lesson type and coaches the student was shown. */
        expectedTerms: packageTermsSchema.optional(),
      }),
    )
    requireConsent(db, c.get('studentId'))
    return c.json(
      await purchasePackage(deps, c.get('studentId'), productId, expectedPrice, expectedTerms),
      201,
    )
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
