import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
  actionLog,
  bookingMoves,
  bookings,
  categoryPrices,
  coachCategories,
  coaches,
  coachLessonTypes,
  lessonTypes,
  packageLedger,
  packageProducts,
  refunds,
  slots,
  studentNotices,
} from './db/schema'
import { notifyCoaches } from './services/coach-notices'
import { notifyStudents } from './services/student-notices'
import { type Harness, setup } from './test/harness'
import type { NoticeKind, NoticeValues, Notifier } from './wx-notify'

// The harness clock is 2026-10-23 10:00 at the venue; the free-cancel deadline is 24 hours.

async function book(h: Harness, token: string, slotId: number, lessonTypeId: number) {
  const res = await h.call('POST', '/bookings', { slotId, lessonTypeId }, token)
  expect(res.status).toBe(201)
  if (res.json.orderId) await h.fakePay(res.json.orderId)
  return res.json.bookingId as number
}

/** A seeded venue with a paid lesson on 10-25 at 10:00. */
async function booked(h: Harness) {
  const seeded = h.seed()
  const t = await h.student('a')
  const from = h.slot(seeded.coach.id, '2026-10-25', 10)
  const id = await book(h, t, from.id, seeded.lesson.id)
  return { ...seeded, t, from, id }
}

/** A category charging `price` for the lesson. */
function category(h: Harness, lessonTypeId: number, price: number) {
  const c = h.db
    .insert(coachCategories)
    .values({ name: `${price}` })
    .returning()
    .get()
  h.db.insert(categoryPrices).values({ categoryId: c.id, lessonTypeId, price }).run()
  return c.id
}

/** An active coach teaching the lesson, at their category's price if given. */
function otherCoach(
  h: Harness,
  lessonTypeId: number,
  price: number | null = null,
  values: { name?: string; active?: boolean } = {},
) {
  const categoryId = price === null ? null : category(h, lessonTypeId, price)
  const coach = h.db
    .insert(coaches)
    .values({ name: '李教练', ...values, categoryId })
    .returning()
    .get()
  h.db.insert(coachLessonTypes).values({ coachId: coach.id, lessonTypeId }).run()
  return coach
}

async function bindCoach(h: Harness, coachId: number, wx = 'coach') {
  const admin = await h.admin()
  const { code } = (await h.call('POST', `/admin/coaches/${coachId}/bind-code`, {}, admin)).json
  const res = await h.call('POST', '/coach/bind', { code: `dev:${wx}`, bindCode: code })
  expect(res.status).toBe(200)
  return res.json.token as string
}

const move = (h: Harness, t: string, id: number, slotId: number) =>
  h.call('POST', `/bookings/${id}/move`, { slotId }, t)

const row = (h: Harness, id: number) =>
  h.db.select().from(bookings).where(eq(bookings.id, id)).get()

describe('students moving a lesson', () => {
  it('moves a paid lesson, keeping its payment, and frees the old slot', async () => {
    const h = setup()
    const { coach, lesson, t, from, id } = await booked(h)
    const to = h.slot(coach.id, '2026-10-26', 14)

    const res = await move(h, t, id, to.id)
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({
      id,
      status: 'confirmed',
      startsAt: to.startsAt.toISOString(),
      price: 20000,
      orderId: expect.any(Number),
      canMove: false,
      movesLeft: 0,
      movedFrom: from.startsAt.toISOString(),
    })
    expect(row(h, id)).toMatchObject({ slotId: to.id, endsAt: to.endsAt })

    // The old time is free for others again.
    const other = await h.student('b')
    expect(await book(h, other, from.id, lesson.id)).toBeGreaterThan(id)
    expect(h.db.select().from(bookingMoves).all()).toMatchObject([
      { bookingId: id, by: 'student', fromCoachId: coach.id, toCoachId: coach.id },
    ])
    expect(
      h.db.select().from(studentNotices).where(eq(studentNotices.bookingId, id)).all(),
    ).toMatchObject([
      { kind: 'moved', data: { oldTime: '2026年10月25日 10:00~11:00' }, doneAt: null },
    ])
  })

  it('treats a repeated move to the same slot as done', async () => {
    const h = setup()
    const { coach, t, id } = await booked(h)
    const to = h.slot(coach.id, '2026-10-26', 14)
    const [a, b] = await Promise.all([move(h, t, id, to.id), move(h, t, id, to.id)])
    expect([a.status, b.status]).toEqual([200, 200])
    expect(b.json).toEqual(a.json)
    expect(h.db.select().from(bookingMoves).all()).toHaveLength(1)
  })

  it('counts moves against the allowance the lesson was booked under', async () => {
    const h = setup()
    const { coach, t, id, lesson } = await booked(h)
    expect((await move(h, t, id, h.slot(coach.id, '2026-10-26', 14).id)).status).toBe(200)
    const again = await move(h, t, id, h.slot(coach.id, '2026-10-27', 14).id)
    expect(again.json.error).toMatchObject({ code: 'no_moves_left', message: '改约次数已用完' })

    // A later change, by the venue or on the lesson type, leaves a booked lesson alone.
    h.settings((s) => {
      s.booking.studentMoves = 2
    })
    h.db
      .update(lessonTypes)
      .set({ rules: { studentMoves: 3 } })
      .where(eq(lessonTypes.id, lesson.id))
      .run()
    const still = await move(h, t, id, h.slot(coach.id, '2026-10-27', 15).id)
    expect(still.json.error.code).toBe('no_moves_left')

    // A lesson booked now gets the lesson type's own allowance.
    const next = await book(h, t, h.slot(coach.id, '2026-10-28', 10).id, lesson.id)
    for (const hour of [11, 12, 13]) {
      expect((await move(h, t, next, h.slot(coach.id, '2026-10-28', hour).id)).status).toBe(200)
    }
    expect((await move(h, t, next, h.slot(coach.id, '2026-10-28', 14).id)).json.error.code).toBe(
      'no_moves_left',
    )

    h.db
      .update(lessonTypes)
      .set({ rules: { studentMoves: 0 } })
      .where(eq(lessonTypes.id, lesson.id))
      .run()
    const off = await book(h, t, h.slot(coach.id, '2026-10-29', 10).id, lesson.id)
    expect((await move(h, t, off, h.slot(coach.id, '2026-10-29', 15).id)).json.error).toMatchObject(
      {
        code: 'no_moves_left',
        message: '暂不支持自助改约，请联系场馆',
      },
    )
    expect((await h.call('GET', `/bookings/${off}`, undefined, t)).json).toMatchObject({
      canMove: false,
      movesLeft: 0,
      terms: { studentMoves: 0, cancelDeadlineHours: 24 },
    })
  })

  it('stops at the free-cancel deadline; the venue and the coach can still move it', async () => {
    const h = setup()
    const { coach, t, id } = await booked(h)
    const coachToken = await bindCoach(h, coach.id)
    h.clock.now = new Date('2026-10-24T02:00:01Z')
    expect((await h.call('GET', `/bookings/${id}`, undefined, t)).json.canMove).toBe(false)
    const late = await move(h, t, id, h.slot(coach.id, '2026-10-26', 14).id)
    expect(late.json.error.code).toBe('move_deadline')

    const admin = await h.admin()
    // The venue may move it into a slot too close for students to book.
    const soon = h.slot(coach.id, '2026-10-24', 11)
    expect(
      (await h.call('POST', `/admin/bookings/${id}/move`, { slotId: soon.id }, admin)).status,
    ).toBe(204)
    const back = h.slot(coach.id, '2026-10-24', 13)
    const byCoach = await h.call(
      'POST',
      `/coach/lessons/${id}/move`,
      { slotId: back.id },
      coachToken,
    )
    expect(byCoach.status).toBe(200)
    expect(byCoach.json).toMatchObject({ startsAt: back.startsAt.toISOString(), canMove: true })

    h.clock.now = back.startsAt
    const started = await h.call(
      'POST',
      `/admin/bookings/${id}/move`,
      { slotId: h.slot(coach.id, '2026-10-26', 9).id },
      admin,
    )
    expect(started.json.error.code).toBe('started')
  })

  it('logs a venue move once, however often it is sent', async () => {
    const h = setup()
    const { coach, id } = await booked(h)
    const admin = await h.admin()
    const to = h.slot(coach.id, '2026-10-26', 14)
    for (let i = 0; i < 2; i++) {
      expect(
        (await h.call('POST', `/admin/bookings/${id}/move`, { slotId: to.id }, admin)).status,
      ).toBe(204)
    }
    const entries = h.db
      .select()
      .from(actionLog)
      .all()
      .filter((e) => e.action === 'booking.move')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ targetKind: 'booking', targetId: id })
    expect(entries[0]?.summary).toBe('10月25日 10:00 王教练 一对一私教 改到 10月26日 14:00 王教练')
  })

  it('refuses times that are taken, in 请假, outside 排班, too soon or too far', async () => {
    const h = setup()
    const { coach, lesson, t, id } = await booked(h)
    const other = await h.student('b')
    const taken = h.slot(coach.id, '2026-10-26', 9)
    await book(h, other, taken.id, lesson.id)
    expect((await move(h, t, id, taken.id)).json.error.code).toBe('slot_taken')

    const closed = h.slot(coach.id, '2026-10-26', 11)
    await h.call(
      'POST',
      `/admin/coaches/${coach.id}/exceptions`,
      { kind: 'off', startsAt: closed.startsAt.toISOString(), endsAt: closed.endsAt.toISOString() },
      await h.admin(),
    )
    expect((await move(h, t, id, closed.id)).json.error.code).toBe('time_unavailable')

    expect((await move(h, t, id, h.slot(coach.id, '2026-10-23', 11).id)).json.error.code).toBe(
      'too_soon',
    )
    expect((await move(h, t, id, h.slot(coach.id, '2026-11-20', 11).id)).json.error.code).toBe(
      'too_far',
    )
    expect((await move(h, t, id, h.slot(coach.id, '2026-10-22', 11).id)).json.error.code).toBe(
      'slot_started',
    )
    // A lesson row from another time stands for that time, which the coach does not work.
    const outside = h.db
      .insert(slots)
      .values({
        coachId: coach.id,
        startsAt: new Date('2026-10-27T02:00:00Z'),
        endsAt: new Date('2026-10-27T03:00:00Z'),
      })
      .returning()
      .get()
    expect((await move(h, t, id, outside.id)).json.error.code).toBe('time_unavailable')
    expect((await move(h, t, id, 99999)).status).toBe(404)
    expect(h.db.select().from(bookingMoves).all()).toHaveLength(0)
  })

  it('refuses a time the student already has a lesson at', async () => {
    const h = setup()
    const { coach, lesson, t, id } = await booked(h)
    const other = otherCoach(h, lesson.id)
    await book(h, t, h.slot(other.id, '2026-10-26', 14).id, lesson.id)
    const res = await move(h, t, id, h.slot(coach.id, '2026-10-26', 14).id)
    expect(res.json.error.code).toBe('student_clash')
  })

  it('moves to another coach only at the same price', async () => {
    const h = setup()
    const { coach, lesson, t, id } = await booked(h)
    const same = otherCoach(h, lesson.id, 20000)
    const dearer = otherCoach(h, lesson.id, 30000, { name: '张教练' })
    const away = otherCoach(h, lesson.id, null, { name: '赵教练', active: false })

    expect((await h.call('GET', `/bookings/${id}/move-options`, undefined, t)).json).toEqual({
      coachIds: [coach.id, same.id],
    })
    const pricier = await move(h, t, id, h.slot(dearer.id, '2026-10-26', 14).id)
    expect(pricier.json.error.code).toBe('price_differs')
    const inactive = await move(h, t, id, h.slot(away.id, '2026-10-26', 14).id)
    expect(inactive.json.error.code).toBe('coach_not_teaching')
    // What the student paid counts, not what their own coach charges now.
    h.db
      .update(coaches)
      .set({ categoryId: category(h, lesson.id, 30000) })
      .where(eq(coaches.id, coach.id))
      .run()
    expect((await h.call('GET', `/bookings/${id}/move-options`, undefined, t)).json).toEqual({
      coachIds: [coach.id, same.id],
    })
    expect((await move(h, t, id, h.slot(coach.id, '2026-10-26', 9).id)).status).toBe(200)
    // A second move, as if it had been booked with two.
    h.db
      .update(bookings)
      .set({ terms: { cancelDeadlineHours: 24, lateCancel: { kind: 'forfeit' }, studentMoves: 2 } })
      .where(eq(bookings.id, id))
      .run()
    const res = await move(h, t, id, h.slot(same.id, '2026-10-26', 14).id)
    expect(res.json).toMatchObject({ coach: { id: same.id, name: '李教练' }, price: 20000 })

    const admin = await h.admin()
    // The venue may move it to any coach who teaches the lesson; the price paid stays.
    const venue = await h.call(
      'POST',
      `/admin/bookings/${id}/move`,
      { slotId: h.slot(dearer.id, '2026-10-27', 14).id },
      admin,
    )
    expect(venue.status).toBe(204)
    expect(row(h, id)?.price).toBe(20000)
  })

  it('keeps the package lesson, within the coaches and dates the package covers', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const other = otherCoach(h, lesson.id)
    const product = h.db
      .insert(packageProducts)
      .values({
        name: '10 次课',
        lessonTypeId: lesson.id,
        coachIds: [coach.id],
        lessonCount: 10,
        price: 180000,
        validityDays: 5,
      })
      .returning()
      .get()
    const t = await h.student('a')
    const order = await h.call('POST', '/packages/purchase', { productId: product.id }, t)
    await h.fakePay(order.json.orderId)
    const id = await book(h, t, h.slot(coach.id, '2026-10-25', 10).id, lesson.id)
    expect(row(h, id)?.paidWith).toBe('package')

    expect((await h.call('GET', `/bookings/${id}/move-options`, undefined, t)).json).toEqual({
      coachIds: [coach.id],
    })
    const uncovered = await move(h, t, id, h.slot(other.id, '2026-10-26', 14).id)
    expect(uncovered.json.error.code).toBe('coach_not_covered')
    // Valid through the end of 10-28 at the venue.
    const expired = await move(h, t, id, h.slot(coach.id, '2026-10-29', 14).id)
    expect(expired.json.error.code).toBe('package_expires')
    const res = await move(h, t, id, h.slot(coach.id, '2026-10-28', 14).id)
    expect(res.json).toMatchObject({ paidWith: 'package', packageName: '10 次课' })
    expect((await h.call('GET', '/packages', undefined, t)).json[0].lessonsRemaining).toBe(9)

    // Nor can the coach move it past the package's dates.
    const byCoach = await h.call(
      'POST',
      `/coach/lessons/${id}/move`,
      { slotId: h.slot(coach.id, '2026-10-29', 15).id },
      await bindCoach(h, coach.id),
    )
    expect(byCoach.json.error.code).toBe('package_expires')

    // The venue decides past the package's coaches and dates.
    const admin = await h.admin()
    const venue = await h.call(
      'POST',
      `/admin/bookings/${id}/move`,
      { slotId: h.slot(other.id, '2026-10-30', 14).id },
      admin,
    )
    expect(venue.status).toBe(204)
    expect((await h.call('GET', '/packages', undefined, t)).json[0].lessonsRemaining).toBe(9)

    // Cancelling the moved lesson in time still returns the lesson.
    expect((await h.call('POST', `/bookings/${id}/cancel`, {}, t)).json.status).toBe('cancelled')
    expect((await h.call('GET', '/packages', undefined, t)).json[0].lessonsRemaining).toBe(10)
    expect(
      h.db.select().from(packageLedger).where(eq(packageLedger.bookingId, id)).all(),
    ).toMatchObject([{ kind: 'use' }, { kind: 'return' }])
  })

  it('refunds the original payment when a moved lesson is cancelled in time', async () => {
    const h = setup()
    const { coach, t, id } = await booked(h)
    await move(h, t, id, h.slot(coach.id, '2026-10-30', 14).id)
    // Past the old lesson's deadline, still well before the new one's.
    h.clock.now = new Date('2026-10-25T03:00:00Z')
    const res = await h.call('POST', `/bookings/${id}/cancel`, {}, t)
    expect(res.json).toMatchObject({ status: 'cancelled', late: false })
    expect(h.db.select().from(refunds).all()).toMatchObject([{ amount: 20000, bookingId: id }])
  })

  it('lets a student cancel for free a lesson the venue moved after the deadline', async () => {
    const h = setup()
    const { coach, t, id } = await booked(h)
    const admin = await h.admin()
    // Moved by the venue in time: the usual deadline for the new time stands.
    const early = h.slot(coach.id, '2026-10-26', 10)
    await h.call('POST', `/admin/bookings/${id}/move`, { slotId: early.id }, admin)
    const view = (await h.call('GET', `/bookings/${id}`, undefined, t)).json
    expect(view.cancelDeadline).toBe('2026-10-25T02:00:00.000Z')

    // Moved again after the deadline for that time: free until it starts.
    h.clock.now = new Date('2026-10-25T08:00:00Z')
    const late = h.slot(coach.id, '2026-10-26', 15)
    const moved = await h.call(
      'POST',
      `/admin/bookings/${id}/move`,
      { slotId: late.id },
      await h.admin(),
    )
    expect(moved.status).toBe(204)
    expect((await h.call('GET', `/bookings/${id}`, undefined, t)).json).toMatchObject({
      cancelDeadline: late.startsAt.toISOString(),
      movedLate: true,
      canMove: true,
    })
    const res = await h.call('POST', `/bookings/${id}/cancel`, {}, t)
    expect(res.json).toMatchObject({ status: 'cancelled', late: false })
    expect(h.db.select().from(refunds).all()).toMatchObject([{ amount: 20000, bookingId: id }])
  })

  it('brings the usual deadline back once the student moves a late-moved lesson', async () => {
    const h = setup()
    h.settings((s) => {
      s.booking.studentMoves = 2
    })
    const { coach, t, id } = await booked(h)
    h.clock.now = new Date('2026-10-24T03:00:00Z')
    const admin = await h.admin()
    const venueMove = await h.call(
      'POST',
      `/admin/bookings/${id}/move`,
      { slotId: h.slot(coach.id, '2026-10-24', 15).id },
      admin,
    )
    expect(venueMove.status).toBe(204)
    // Their own pick, inside the usual deadline for it: the late rule applies again.
    const own = h.slot(coach.id, '2026-10-24', 20)
    expect((await move(h, t, id, own.id)).json).toMatchObject({
      cancelDeadline: new Date(own.startsAt.getTime() - 86_400_000).toISOString(),
      movedLate: false,
      canMove: false,
      movesLeft: 1,
    })
    const res = await h.call('POST', `/bookings/${id}/cancel`, {}, t)
    expect(res.json.error.code).toBe('late_now')
  })

  it('sends one message for moves the student has not heard of yet', async () => {
    const h = setup()
    const { coach, from, id } = await booked(h)
    const admin = await h.admin()
    const moveTo = async (slotId: number) =>
      expect((await h.call('POST', `/admin/bookings/${id}/move`, { slotId }, admin)).status).toBe(
        204,
      )
    const moved = () =>
      h.db
        .select()
        .from(studentNotices)
        .where(eq(studentNotices.bookingId, id))
        .all()
        .filter((n) => n.kind === 'moved')
    await moveTo(h.slot(coach.id, '2026-10-26', 14).id)
    await moveTo(h.slot(coach.id, '2026-10-27', 14).id)
    expect(moved()).toMatchObject([
      { data: { oldTime: '2026年10月25日 10:00~11:00' }, doneAt: null },
    ])

    // Back at the time the student knows: nothing to tell.
    await moveTo(from.id)
    expect(moved()).toEqual([])

    // Once told, the next move starts from the time in that message.
    await moveTo(h.slot(coach.id, '2026-10-26', 15).id)
    h.db.update(studentNotices).set({ doneAt: h.clock.now, result: 'sent' }).run()
    await moveTo(h.slot(coach.id, '2026-10-26', 16).id)
    expect(moved().map((n) => n.data.oldTime)).toEqual([
      '2026年10月25日 10:00~11:00',
      '2026年10月26日 15:00~16:00',
    ])
  })

  it('tells the student when the lesson is back at its time with another coach', async () => {
    const h = setup()
    const { lesson, id } = await booked(h)
    const other = otherCoach(h, lesson.id)
    const admin = await h.admin()
    for (const slot of [h.slot(other.id, '2026-10-26', 14), h.slot(other.id, '2026-10-25', 10)]) {
      await h.call('POST', `/admin/bookings/${id}/move`, { slotId: slot.id }, admin)
    }
    expect(
      h.db
        .select()
        .from(studentNotices)
        .where(eq(studentNotices.bookingId, id))
        .all()
        .filter((n) => n.kind === 'moved'),
    ).toMatchObject([{ data: { oldTime: '2026年10月25日 10:00~11:00' }, doneAt: null }])
  })

  it('leaves a moved message that is being sent, and starts the next from its time', async () => {
    const h = setup()
    const { coach, id } = await booked(h)
    const sent: NoticeValues[] = []
    let release = () => {}
    h.deps.notifier = {
      template: (kind) =>
        kind === 'student_moved' ? { id: kind, fields: { a: 'time' } } : undefined,
      async send(_openid, _template, _page, values) {
        sent.push(values)
        if (sent.length === 1) await new Promise<void>((resolve) => (release = resolve))
        return 'sent'
      },
    }
    const admin = await h.admin()
    const moveTo = (slotId: number) =>
      h.call('POST', `/admin/bookings/${id}/move`, { slotId }, admin)
    await moveTo(h.slot(coach.id, '2026-10-26', 14).id)
    const sweep = notifyStudents(h.deps)
    await new Promise((resolve) => setTimeout(resolve, 0))
    await moveTo(h.slot(coach.id, '2026-10-27', 14).id)
    release()
    await sweep
    await notifyStudents(h.deps)
    expect(sent.map((v) => [v.oldTime, v.time, v.status])).toEqual([
      ['2026年10月25日 10:00~11:00', '2026年10月26日 14:00~15:00', '已改约'],
      ['2026年10月26日 14:00~15:00', '2026年10月27日 14:00~15:00', '已改约'],
    ])
  })

  it('folds a moved message waiting to be tried again; a late confirmation tells the new time', async () => {
    const h = setup()
    const sent: { kind: string; values: NoticeValues }[] = []
    let down = true
    h.deps.notifier = {
      template: (kind) =>
        kind.startsWith('student_') ? { id: kind, fields: { a: 'time' } } : undefined,
      async send(_openid, template, _page, values) {
        if (down) throw new Error('unreachable')
        sent.push({ kind: template.id, values })
        return 'sent'
      },
    }
    const { coach, id } = await booked(h)
    // The confirmation could not go out.
    await notifyStudents(h.deps)
    const admin = await h.admin()
    const moveTo = (slotId: number) =>
      h.call('POST', `/admin/bookings/${id}/move`, { slotId }, admin)
    await moveTo(h.slot(coach.id, '2026-10-26', 14).id)
    // Neither could the first move's message.
    await notifyStudents(h.deps)
    await moveTo(h.slot(coach.id, '2026-10-27', 14).id)
    down = false
    h.clock.now = new Date(h.clock.now.getTime() + 10 * 60_000)
    await notifyStudents(h.deps)
    // The student may only have subscribed to the confirmation, so it still goes out.
    expect(sent.map((s) => [s.kind, s.values.oldTime, s.values.time])).toEqual([
      ['student_booked', undefined, '2026年10月27日 14:00~15:00'],
      ['student_moved', '2026年10月25日 10:00~11:00', '2026年10月27日 14:00~15:00'],
    ])
  })

  it('folds a move made while the last move message failed to send', async () => {
    const h = setup()
    const { coach, id } = await booked(h)
    const sent: NoticeValues[] = []
    // The first send hangs until failed by hand.
    const first = { pending: true, fail: () => {} }
    h.deps.notifier = {
      template: (kind) =>
        kind === 'student_moved' ? { id: kind, fields: { a: 'time' } } : undefined,
      async send(_openid, _template, _page, values) {
        if (first.pending) {
          first.pending = false
          await new Promise<void>((_, reject) => {
            first.fail = () => reject(new Error('unreachable'))
          })
        }
        sent.push(values)
        return 'sent'
      },
    }
    const admin = await h.admin()
    const moveTo = (slotId: number) =>
      h.call('POST', `/admin/bookings/${id}/move`, { slotId }, admin)
    await moveTo(h.slot(coach.id, '2026-10-26', 14).id)
    const sweep = notifyStudents(h.deps)
    await new Promise((resolve) => setTimeout(resolve, 0))
    await moveTo(h.slot(coach.id, '2026-10-27', 14).id)
    first.fail()
    await sweep
    h.clock.now = new Date(h.clock.now.getTime() + 10 * 60_000)
    await notifyStudents(h.deps)
    await notifyStudents(h.deps)
    expect(sent.map((v) => [v.oldTime, v.time])).toEqual([
      ['2026年10月25日 10:00~11:00', '2026年10月27日 14:00~15:00'],
    ])
  })

  it('reminds once at a time the lesson moved away from and back to', async () => {
    const h = setup()
    const sent: string[] = []
    h.deps.notifier = {
      template: (kind) =>
        kind.startsWith('student_') ? { id: kind, fields: { a: 'time' } } : undefined,
      async send(_openid, template, _page, values) {
        sent.push(`${template.id} ${values.time}`)
        return 'sent'
      },
    }
    const { coach, from, id } = await booked(h)
    const moveTo = async (slotId: number) =>
      h.call('POST', `/admin/bookings/${id}/move`, { slotId }, await h.admin())
    // 08:00 at the venue, two hours before the lesson.
    h.clock.now = new Date('2026-10-25T00:00:00Z')
    await notifyStudents(h.deps)
    const later = h.slot(coach.id, '2026-10-25', 11)
    expect((await moveTo(later.id)).status).toBe(204)
    expect((await moveTo(from.id)).status).toBe(204)
    await notifyStudents(h.deps)
    // Moved for real this time: told, then reminded at the new time.
    expect((await moveTo(later.id)).status).toBe(204)
    await notifyStudents(h.deps)
    h.clock.now = new Date('2026-10-25T01:00:00Z')
    await notifyStudents(h.deps)
    expect(sent.filter((m) => !m.startsWith('student_booked'))).toEqual([
      'student_reminder 2026年10月25日 10:00~11:00',
      'student_moved 2026年10月25日 11:00~12:00',
      'student_reminder 2026年10月25日 11:00~12:00',
    ])
  })

  it('sends what is true when a message is sent, not when the batch was read', async () => {
    const h = setup()
    const { coach, lesson, id } = await booked(h)
    const other = await book(
      h,
      await h.student('b'),
      h.slot(coach.id, '2026-10-25', 14).id,
      lesson.id,
    )
    const sent: { bookingId: string; oldTime?: string; time?: string }[] = []
    const first = { pending: true, release: () => {} }
    h.deps.notifier = {
      template: (kind) =>
        kind === 'student_moved' ? { id: kind, fields: { a: 'time' } } : undefined,
      async send(_openid, _template, page, values) {
        if (first.pending) {
          first.pending = false
          await new Promise<void>((resolve) => {
            first.release = resolve
          })
        }
        sent.push({
          bookingId: page.split('=')[1] ?? '',
          oldTime: values.oldTime,
          time: values.time,
        })
        return 'sent'
      },
    }
    const admin = await h.admin()
    const moveTo = (bookingId: number, slotId: number) =>
      h.call('POST', `/admin/bookings/${bookingId}/move`, { slotId }, admin)
    await moveTo(other, h.slot(coach.id, '2026-10-26', 9).id)
    await moveTo(id, h.slot(coach.id, '2026-10-26', 14).id)
    const sweep = notifyStudents(h.deps)
    await new Promise((resolve) => setTimeout(resolve, 0))
    // While the other student's message is sending, this lesson moves again.
    await moveTo(id, h.slot(coach.id, '2026-10-27', 14).id)
    first.release()
    await sweep
    expect(sent.filter((m) => m.bookingId === String(id))).toEqual([
      {
        bookingId: String(id),
        oldTime: '2026年10月25日 10:00~11:00',
        time: '2026年10月27日 14:00~15:00',
      },
    ])
  })

  it('drops a reminder waiting to be tried again when the lesson moves', async () => {
    const h = setup()
    const sent: string[] = []
    let down = true
    h.deps.notifier = {
      template: (kind) =>
        kind.startsWith('student_') ? { id: kind, fields: { a: 'time' } } : undefined,
      async send(_openid, template, _page, values) {
        if (down && template.id === 'student_reminder') throw new Error('unreachable')
        sent.push(`${template.id} ${values.time}`)
        return 'sent'
      },
    }
    const { coach, id } = await booked(h)
    h.clock.now = new Date('2026-10-25T00:00:00Z')
    await notifyStudents(h.deps)
    const res = await h.call(
      'POST',
      `/admin/bookings/${id}/move`,
      { slotId: h.slot(coach.id, '2026-10-29', 10).id },
      await h.admin(),
    )
    expect(res.status).toBe(204)
    down = false
    h.clock.now = new Date('2026-10-25T00:10:00Z')
    await notifyStudents(h.deps)
    expect(sent.filter((m) => !m.startsWith('student_booked'))).toEqual([
      'student_moved 2026年10月29日 10:00~11:00',
    ])
  })

  it('reminds once of the new time when the move message is late', async () => {
    const h = setup()
    const sent: string[] = []
    let down = true
    h.deps.notifier = {
      template: (kind) =>
        kind.startsWith('student_') ? { id: kind, fields: { a: 'time' } } : undefined,
      async send(_openid, template, _page, values) {
        if (down && template.id === 'student_moved') throw new Error('unreachable')
        sent.push(`${template.id} ${values.time}`)
        return 'sent'
      },
    }
    const { coach, id } = await booked(h)
    const res = await h.call(
      'POST',
      `/admin/bookings/${id}/move`,
      { slotId: h.slot(coach.id, '2026-10-25', 14).id },
      await h.admin(),
    )
    expect(res.status).toBe(204)
    await notifyStudents(h.deps)
    // 12:30 at the venue: reminded of 14:00 while the move message still fails.
    h.clock.now = new Date('2026-10-25T04:30:00Z')
    await notifyStudents(h.deps)
    down = false
    h.clock.now = new Date('2026-10-25T04:40:00Z')
    await notifyStudents(h.deps)
    await notifyStudents(h.deps)
    expect(sent.filter((m) => !m.startsWith('student_booked'))).toEqual([
      'student_reminder 2026年10月25日 14:00~15:00',
      'student_moved 2026年10月25日 14:00~15:00',
    ])
  })

  it('drops a reminder waiting to be tried again when the lesson moves inside the window', async () => {
    const h = setup()
    const sent: string[] = []
    let down = true
    h.deps.notifier = {
      template: (kind) =>
        kind.startsWith('student_') ? { id: kind, fields: { a: 'time' } } : undefined,
      async send(_openid, template, _page, values) {
        if (down && template.id === 'student_reminder') throw new Error('unreachable')
        sent.push(`${template.id} ${values.time}`)
        return 'sent'
      },
    }
    const { coach, id } = await booked(h)
    h.clock.now = new Date('2026-10-25T01:00:00Z')
    await notifyStudents(h.deps)
    h.clock.now = new Date('2026-10-25T01:05:00Z')
    const res = await h.call(
      'POST',
      `/admin/bookings/${id}/move`,
      { slotId: h.slot(coach.id, '2026-10-25', 11).id },
      await h.admin(),
    )
    expect(res.status).toBe(204)
    down = false
    h.clock.now = new Date('2026-10-25T01:15:00Z')
    await notifyStudents(h.deps)
    await notifyStudents(h.deps)
    // The move message, sent inside the window, tells the time; no reminder follows it.
    expect(sent.filter((m) => !m.startsWith('student_booked'))).toEqual([
      'student_moved 2026年10月25日 11:00~12:00',
    ])
  })

  it('reminds of the new time when WeChat refused the move message', async () => {
    const h = setup()
    const sent: string[] = []
    h.deps.notifier = {
      template: (kind) =>
        kind.startsWith('student_') ? { id: kind, fields: { a: 'time' } } : undefined,
      async send(_openid, template, _page, values) {
        // The student never subscribed to move messages.
        if (template.id === 'student_moved') return 'refused'
        sent.push(`${template.id} ${values.time}`)
        return 'sent'
      },
    }
    const { coach, id } = await booked(h)
    // Confirmed when booked, days before.
    await notifyStudents(h.deps)
    h.clock.now = new Date('2026-10-25T01:05:00Z')
    const res = await h.call(
      'POST',
      `/admin/bookings/${id}/move`,
      { slotId: h.slot(coach.id, '2026-10-25', 11).id },
      await h.admin(),
    )
    expect(res.status).toBe(204)
    await notifyStudents(h.deps)
    await notifyStudents(h.deps)
    expect(sent).toEqual([
      'student_booked 2026年10月25日 10:00~11:00',
      'student_reminder 2026年10月25日 11:00~12:00',
    ])
  })

  it('names a cancelled lesson by the time the student last heard', async () => {
    const h = setup()
    const sent: string[] = []
    h.deps.notifier = {
      template: (kind) =>
        kind.startsWith('student_') ? { id: kind, fields: { a: 'time' } } : undefined,
      async send(_openid, template, _page, values) {
        if (template.id === 'student_moved') return 'refused'
        sent.push(`${template.id} ${values.time}`)
        return 'sent'
      },
    }
    const { coach, id } = await booked(h)
    const admin = await h.admin()
    await h.call(
      'POST',
      `/admin/bookings/${id}/move`,
      { slotId: h.slot(coach.id, '2026-10-27', 15).id },
      admin,
    )
    await notifyStudents(h.deps)
    await h.call('POST', `/admin/bookings/${id}/cancel`, { reason: '教练生病' }, admin)
    await notifyStudents(h.deps)
    await notifyStudents(h.deps)
    expect(sent.filter((m) => m.startsWith('student_cancelled'))).toEqual([
      'student_cancelled 2026年10月25日 10:00~11:00',
    ])
  })

  it('only moves the student’s own confirmed lessons', async () => {
    const h = setup()
    const { coach, lesson, t, id } = await booked(h)
    const other = await h.student('b')
    const to = h.slot(coach.id, '2026-10-26', 14)
    expect((await move(h, other, id, to.id)).status).toBe(404)
    expect((await h.call('GET', `/bookings/${id}/move-options`, undefined, other)).status).toBe(404)

    const hold = await h.call(
      'POST',
      '/bookings',
      { slotId: h.slot(coach.id, '2026-10-27', 9).id, lessonTypeId: lesson.id },
      t,
    )
    const unpaid = await move(h, t, hold.json.bookingId, to.id)
    expect(unpaid.json.error.code).toBe('not_movable')
    expect((await h.call('POST', `/bookings/${id}/cancel`, {}, t)).status).toBe(200)
    expect((await move(h, t, id, to.id)).json.error.code).toBe('not_movable')
  })

  it('gives a slot two students race for to one of them', async () => {
    const h = setup()
    const { coach, lesson, t, id } = await booked(h)
    const other = await h.student('b')
    const theirs = await book(h, other, h.slot(coach.id, '2026-10-25', 11).id, lesson.id)
    const to = h.slot(coach.id, '2026-10-26', 14)
    const results = await Promise.all([move(h, t, id, to.id), move(h, other, theirs, to.id)])
    expect(results.map((r) => r.status).sort()).toEqual([200, 409])
    expect(results.find((r) => r.status === 409)?.json.error.code).toBe('slot_taken')
    expect(h.db.select().from(bookings).where(eq(bookings.slotId, to.id)).all()).toHaveLength(1)
  })
})

describe('coaches moving lessons', () => {
  it('moves only their own lessons, into their own slots', async () => {
    const h = setup()
    const { coach, lesson, id } = await booked(h)
    const coachToken = await bindCoach(h, coach.id)
    const other = otherCoach(h, lesson.id)
    const theirSlot = h.slot(other.id, '2026-10-26', 14)
    const res = await h.call(
      'POST',
      `/coach/lessons/${id}/move`,
      { slotId: theirSlot.id },
      coachToken,
    )
    expect(res.status).toBe(404)

    const t = await h.student('b')
    const theirs = await book(h, t, h.slot(other.id, '2026-10-25', 14).id, lesson.id)
    const notMine = await h.call(
      'POST',
      `/coach/lessons/${theirs}/move`,
      { slotId: h.slot(coach.id, '2026-10-26', 9).id },
      coachToken,
    )
    expect(notMine.status).toBe(404)
  })
})

describe('telling coaches about moved lessons', () => {
  function notifier(h: Harness) {
    const sent: { openid: string; kind: NoticeKind; page: string; values: NoticeValues }[] = []
    const n: Notifier = {
      template: (kind) =>
        kind.startsWith('coach_') ? { id: kind, fields: { a: 'time' } } : undefined,
      async send(openid, template, page, values) {
        sent.push({ openid, kind: template.id as NoticeKind, page, values })
        return 'sent'
      },
    }
    h.deps.notifier = n
    return sent
  }

  it('tells the coach the new time once', async () => {
    const h = setup()
    const sent = notifier(h)
    const { coach, t, id } = await booked(h)
    await bindCoach(h, coach.id)
    await notifyCoaches(h.deps)
    expect(sent.map((s) => s.kind)).toEqual(['coach_booked'])
    sent.length = 0

    await move(h, t, id, h.slot(coach.id, '2026-10-26', 14).id)
    await notifyCoaches(h.deps)
    await notifyCoaches(h.deps)
    expect(sent).toEqual([
      {
        openid: 'dev_coach',
        kind: 'coach_moved',
        page: `coach/lesson/index?id=${id}`,
        values: {
          student: '学员',
          lesson: '一对一私教',
          coach: '王教练',
          time: '2026年10月26日 14:00~15:00',
          oldTime: '2026年10月25日 10:00~11:00',
        },
      },
    ])
  })

  it('tells the old coach it is off and the new coach it is new', async () => {
    const h = setup()
    const sent = notifier(h)
    const { coach, lesson, id } = await booked(h)
    await bindCoach(h, coach.id)
    const other = otherCoach(h, lesson.id)
    await bindCoach(h, other.id, 'other')
    await notifyCoaches(h.deps)
    sent.length = 0

    const admin = await h.admin()
    const to = h.slot(other.id, '2026-10-26', 14)
    await h.call('POST', `/admin/bookings/${id}/move`, { slotId: to.id }, admin)
    await notifyCoaches(h.deps)
    await notifyCoaches(h.deps)
    expect(sent.map((s) => [s.openid, s.kind, s.values.time, s.values.reason])).toEqual([
      ['dev_coach', 'coach_cancelled', '2026年10月25日 10:00~11:00', '课程已改约'],
      ['dev_other', 'coach_booked', '2026年10月26日 14:00~15:00', ''],
    ])
    expect(sent[0]?.page).toBe('coach/index/index')
  })

  it('sends nothing for a move the coach made, or one undone before the sweep', async () => {
    const h = setup()
    const sent = notifier(h)
    const { coach, from, id } = await booked(h)
    const coachToken = await bindCoach(h, coach.id)
    await notifyCoaches(h.deps)
    sent.length = 0

    const to = h.slot(coach.id, '2026-10-26', 14)
    await h.call('POST', `/coach/lessons/${id}/move`, { slotId: to.id }, coachToken)
    await notifyCoaches(h.deps)
    expect(sent).toEqual([])

    const admin = await h.admin()
    await h.call('POST', `/admin/bookings/${id}/move`, { slotId: from.id }, admin)
    // Back at its first time, it shows no 原定时间.
    expect(
      (await h.call('GET', `/coach/lessons/${id}`, undefined, coachToken)).json.movedFrom,
    ).toBe(null)
    await h.call('POST', `/admin/bookings/${id}/move`, { slotId: to.id }, admin)
    await notifyCoaches(h.deps)
    expect(sent).toEqual([])
  })

  it('cancels with the time the coach knows when a lesson moved and was cancelled', async () => {
    const h = setup()
    const sent = notifier(h)
    const { coach, lesson, t, id } = await booked(h)
    await bindCoach(h, coach.id)
    const other = otherCoach(h, lesson.id)
    await bindCoach(h, other.id, 'other')
    await notifyCoaches(h.deps)
    sent.length = 0

    await move(h, t, id, h.slot(other.id, '2026-10-26', 14).id)
    await h.call('POST', `/bookings/${id}/cancel`, {}, t)
    await notifyCoaches(h.deps)
    // The lesson is no longer theirs to open, so the message opens their schedule.
    expect(sent.map((s) => [s.openid, s.kind, s.values.time, s.page])).toEqual([
      ['dev_coach', 'coach_cancelled', '2026年10月25日 10:00~11:00', 'coach/index/index'],
    ])
  })

  it('tells the old coach when the new coach moves or cancels before the sweep', async () => {
    for (const then of ['move', 'cancel'] as const) {
      const h = setup()
      const sent = notifier(h)
      const { coach, lesson, id } = await booked(h)
      await bindCoach(h, coach.id)
      const other = otherCoach(h, lesson.id)
      const otherToken = await bindCoach(h, other.id, 'other')
      await notifyCoaches(h.deps)
      sent.length = 0

      const admin = await h.admin()
      await h.call(
        'POST',
        `/admin/bookings/${id}/move`,
        { slotId: h.slot(other.id, '2026-10-26', 14).id },
        admin,
      )
      const res =
        then === 'move'
          ? await h.call(
              'POST',
              `/coach/lessons/${id}/move`,
              { slotId: h.slot(other.id, '2026-10-26', 16).id },
              otherToken,
            )
          : await h.call('POST', `/coach/lessons/${id}/cancel`, { reason: '生病' }, otherToken)
      expect(res.status).toBe(200)
      await notifyCoaches(h.deps)
      await notifyCoaches(h.deps)
      expect(sent.map((s) => [s.openid, s.kind, s.values.time, s.values.reason])).toEqual(
        then === 'move'
          ? [
              ['dev_coach', 'coach_cancelled', '2026年10月25日 10:00~11:00', '课程已改约'],
              ['dev_other', 'coach_booked', '2026年10月26日 16:00~17:00', ''],
            ]
          : [['dev_coach', 'coach_cancelled', '2026年10月25日 10:00~11:00', '课程已改约']],
      )
    }
  })

  it('keeps a move the coach made while their new-lesson message was sending', async () => {
    const h = setup()
    const { coach, id } = await booked(h)
    const coachToken = await bindCoach(h, coach.id)
    const sent: NoticeKind[] = []
    let release = () => {}
    h.deps.notifier = {
      template: (kind) => ({ id: kind, fields: { a: 'time' } }),
      async send(_openid, template, _page, _values) {
        sent.push(template.id as NoticeKind)
        if (sent.length === 1) await new Promise<void>((resolve) => (release = resolve))
        return 'sent'
      },
    }
    const sweep = notifyCoaches(h.deps)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const res = await h.call(
      'POST',
      `/coach/lessons/${id}/move`,
      { slotId: h.slot(coach.id, '2026-10-26', 14).id },
      coachToken,
    )
    expect(res.status).toBe(200)
    release()
    await sweep
    await notifyCoaches(h.deps)
    expect(sent).toEqual(['coach_booked'])
  })

  it('announces a new time as off and new when there is no moved template', async () => {
    const h = setup()
    const sent = notifier(h)
    const template = h.deps.notifier?.template
    if (!h.deps.notifier || !template) throw new Error('no notifier')
    h.deps.notifier.template = (kind) => (kind === 'coach_moved' ? undefined : template(kind))
    const { coach, t, id } = await booked(h)
    await bindCoach(h, coach.id)
    await notifyCoaches(h.deps)
    sent.length = 0

    await move(h, t, id, h.slot(coach.id, '2026-10-26', 14).id)
    await notifyCoaches(h.deps)
    await notifyCoaches(h.deps)
    expect(sent.map((s) => [s.kind, s.values.time, s.values.reason, s.page])).toEqual([
      [
        'coach_cancelled',
        '2026年10月25日 10:00~11:00',
        '课程已改约',
        `coach/lesson/index?id=${id}`,
      ],
      ['coach_booked', '2026年10月26日 14:00~15:00', '', `coach/lesson/index?id=${id}`],
    ])
  })

  it('tries again later when WeChat is unreachable', async () => {
    const h = setup()
    const sent = notifier(h)
    const { coach, t, id } = await booked(h)
    await bindCoach(h, coach.id)
    await notifyCoaches(h.deps)
    sent.length = 0
    await move(h, t, id, h.slot(coach.id, '2026-10-26', 14).id)

    const send = h.deps.notifier?.send
    if (!h.deps.notifier || !send) throw new Error('no notifier')
    h.deps.notifier.send = async () => {
      throw new Error('offline')
    }
    await notifyCoaches(h.deps)
    h.deps.notifier.send = send
    await notifyCoaches(h.deps)
    expect(sent.map((s) => s.kind)).toEqual(['coach_moved'])
  })
})

describe('a moved lesson in 课程详情', () => {
  it('points the old time to the new one and keeps the booking in both logs', async () => {
    const h = setup()
    const { coach, from, id } = await booked(h)
    const admin = await h.admin()
    const to = h.slot(coach.id, '2026-10-26', 10)
    expect(
      (await h.call('POST', `/admin/bookings/${id}/move`, { slotId: to.id }, admin)).status,
    ).toBe(204)
    const old = await h.call('GET', `/admin/slots/${from.id}`, undefined, admin)
    expect(old.json.movedTo).toEqual({ slotId: to.id, startsAt: to.startsAt.toISOString() })
    const now = await h.call('GET', `/admin/slots/${to.id}`, undefined, admin)
    expect(now.json.movedTo).toBeNull()
    for (const slotId of [from.id, to.id]) {
      const log = await h.call('GET', `/admin/actions?slotId=${slotId}`, undefined, admin)
      expect(log.json.map((e: { action: string }) => e.action)).toContain('booking.move')
    }
  })
})
