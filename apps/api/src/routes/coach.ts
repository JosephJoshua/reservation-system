// The coach mode of the mini program. PUT and DELETE only, since wx.request cannot send PATCH.
import { COACH_CANCEL_PREFIX, venueDateKey, venueDates, venueInstant } from '@rs/shared'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { bookings } from '../db/schema'
import type { Deps } from '../deps'
import { ApiError, checkVersion, idParam, parseBody, parseQuery } from '../errors'
import { setAttendance } from '../services/attendance'
import { type CoachVars, logout, requireCoach } from '../services/auth'
import { cancelBooking } from '../services/bookings'
import { noOtherCoachTold } from '../services/coach-notices'
import { bindCoach, coachProfile, loginCoach } from '../services/coaches'
import {
  checkPhotoUpload,
  deleteFeedback,
  MAX_PHOTO_BYTES,
  saveFeedback,
  savePhoto,
} from '../services/feedback'
import {
  coachLesson,
  coachSchedule,
  coachSession,
  coachStudentFeedback,
  ownBooking,
  saveCoachProfile,
  setCoachNote,
} from '../services/lessons'
import { coachMoveTimes, moveBooking } from '../services/moves'
import {
  addException,
  assertCoachMayEdit,
  removeException,
  saveHours,
  scheduleView,
} from '../services/schedule'
import { profileInput } from '../services/student-profiles'
import { dateKey, oneTarget, targetFields, toTarget } from './target'

const code = z.string().min(1).max(200)

export const weeklyHoursBody = z.object({
  /** The venue date the hours apply from; today when left out. */
  from: dateKey.optional(),
  hours: z
    .array(
      z.object({
        weekday: z.number().int().min(0).max(6),
        startMinute: z
          .number()
          .int()
          .min(0)
          .max(24 * 60),
        endMinute: z
          .number()
          .int()
          .min(0)
          .max(24 * 60),
      }),
    )
    .max(50),
})

export const exceptionBody = z.object({
  kind: z.enum(['off', 'extra']),
  startsAt: z.iso.datetime({ offset: true }).transform((s) => new Date(s)),
  endsAt: z.iso.datetime({ offset: true }).transform((s) => new Date(s)),
  note: z.string().trim().max(40).default(''),
})

export function coachRoutes(deps: Deps) {
  const app = new Hono<CoachVars>()

  app.post('/login', async (c) => {
    const body = await parseBody(c, z.object({ code }))
    return c.json(await loginCoach(deps, body.code))
  })

  app.post('/bind', async (c) => {
    const body = await parseBody(c, z.object({ code, bindCode: z.string().trim().min(1).max(20) }))
    return c.json(await bindCoach(deps, body.code, body.bindCode))
  })

  app.use('*', async (c, next) => {
    if (c.req.path.endsWith('/coach/login') || c.req.path.endsWith('/coach/bind')) return next()
    return requireCoach(deps)(c, next)
  })

  app.get('/me', (c) => c.json(coachProfile(deps, c.get('coachId'))))

  app.post('/logout', (c) => {
    logout(deps, c.req.header('Authorization'))
    return c.body(null, 204)
  })

  app.get('/schedule', (c) => {
    const q = parseQuery(c, z.object({ from: dateKey, to: dateKey }))
    const days = (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000
    // A week back plus the longest booking window the settings allow.
    if (!(days >= 0 && days <= 100)) throw new ApiError(400, 'invalid_query', '日期范围无效')
    return c.json(coachSchedule(deps, c.get('coachId'), q.from, q.to))
  })

  // Times the coach can move one of their private lessons to, from one date to another, in their
  // own 排班.
  app.get('/move-times', (c) => {
    const q = parseQuery(
      c,
      z.object({ bookingId: z.coerce.number().int().positive(), from: dateKey, to: dateKey }),
    )
    const days = (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000
    if (!(days >= 0 && days <= 100)) throw new ApiError(400, 'invalid_query', '日期范围无效')
    return c.json(
      coachMoveTimes(
        deps,
        q.bookingId,
        c.get('coachId'),
        venueDates(venueInstant(q.from, 12 * 60), days),
      ),
    )
  })

  app.get('/lessons/:id', (c) => c.json(coachLesson(deps, idParam(c), c.get('coachId'))))

  app.get('/sessions/:id', (c) => c.json(coachSession(deps, idParam(c), c.get('coachId'))))

  app.put('/lessons/:id/attendance', async (c) => {
    const { attendance } = await parseBody(
      c,
      z.object({ attendance: z.enum(['attended', 'no_show']).nullable() }),
    )
    const coachId = c.get('coachId')
    setAttendance(deps, idParam(c), attendance, { coachId })
    return c.json(coachLesson(deps, idParam(c), coachId))
  })

  app.put('/lessons/:id/note', async (c) => {
    const { note } = await parseBody(c, z.object({ note: z.string().trim().max(500) }))
    const coachId = c.get('coachId')
    setCoachNote(deps, idParam(c), coachId, note)
    return c.json(coachLesson(deps, idParam(c), coachId))
  })

  // 学员档案 from the lesson page. A save made on top of another coach's or the venue's change is
  // refused through If-Match, which is required here; the same save again goes through.
  app.put('/lessons/:id/profile', async (c) => {
    // Several coaches and the venue keep it, so a save must say what it was made on top of.
    if (!c.req.header('If-Match')) throw new ApiError(428, 'version_required', '请刷新后再改')
    const body = await parseBody(c, profileInput)
    return c.json(
      saveCoachProfile(deps, idParam(c), c.get('coachId'), body, (current) =>
        checkVersion(c, current),
      ),
    )
  })

  app.get('/lessons/:id/student-feedback', (c) =>
    c.json(coachStudentFeedback(deps, idParam(c), c.get('coachId'))),
  )

  app.put('/lessons/:id/feedback', async (c) => {
    const body = await parseBody(
      c,
      z.object({
        text: z.string().trim().min(1, '请填写点评').max(500),
        photos: z.array(z.string().max(200)).max(20),
      }),
    )
    const coachId = c.get('coachId')
    saveFeedback(deps, idParam(c), coachId, body)
    return c.json(coachLesson(deps, idParam(c), coachId))
  })

  app.delete('/lessons/:id/feedback', (c) => {
    const coachId = c.get('coachId')
    deleteFeedback(deps, idParam(c), coachId)
    return c.json(coachLesson(deps, idParam(c), coachId))
  })

  app.post(
    '/lessons/:id/photos',
    // Refused while it streams in, before the whole body is held in memory.
    bodyLimit({
      maxSize: MAX_PHOTO_BYTES + 64 * 1024,
      onError: () => {
        throw new ApiError(413, 'too_large', '图片不能超过 5MB')
      },
    }),
    async (c) => {
      const id = idParam(c)
      // Before the body is read, so a lesson that takes no photos costs no upload.
      checkPhotoUpload(deps, id, c.get('coachId'))
      const form = await c.req.formData().catch(() => null)
      const file = form?.get('file')
      if (!(file instanceof File)) throw new ApiError(400, 'no_file', '请选择图片')
      return c.json({ url: await savePhoto(deps, id, c.get('coachId'), file) }, 201)
    },
  )

  app.post('/lessons/:id/cancel', async (c) => {
    const { reason } = await parseBody(c, z.object({ reason: z.string().trim().min(1).max(100) }))
    const id = idParam(c)
    const coachId = c.get('coachId')
    const { booking, sessionOf } = ownBooking(deps, id, coachId)
    if (sessionOf !== null) throw new ApiError(409, 'group_lesson', '小班课请联系场馆调整')
    // Once the lesson starts, only the venue can cancel it.
    if (booking.startsAt <= deps.now()) {
      throw new ApiError(409, 'started', '课程已开始，如需取消请联系场馆')
    }
    // Marked before cancelling, so the sweeper never tells the coach about their own cancel. Only a
    // live booking is marked: a cancel by the student that got in first must still be announced.
    const cancelReason = `${COACH_CANCEL_PREFIX}${reason}`
    const marked = deps.db
      .update(bookings)
      .set({ coachToldCancelledAt: deps.now() })
      .where(
        and(
          eq(bookings.id, id),
          inArray(bookings.status, ['pending_payment', 'confirmed']),
          isNull(bookings.coachToldCancelledAt),
          noOtherCoachTold(coachId),
        ),
      )
      .run().changes
    try {
      await cancelBooking(deps, id, 'venue', { reason: cancelReason })
    } catch (e) {
      const row = deps.db.select().from(bookings).where(eq(bookings.id, id)).get()
      const ours = row?.cancelledBy === 'venue' && row.cancelReason === cancelReason
      if (marked && !ours) {
        deps.db
          .update(bookings)
          .set({ coachToldCancelledAt: null })
          .where(eq(bookings.id, id))
          .run()
      }
      throw e
    }
    return c.json(coachLesson(deps, id, coachId))
  })

  app.post('/lessons/:id/move', async (c) => {
    const body = await parseBody(c, z.object(targetFields).refine(oneTarget, '请选择上课时间'))
    const coachId = c.get('coachId')
    moveBooking(deps, idParam(c), toTarget(body), { coachId })
    return c.json(coachLesson(deps, idParam(c), coachId))
  })

  // 排班: the coach's weekly hours and 请假/加班, unless the venue keeps them to staff.
  app.get('/hours', (c) => c.json(scheduleView(deps.db, deps.now(), c.get('coachId'))))

  app.put('/hours', async (c) => {
    const body = await parseBody(c, weeklyHoursBody)
    assertCoachMayEdit(deps.db)
    const conflicts = saveHours(deps, c.get('coachId'), {
      from: body.from ?? venueDateKey(deps.now()),
      hours: body.hours,
    })
    return c.json({ conflicts })
  })

  app.post('/exceptions', async (c) => {
    const body = await parseBody(c, exceptionBody)
    assertCoachMayEdit(deps.db)
    return c.json(addException(deps, { ...body, coachId: c.get('coachId') }, null), 201)
  })

  app.delete('/exceptions/:id', (c) => {
    assertCoachMayEdit(deps.db)
    const { conflicts } = removeException(deps, idParam(c), c.get('coachId'))
    return c.json({ conflicts })
  })

  return app
}
