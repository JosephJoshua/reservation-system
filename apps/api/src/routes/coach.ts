// The coach mode of the mini program. PUT and DELETE only, since wx.request cannot send PATCH.
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { bookings } from '../db/schema'
import type { Deps } from '../deps'
import { ApiError, idParam, parseBody, parseQuery } from '../errors'
import { type CoachVars, logout, requireCoach } from '../services/auth'
import { cancelBooking } from '../services/bookings'
import {
  bindCoach,
  coachProfile,
  hoursView,
  loginCoach,
  saveHours,
  setDayOff,
} from '../services/coaches'
import {
  coachLesson,
  coachSchedule,
  ownBooking,
  setAttendance,
  setCoachNote,
  setSlotOpen,
} from '../services/lessons'

const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
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
    const q = parseQuery(c, z.object({ from: dateKey, to: dateKey }))
    const days = (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000
    // A week back plus the longest booking window the settings allow.
    if (!(days >= 0 && days <= 100)) throw new ApiError(400, 'invalid_query', '日期范围无效')
    return c.json(coachSchedule(deps, c.get('coachId'), q.from, q.to))
  })

  app.get('/lessons/:id', (c) => c.json(coachLesson(deps, idParam(c), c.get('coachId'))))

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

  app.post('/lessons/:id/cancel', async (c) => {
    const { reason } = await parseBody(c, z.object({ reason: z.string().trim().min(1).max(100) }))
    const id = idParam(c)
    const coachId = c.get('coachId')
    const { booking } = ownBooking(deps, id, coachId)
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
