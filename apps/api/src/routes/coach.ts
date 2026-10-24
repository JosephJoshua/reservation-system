// The coach mode of the mini program. PUT and DELETE only, since wx.request cannot send PATCH.
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { bookings } from '../db/schema'
import type { Deps } from '../deps'
import { ApiError, idParam, parseBody, parseQuery } from '../errors'
import { setAttendance } from '../services/attendance'
import { type CoachVars, logout, requireCoach } from '../services/auth'
import { cancelBooking } from '../services/bookings'
import { noOtherCoachTold } from '../services/coach-notices'
import {
  bindCoach,
  coachProfile,
  hoursView,
  loginCoach,
  saveHours,
  setDayOff,
} from '../services/coaches'
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
  ownBooking,
  setCoachNote,
  setSlotOpen,
} from '../services/lessons'
import { moveBooking } from '../services/moves'

// A real calendar date: Date.parse would quietly turn 2026-02-30 into March 2.
export const dateKey = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((d) => {
    const ms = Date.parse(`${d}T00:00:00Z`)
    return !Number.isNaN(ms) && new Date(ms).toISOString().startsWith(d)
  }, '日期无效')
const code = z.string().min(1).max(200)

export const weeklyHoursBody = z.object({
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
        lessonMinutes: z.number().int().min(15).max(480),
      }),
    )
    .max(50),
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
    const q = parseQuery(
      c,
      z.object({
        from: dateKey,
        to: dateKey,
        moving: z.coerce.number().int().positive().optional(),
      }),
    )
    const days = (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000
    // A week back plus the longest booking window the settings allow.
    if (!(days >= 0 && days <= 100)) throw new ApiError(400, 'invalid_query', '日期范围无效')
    return c.json(coachSchedule(deps, c.get('coachId'), q.from, q.to, q.moving))
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
    const cancelReason = `教练取消：${reason}`
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
    const { slotId } = await parseBody(c, z.object({ slotId: z.number().int().positive() }))
    const coachId = c.get('coachId')
    moveBooking(deps, idParam(c), slotId, { coachId })
    return c.json(coachLesson(deps, idParam(c), coachId))
  })

  app.put('/slots/:id', async (c) => {
    const { open } = await parseBody(c, z.object({ open: z.boolean() }))
    setSlotOpen(deps, idParam(c), c.get('coachId'), open)
    return c.body(null, 204)
  })

  app.get('/hours', (c) => c.json(hoursView(deps, c.get('coachId'))))

  app.put('/hours', async (c) => {
    const { hours } = await parseBody(c, weeklyHoursBody)
    return c.json(saveHours(deps, c.get('coachId'), hours))
  })

  app.put('/days-off/:date', (c) =>
    c.json(setDayOff(deps, c.get('coachId'), c.req.param('date'), true)),
  )

  app.delete('/days-off/:date', (c) =>
    c.json(setDayOff(deps, c.get('coachId'), c.req.param('date'), false)),
  )

  return app
}
