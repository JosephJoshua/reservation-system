import { venueInstant } from '@rs/shared'
import { and, eq, inArray } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { immediate } from './db/client'
import {
  bookings,
  coaches,
  coachLessonTypes,
  lessonTypes,
  orders,
  packageProducts,
  packages,
  refunds,
  slots,
} from './db/schema'
import { notifyCoaches } from './services/coach-notices'
import { syncSlots } from './services/coaches'
import { applyPayment } from './services/orders'
import { cancelUnderfilledSessions, UNDERFILLED_REASON } from './services/sessions'
import { type Harness, setup } from './test/harness'
import type { Notifier } from './wx-notify'

// The clock starts at 2026-10-23 10:00 venue time.

/** One coach who teaches a private lesson and a 60-minute group class for 4 at ¥80. */
function seedGroup(h: Harness, group: Partial<typeof lessonTypes.$inferInsert> = {}) {
  const seeded = h.seed()
  const kids = h.db
    .insert(lessonTypes)
    .values({ name: '少儿小班课', durationMinutes: 60, price: 8000, capacity: 4, ...group })
    .returning()
    .get()
  h.db.insert(coachLessonTypes).values({ coachId: seeded.coach.id, lessonTypeId: kids.id }).run()
  return { ...seeded, kids }
}

async function schedule(
  h: Harness,
  admin: string,
  input: { lessonTypeId: number; coachId: number; date?: string; hour?: number; capacity?: number },
) {
  const date = input.date ?? '2026-10-26'
  const hour = input.hour ?? 10
  return h.call(
    'POST',
    '/admin/sessions',
    {
      lessonTypeId: input.lessonTypeId,
      capacity: input.capacity ?? 4,
      sessions: [
        {
          coachId: input.coachId,
          startsAt: venueInstant(date, hour * 60).toISOString(),
          endsAt: venueInstant(date, hour * 60 + 60).toISOString(),
        },
      ],
    },
    admin,
  )
}

async function session(
  h: Harness,
  admin: string,
  lessonTypeId: number,
  coachId: number,
  hour = 10,
) {
  const res = await schedule(h, admin, { lessonTypeId, coachId, hour })
  expect(res.status).toBe(201)
  return res.json.ids[0] as number
}

function book(h: Harness, token: string, slotId: number, lessonTypeId: number, payWith?: string) {
  return h.call('POST', '/bookings', { slotId, lessonTypeId, payWith }, token)
}

/** Logs students in, one token per name. */
async function students<N extends string[]>(h: Harness, ...names: N) {
  return (await Promise.all(names.map((n) => h.student(n)))) as { [K in keyof N]: string }
}

/** Books and pays a seat. */
async function seat(h: Harness, token: string, slotId: number, lessonTypeId: number) {
  const res = await book(h, token, slotId, lessonTypeId)
  expect(res.status).toBe(201)
  if (res.json.orderId) await h.call('POST', `/dev/fake-pay/${res.json.orderId}`)
  return res.json.bookingId as number
}

const live = (h: Harness, slotId: number) =>
  h.db
    .select()
    .from(bookings)
    .where(
      and(eq(bookings.slotId, slotId), inArray(bookings.status, ['pending_payment', 'confirmed'])),
    )
    .all()

describe('group class lesson types', () => {
  it('saves capacity and a minimum headcount, and refuses odd ones', async () => {
    const h = setup()
    const admin = await h.admin()
    const base = { name: '小班课', durationMinutes: 90, price: 8000 }
    const ok = await h.call(
      'POST',
      '/admin/lesson-types',
      { ...base, capacity: 6, minStudents: 3 },
      admin,
    )
    expect(ok.status).toBe(201)
    expect(ok.json).toMatchObject({ capacity: 6, minStudents: 3 })
    for (const [body, message] of [
      [{ capacity: 6, minStudents: 7 }, '最低开班人数需在 2 到人数上限之间'],
      [{ capacity: 1, minStudents: 2 }, '一对一课程不设开班人数'],
      [{ capacity: 6, isTrial: true }, '体验课不能设为小班课'],
      [{ capacity: 31 }, '人数上限超出允许范围'],
      [{ capacity: 0 }, '人数上限超出允许范围'],
    ] as const) {
      const res = await h.call('POST', '/admin/lesson-types', { ...base, ...body }, admin)
      expect(res.status).toBe(400)
      expect(res.json.error.message).toBe(message)
    }
  })

  it('keeps a lesson type private or group once it has sessions or bookings', async () => {
    const h = setup()
    const { coach, lesson, kids } = seedGroup(h)
    const admin = await h.admin()
    const put = (t: typeof lessonTypes.$inferSelect, capacity: number) =>
      h.call(
        'PUT',
        `/admin/lesson-types/${t.id}`,
        {
          name: t.name,
          durationMinutes: t.durationMinutes,
          price: t.price,
          capacity,
        },
        admin,
      )
    // Nothing scheduled yet: free to change.
    expect((await put(kids, 6)).status).toBe(200)
    await session(h, admin, kids.id, coach.id)
    expect((await put(kids, 8)).status).toBe(200)
    const locked = await put(kids, 1)
    expect(locked.status).toBe(409)
    expect(locked.json.error.code).toBe('capacity_locked')

    const t = await h.student('a')
    await seat(h, t, h.slot(coach.id, '2026-10-27').id, lesson.id)
    expect((await put(lesson, 4)).json.error?.code).toBe('capacity_locked')
  })

  it('keeps the length of a group class that has sessions, even unbooked ones', async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h)
    const admin = await h.admin()
    await session(h, admin, kids.id, coach.id)
    const res = await h.call(
      'PUT',
      `/admin/lesson-types/${kids.id}`,
      { name: kids.name, durationMinutes: 90, price: kids.price, capacity: 4 },
      admin,
    )
    expect(res.status).toBe(409)
    expect(res.json.error.code).toBe('duration_locked')
  })

  it('shows capacity in the catalog', async () => {
    const h = setup()
    const { kids } = seedGroup(h)
    const t = await h.student('a')
    const catalog = (await h.call('GET', '/catalog', undefined, t)).json
    expect(catalog.lessonTypes.find((l: { id: number }) => l.id === kids.id)).toMatchObject({
      capacity: 4,
    })
  })
})

describe('scheduling sessions', () => {
  it('closes the free private slots it overlaps and keeps them closed', async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h)
    const admin = await h.admin()
    const privateSlot = h.slot(coach.id, '2026-10-26', 10)
    const id = await session(h, admin, kids.id, coach.id)
    expect(h.db.select().from(slots).where(eq(slots.id, privateSlot.id)).get()?.open).toBe(false)
    expect(h.db.select().from(slots).where(eq(slots.id, id)).get()).toMatchObject({
      lessonTypeId: kids.id,
      capacity: 4,
      open: true,
    })
    // Neither the admin nor the coach can reopen it while the session is on.
    const reopen = await h.call('PATCH', `/admin/slots/${privateSlot.id}`, { open: true }, admin)
    expect(reopen.status).toBe(409)
    expect(reopen.json.error.code).toBe('session_overlap')
  })

  it('opens the private slots again once the session is deleted, and the sync never opens them under one', async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h)
    const admin = await h.admin()
    const open = h.slot(coach.id, '2026-10-26', 10)
    // Closed by the sync on a day off that has since been lifted.
    const synced = h.slot(coach.id, '2026-10-27', 10)
    h.db.update(slots).set({ open: false, closedBySync: true }).where(eq(slots.id, synced.id)).run()
    const first = await session(h, admin, kids.id, coach.id)
    const second = (
      await schedule(h, admin, { lessonTypeId: kids.id, coachId: coach.id, date: '2026-10-27' })
    ).json.ids[0]
    const isOpen = (id: number) => h.db.select().from(slots).where(eq(slots.id, id)).get()?.open
    immediate(h.db, (tx) => syncSlots(tx, coach.id, h.clock.now))
    expect([isOpen(open.id), isOpen(synced.id), isOpen(first), isOpen(second)]).toEqual([
      false,
      false,
      true,
      true,
    ])
    expect((await h.call('DELETE', `/admin/slots/${first}`, undefined, admin)).status).toBe(204)
    expect((await h.call('DELETE', `/admin/slots/${second}`, undefined, admin)).status).toBe(204)
    expect([isOpen(open.id), isOpen(synced.id)]).toEqual([true, true])
  })

  it('refuses fewer seats than the class needs to go ahead', async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h, { minStudents: 3 })
    const admin = await h.admin()
    const res = await schedule(h, admin, { lessonTypeId: kids.id, coachId: coach.id, capacity: 2 })
    expect(res.status).toBe(400)
    expect(res.json.error.message).toBe('人数需在 3 到 30 之间')
    const id = await session(h, admin, kids.id, coach.id)
    const patch = await h.call('PATCH', `/admin/slots/${id}`, { capacity: 2 }, admin)
    expect(patch.status).toBe(400)
    expect(patch.json.error.code).toBe('invalid_capacity')
  })

  it('refuses a time with a booked lesson, another session, a wrong length or coach', async () => {
    const h = setup()
    const { coach, lesson, kids } = seedGroup(h)
    const admin = await h.admin()
    const t = await h.student('a')
    await seat(h, t, h.slot(coach.id, '2026-10-26', 9).id, lesson.id)
    const booked = await schedule(h, admin, { lessonTypeId: kids.id, coachId: coach.id, hour: 9 })
    expect(booked.status).toBe(409)
    expect(booked.json.error.message).toBe('10月26日 09:00 该教练已有预约')

    await session(h, admin, kids.id, coach.id, 11)
    const twice = await schedule(h, admin, { lessonTypeId: kids.id, coachId: coach.id, hour: 11 })
    expect(twice.json.error.message).toBe('10月26日 11:00 与该教练已有的小班课重叠')

    const wrongLength = await h.call(
      'POST',
      '/admin/sessions',
      {
        lessonTypeId: kids.id,
        capacity: 4,
        sessions: [
          {
            coachId: coach.id,
            startsAt: venueInstant('2026-10-26', 14 * 60).toISOString(),
            endsAt: venueInstant('2026-10-26', 14 * 60 + 90).toISOString(),
          },
        ],
      },
      admin,
    )
    expect(wrongLength.json.error.code).toBe('duration_mismatch')

    const other = h.db.insert(coaches).values({ name: '李教练' }).returning().get()
    const notTeaching = await schedule(h, admin, { lessonTypeId: kids.id, coachId: other.id })
    expect(notTeaching.json.error.code).toBe('coach_not_teaching')

    const notGroup = await schedule(h, admin, {
      lessonTypeId: lesson.id,
      coachId: coach.id,
      hour: 15,
    })
    expect(notGroup.json.error.code).toBe('not_group')

    // All or none: a later session that fails leaves no earlier one behind.
    const before = h.db.select().from(slots).all().length
    const mixed = await h.call(
      'POST',
      '/admin/sessions',
      {
        lessonTypeId: kids.id,
        capacity: 4,
        sessions: [16, 11].map((hour) => ({
          coachId: coach.id,
          startsAt: venueInstant('2026-10-26', hour * 60).toISOString(),
          endsAt: venueInstant('2026-10-26', hour * 60 + 60).toISOString(),
        })),
      },
      admin,
    )
    expect(mixed.status).toBe(409)
    expect(h.db.select().from(slots).all()).toHaveLength(before)
  })

  it('leaves group lengths out of the weekly hours a coach can set', async () => {
    const h = setup()
    const { coach } = seedGroup(h, { durationMinutes: 90 })
    const admin = await h.admin()
    const hours = (await h.call('GET', `/admin/coaches/${coach.id}/hours`, undefined, admin)).json
    expect(hours.lessonMinutes).toEqual([60])
  })
})

describe('booking seats', () => {
  it('lists sessions with the seats left, apart from private slots', async () => {
    const h = setup()
    const { coach, lesson, kids } = seedGroup(h)
    const admin = await h.admin()
    const id = await session(h, admin, kids.id, coach.id, 10)
    const privateSlot = h.slot(coach.id, '2026-10-26', 14)
    const t = await h.student('a')
    await seat(h, t, id, kids.id)
    const group = (
      await h.call('GET', `/slots?date=2026-10-26&lessonTypeId=${kids.id}`, undefined, t)
    ).json
    expect(group).toEqual([
      expect.objectContaining({ id, capacity: 4, seatsLeft: 3, available: true }),
    ])
    const solo = (
      await h.call('GET', `/slots?date=2026-10-26&lessonTypeId=${lesson.id}`, undefined, t)
    ).json
    expect(solo).toEqual([
      expect.objectContaining({ id: privateSlot.id, capacity: 1, seatsLeft: 1 }),
    ])
  })

  it('gives exactly the seats there are to students racing for them', async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h)
    const admin = await h.admin()
    const id = await session(h, admin, kids.id, coach.id)
    const tokens = await Promise.all(Array.from({ length: 12 }, (_, i) => h.student(`s${i}`)))
    const results = await Promise.all(tokens.map((t) => book(h, t, id, kids.id)))
    expect(results.filter((r) => r.status === 201)).toHaveLength(4)
    for (const r of results.filter((r) => r.status !== 201)) {
      expect(r.status).toBe(409)
      expect(r.json.error).toMatchObject({ code: 'slot_taken', message: '该课已满员' })
    }
    expect(
      live(h, id)
        .map((b) => b.seat)
        .sort(),
    ).toEqual([1, 2, 3, 4])
    const t = await h.student('late')
    const slotsNow = (
      await h.call('GET', `/slots?date=2026-10-26&lessonTypeId=${kids.id}`, undefined, t)
    ).json
    expect(slotsNow[0]).toMatchObject({ seatsLeft: 0, available: false })
  })

  it('treats a double tap as one seat', async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h)
    const admin = await h.admin()
    const id = await session(h, admin, kids.id, coach.id)
    const t = await h.student('a')
    const [a, b] = await Promise.all([book(h, t, id, kids.id), book(h, t, id, kids.id)])
    expect([a.status, b.status]).toEqual([201, 201])
    expect(b.json.bookingId).toBe(a.json.bookingId)
    expect(live(h, id)).toHaveLength(1)
  })

  it('refuses two seats for one student and two bookings in one seat at the database', async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h)
    const admin = await h.admin()
    const id = await session(h, admin, kids.id, coach.id)
    const t = await h.student('a')
    await h.student('b')
    await seat(h, t, id, kids.id)
    const row = live(h, id)[0]
    if (!row) throw new Error('no booking')
    expect(() =>
      h.db
        .insert(bookings)
        .values({ ...row, id: undefined, seat: 2 })
        .run(),
    ).toThrow(/UNIQUE/)
    expect(() =>
      h.db
        .insert(bookings)
        .values({ ...row, id: undefined, studentId: 2 })
        .run(),
    ).toThrow(/UNIQUE/)
  })

  it('keeps group classes and private lessons in their own slots', async () => {
    const h = setup()
    const { coach, lesson, kids } = seedGroup(h)
    const admin = await h.admin()
    const id = await session(h, admin, kids.id, coach.id)
    const t = await h.student('a')
    const privateInSession = await book(h, t, id, lesson.id)
    expect(privateInSession.json.error.code).toBe('lesson_type_mismatch')
    const groupInPrivate = await book(h, t, h.slot(coach.id, '2026-10-27').id, kids.id)
    expect(groupInPrivate.json.error.code).toBe('lesson_type_mismatch')
    const quote = await h.call(
      'GET',
      `/bookings/quote?slotId=${id}&lessonTypeId=${lesson.id}`,
      undefined,
      t,
    )
    expect(quote.json.error.code).toBe('lesson_type_mismatch')
  })

  it('pays a seat from a group class package and gives the lesson back on cancel', async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h)
    const admin = await h.admin()
    const product = h.db
      .insert(packageProducts)
      .values({
        name: '小班课 10 次',
        lessonTypeId: kids.id,
        lessonCount: 10,
        price: 70000,
        validityDays: 90,
      })
      .returning()
      .get()
    const t = await h.student('a')
    const bought = await h.call('POST', '/packages/purchase', { productId: product.id }, t)
    await h.call('POST', `/dev/fake-pay/${bought.json.orderId}`)
    const id = await session(h, admin, kids.id, coach.id)
    const quote = await h.call(
      'GET',
      `/bookings/quote?slotId=${id}&lessonTypeId=${kids.id}`,
      undefined,
      t,
    )
    expect(quote.json.package).toMatchObject({ name: '小班课 10 次', lessonsRemaining: 10 })
    const res = await book(h, t, id, kids.id)
    expect(res.json).toMatchObject({ status: 'confirmed', orderId: null })
    expect(h.db.select().from(packages).get()?.lessonsRemaining).toBe(9)
    const cancel = await h.call('POST', `/bookings/${res.json.bookingId}/cancel`, {}, t)
    expect(cancel.status).toBe(200)
    expect(h.db.select().from(packages).get()?.lessonsRemaining).toBe(10)
  })

  it('frees a seat on cancel for the next student', async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h, { capacity: 2 })
    const admin = await h.admin()
    const id = await session(h, admin, kids.id, coach.id, 10)
    h.db.update(slots).set({ capacity: 2 }).where(eq(slots.id, id)).run()
    const [a, b, c] = await students(h, 'a', 'b', 'c')
    const first = await seat(h, a, id, kids.id)
    await seat(h, b, id, kids.id)
    expect((await book(h, c, id, kids.id)).status).toBe(409)
    await h.call('POST', `/bookings/${first}/cancel`, {}, a)
    expect((await book(h, c, id, kids.id)).status).toBe(201)
    expect(
      live(h, id)
        .map((r) => r.seat)
        .sort(),
    ).toEqual([1, 2])
  })

  it('books a seat at the front desk', async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h)
    const admin = await h.admin()
    const id = await session(h, admin, kids.id, coach.id)
    await h.student('a')
    const res = await h.call(
      'POST',
      '/admin/bookings',
      {
        studentId: 1,
        slotId: id,
        lessonTypeId: kids.id,
        payWith: 'offline',
        amount: 8000,
        method: 'cash',
      },
      admin,
    )
    expect(res.status).toBe(201)
    expect(live(h, id)).toHaveLength(1)
    const again = await h.call(
      'POST',
      '/admin/bookings',
      {
        studentId: 1,
        slotId: id,
        lessonTypeId: kids.id,
        payWith: 'offline',
        amount: 8000,
        method: 'cash',
      },
      admin,
    )
    expect(again.json.error.code).toBe('student_clash')
  })
})

describe('late payments', () => {
  it('confirms a seat whose hold ran out while the session has room, and refunds when full', async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h, { capacity: 2 })
    const admin = await h.admin()
    const id = await session(h, admin, kids.id, coach.id)
    h.db.update(slots).set({ capacity: 2 }).where(eq(slots.id, id)).run()
    const [a, b, c] = await students(h, 'a', 'b', 'c')
    const held = await book(h, a, id, kids.id)
    const order = h.db.select().from(orders).where(eq(orders.id, held.json.orderId)).get()
    if (!order) throw new Error('no order')
    // The hold runs out; another student takes seat 1.
    h.db
      .update(bookings)
      .set({ status: 'expired' })
      .where(eq(bookings.id, held.json.bookingId))
      .run()
    h.db.update(orders).set({ status: 'closed' }).where(eq(orders.id, order.id)).run()
    await seat(h, b, id, kids.id)
    const paid = (outTradeNo: string) => {
      const state = h.gateway.pay(outTradeNo, h.deps.now()).order
      if (state.state !== 'paid') throw new Error('not paid')
      applyPayment(h.deps, outTradeNo, state)
    }
    paid(order.outTradeNo)
    const revived = h.db.select().from(bookings).where(eq(bookings.id, held.json.bookingId)).get()
    expect(revived).toMatchObject({ status: 'confirmed', seat: 2 })

    // Now full: a late payment for another lapsed hold is refunded in full.
    h.db.update(slots).set({ capacity: 3 }).where(eq(slots.id, id)).run()
    const other = await book(h, c, id, kids.id)
    const otherOrder = h.db.select().from(orders).where(eq(orders.id, other.json.orderId)).get()
    h.db
      .update(bookings)
      .set({ status: 'expired' })
      .where(eq(bookings.id, other.json.bookingId))
      .run()
    h.db.update(slots).set({ capacity: 2 }).where(eq(slots.id, id)).run()
    paid(otherOrder?.outTradeNo ?? '')
    expect(
      h.db.select().from(bookings).where(eq(bookings.id, other.json.bookingId)).get()?.status,
    ).toBe('expired')
    expect(h.db.select().from(refunds).get()).toMatchObject({
      orderId: otherOrder?.id,
      amount: 8000,
    })
    expect(live(h, id)).toHaveLength(2)
  })
})

describe('moving seats', () => {
  it('moves a seat to another session of the same class only', async () => {
    const h = setup()
    const { coach, lesson, kids } = seedGroup(h)
    const admin = await h.admin()
    const from = await session(h, admin, kids.id, coach.id, 10)
    const to = await session(h, admin, kids.id, coach.id, 14)
    const t = await h.student('a')
    const id = await seat(h, t, from, kids.id)
    const toPrivate = await h.call(
      'POST',
      `/bookings/${id}/move`,
      { slotId: h.slot(coach.id, '2026-10-27').id },
      t,
    )
    expect(toPrivate.json.error.code).toBe('lesson_type_mismatch')
    const moved = await h.call('POST', `/bookings/${id}/move`, { slotId: to }, t)
    expect(moved.status).toBe(200)
    expect(h.db.select().from(bookings).where(eq(bookings.id, id)).get()).toMatchObject({
      slotId: to,
      seat: 1,
    })
    // A private lesson cannot move into a session either.
    const p = await seat(h, t, h.slot(coach.id, '2026-10-28').id, lesson.id)
    const privateToSession = await h.call(
      'POST',
      `/admin/bookings/${p}/move`,
      { slotId: from },
      admin,
    )
    expect(privateToSession.json.error.code).toBe('lesson_type_mismatch')
  })

  it('refuses a full session', async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h)
    const admin = await h.admin()
    const from = await session(h, admin, kids.id, coach.id, 10)
    const to = await session(h, admin, kids.id, coach.id, 14)
    h.db.update(slots).set({ capacity: 2 }).where(eq(slots.id, to)).run()
    const [a, b, c] = await students(h, 'a', 'b', 'c')
    await seat(h, b, to, kids.id)
    await seat(h, c, to, kids.id)
    const id = await seat(h, a, from, kids.id)
    const res = await h.call('POST', `/admin/bookings/${id}/move`, { slotId: to }, admin)
    expect(res.json.error).toMatchObject({ code: 'slot_taken', message: '该课已满员' })
  })
})

describe('the coach and group sessions', () => {
  async function bound(h: Harness) {
    const seeded = seedGroup(h)
    const admin = await h.admin()
    const { code } = (
      await h.call('POST', `/admin/coaches/${seeded.coach.id}/bind-code`, {}, admin)
    ).json
    const res = await h.call('POST', '/coach/bind', { code: 'dev:coach', bindCode: code })
    return { ...seeded, admin, token: res.json.token as string }
  }

  it('shows the session on the schedule and its roster', async () => {
    const h = setup()
    const { coach, kids, admin, token } = await bound(h)
    const id = await session(h, admin, kids.id, coach.id)
    const [a, b] = await students(h, 'a', 'b')
    await h.call('PUT', '/me', { name: '小明' }, a)
    await h.call('PUT', '/me', { name: '小红' }, b)
    const first = await seat(h, a, id, kids.id)
    await seat(h, b, id, kids.id)
    const schedule = (
      await h.call('GET', '/coach/schedule?from=2026-10-26&to=2026-10-26', undefined, token)
    ).json
    expect(schedule).toEqual([
      expect.objectContaining({
        id,
        lesson: null,
        group: { lessonTypeName: '少儿小班课', capacity: 4, booked: 2, cancelled: false },
      }),
    ])
    const roster = (await h.call('GET', `/coach/sessions/${id}`, undefined, token)).json
    expect(roster).toMatchObject({
      id,
      capacity: 4,
      lessonTypeName: '少儿小班课',
      cancelled: false,
    })
    expect(roster.students.map((s: { name: string }) => s.name)).toEqual(['小明', '小红'])

    // Attendance and the lesson page work per student; cancel and move are the venue's.
    h.clock.now = venueInstant('2026-10-26', 10 * 60 + 30)
    expect(
      (await h.call('PUT', `/coach/lessons/${first}/attendance`, { attendance: 'attended' }, token))
        .status,
    ).toBe(200)
    const lesson = (await h.call('GET', `/coach/lessons/${first}`, undefined, token)).json
    expect(lesson).toMatchObject({
      sessionId: id,
      attendance: 'attended',
      canCancel: false,
      canMove: false,
    })
    h.clock.now = venueInstant('2026-10-25', 10 * 60)
    const cancel = await h.call('POST', `/coach/lessons/${first}/cancel`, { reason: '有事' }, token)
    expect(cancel.json.error.code).toBe('group_lesson')
    const close = await h.call('PUT', `/coach/slots/${id}`, { open: false }, token)
    expect(close.json.error.code).toBe('group_lesson')
  })

  it('tells the coach once that a session has students and once that it is off', async () => {
    const h = setup()
    const sent: { page: string; data: Record<string, string> }[] = []
    const notifier: Notifier = {
      template: (kind) =>
        kind.startsWith('coach_') ? { id: kind, fields: { thing1: 'student' } } : undefined,
      async send(_openid, _template, page, values) {
        sent.push({ page, data: { ...values } })
        return 'sent'
      },
    }
    h.deps.notifier = notifier
    const { coach, kids, admin } = await bound(h)
    const id = await session(h, admin, kids.id, coach.id)
    const [a, b] = await students(h, 'a', 'b')
    await seat(h, a, id, kids.id)
    await notifyCoaches(h.deps)
    await seat(h, b, id, kids.id)
    await notifyCoaches(h.deps)
    expect(sent).toEqual([
      {
        page: `coach/session/index?id=${id}`,
        data: expect.objectContaining({ student: '已有 1 人报名' }),
      },
    ])
    await h.call('POST', `/admin/slots/${id}/cancel`, { reason: '场地维修' }, admin)
    await notifyCoaches(h.deps)
    await notifyCoaches(h.deps)
    expect(sent).toHaveLength(2)
    expect(sent[1]?.data).toMatchObject({ reason: '场地维修' })
  })
})

describe('calling off a session', () => {
  it('cancels every seat, gives everything back and closes the session', async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h)
    const admin = await h.admin()
    const id = await session(h, admin, kids.id, coach.id)
    const [a, b, c] = await students(h, 'a', 'b', 'c')
    await seat(h, a, id, kids.id)
    await seat(h, b, id, kids.id)
    // An unpaid hold is released too.
    const held = await book(h, c, id, kids.id)
    const res = await h.call('POST', `/admin/slots/${id}/cancel`, { reason: '场地维修' }, admin)
    expect(res.status).toBe(204)
    expect(live(h, id)).toHaveLength(0)
    const rows = h.db.select().from(bookings).where(eq(bookings.slotId, id)).all()
    expect(
      rows.filter((r) => r.status === 'cancelled' && r.cancelReason === '场地维修'),
    ).toHaveLength(3)
    expect(
      h.db
        .select()
        .from(refunds)
        .all()
        .map((r) => r.amount),
    ).toEqual([8000, 8000])
    expect(h.db.select().from(orders).where(eq(orders.id, held.json.orderId)).get()?.status).toBe(
      'closed',
    )
    expect(h.db.select().from(slots).where(eq(slots.id, id)).get()).toMatchObject({
      open: false,
      cancelReason: '场地维修',
    })
    // A repeat does nothing more; the session cannot be reopened or booked.
    expect(
      (await h.call('POST', `/admin/slots/${id}/cancel`, { reason: '场地维修' }, admin)).status,
    ).toBe(204)
    expect(h.db.select().from(refunds).all()).toHaveLength(2)
    const reopen = await h.call('PATCH', `/admin/slots/${id}`, { open: true }, admin)
    expect(reopen.json.error.code).toBe('session_cancelled')
    const t = await h.student('d')
    expect((await book(h, t, id, kids.id)).json.error.code).toBe('slot_closed')
    const log = (await h.call('GET', '/admin/actions?actions=session.cancel', undefined, admin))
      .json
    expect(log).toEqual([
      expect.objectContaining({
        summary: '10月26日 10:00 王教练 少儿小班课，原因：场地维修，取消 3 人的预约',
      }),
    ])
  })

  it('calls off a session short of the minimum at the free-cancel deadline, once', async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h, { minStudents: 2 })
    const admin = await h.admin()
    const short = await session(h, admin, kids.id, coach.id, 10)
    const full = await session(h, admin, kids.id, coach.id, 14)
    const [a, b, c] = await students(h, 'a', 'b', 'c')
    const lonely = await seat(h, a, short, kids.id)
    await seat(h, b, full, kids.id)
    await seat(h, c, full, kids.id)

    // A day ahead of the deadline nothing happens.
    h.clock.now = venueInstant('2026-10-25', 9 * 60)
    await cancelUnderfilledSessions(h.deps)
    expect(live(h, short)).toHaveLength(1)

    h.clock.now = venueInstant('2026-10-25', 10 * 60)
    await cancelUnderfilledSessions(h.deps)
    expect(h.db.select().from(bookings).where(eq(bookings.id, lonely)).get()).toMatchObject({
      status: 'cancelled',
      cancelledBy: 'venue',
      cancelReason: UNDERFILLED_REASON,
    })
    expect(
      h.db
        .select()
        .from(refunds)
        .all()
        .map((r) => r.amount),
    ).toEqual([8000])
    expect(live(h, full)).toHaveLength(2)

    // The full one goes ahead at its deadline; a student cancelling late does not call it off.
    h.clock.now = venueInstant('2026-10-25', 14 * 60)
    await cancelUnderfilledSessions(h.deps)
    h.clock.now = venueInstant('2026-10-25', 15 * 60)
    const [late] = live(h, full)
    await h.call('POST', `/bookings/${late?.id}/cancel`, { acceptLate: true }, b)
    await cancelUnderfilledSessions(h.deps)
    expect(live(h, full)).toHaveLength(1)
  })

  it('waits for a student paying at the deadline who would make up the number', async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h, { minStudents: 2 })
    const admin = await h.admin()
    const id = await session(h, admin, kids.id, coach.id)
    const [a, b] = await students(h, 'a', 'b')
    await seat(h, a, id, kids.id)
    h.clock.now = venueInstant('2026-10-25', 10 * 60)
    const paying = await book(h, b, id, kids.id)
    expect(paying.status).toBe(201)
    await cancelUnderfilledSessions(h.deps)
    expect(live(h, id)).toHaveLength(2)
    expect(h.db.select().from(slots).where(eq(slots.id, id)).get()?.minCheckedAt).toBeNull()
    await h.call('POST', `/dev/fake-pay/${paying.json.orderId}`)
    await cancelUnderfilledSessions(h.deps)
    expect(live(h, id).map((x) => x.status)).toEqual(['confirmed', 'confirmed'])
    expect(h.db.select().from(slots).where(eq(slots.id, id)).get()?.minCheckedAt).not.toBeNull()
  })

  it('does not wait for a hold taken after the check time', async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h, { minStudents: 2 })
    const admin = await h.admin()
    const id = await session(h, admin, kids.id, coach.id)
    const [a, b] = await students(h, 'a', 'b')
    await seat(h, a, id, kids.id)
    h.clock.now = venueInstant('2026-10-25', 10 * 60 + 5)
    expect((await book(h, b, id, kids.id)).status).toBe(201)
    await cancelUnderfilledSessions(h.deps)
    expect(live(h, id)).toHaveLength(0)
  })

  it('checks an hour ahead when cancelling is free until the start', async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h, { minStudents: 2 })
    const admin = await h.admin()
    const settings = (await h.call('GET', '/admin/settings', undefined, admin)).json
    const saved = await h.call(
      'PUT',
      '/admin/settings',
      { ...settings, booking: { ...settings.booking, cancelDeadlineHours: 0 } },
      admin,
    )
    expect(saved.status).toBe(200)
    const id = await session(h, admin, kids.id, coach.id)
    const t = await h.student('a')
    await seat(h, t, id, kids.id)
    h.clock.now = venueInstant('2026-10-26', 9 * 60)
    await cancelUnderfilledSessions(h.deps)
    expect(live(h, id)).toHaveLength(0)
  })

  it('leaves a session scheduled after its deadline alone', async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h, { minStudents: 2 })
    const admin = await h.admin()
    const res = await schedule(h, admin, {
      lessonTypeId: kids.id,
      coachId: coach.id,
      date: '2026-10-23',
      hour: 18,
    })
    const id = res.json.ids[0]
    const t = await h.student('a')
    await seat(h, t, id, kids.id)
    await cancelUnderfilledSessions(h.deps)
    expect(live(h, id)).toHaveLength(1)
  })
})

describe('session capacity', () => {
  it('never goes below the students booked, and renumbers seats when lowered', async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h)
    const admin = await h.admin()
    const id = await session(h, admin, kids.id, coach.id)
    const tokens = await students(h, 'a', 'b', 'c')
    const ids: number[] = []
    for (const t of tokens) ids.push(await seat(h, t, id, kids.id))
    // Seats 1 and 2 free up; seat 3 stays.
    await h.call('POST', `/bookings/${ids[0]}/cancel`, {}, tokens[0])
    await h.call('POST', `/bookings/${ids[1]}/cancel`, {}, tokens[1])
    const below = await h.call('PATCH', `/admin/slots/${id}`, { capacity: 2 }, admin)
    expect(below.status).toBe(204)
    expect(live(h, id).map((b) => b.seat)).toEqual([1])
    const t = await h.student('d')
    await seat(h, t, id, kids.id)
    const tooLow = await h.call('PATCH', `/admin/slots/${id}`, { capacity: 1 }, admin)
    expect(tooLow.status).toBe(400)
    const raised = await h.call('PATCH', `/admin/slots/${id}`, { capacity: 6 }, admin)
    expect(raised.status).toBe(204)
    const t2 = await h.student('e')
    const t3 = await h.student('f')
    await seat(h, t2, id, kids.id)
    expect(
      (await h.call('PATCH', `/admin/slots/${id}`, { capacity: 2 }, admin)).json.error.code,
    ).toBe('capacity_below_booked')
    await seat(h, t3, id, kids.id)
    expect(live(h, id)).toHaveLength(4)
  })

  it('lists who booked each session for the admin', async () => {
    const h = setup()
    const { coach, kids } = seedGroup(h)
    const admin = await h.admin()
    const id = await session(h, admin, kids.id, coach.id)
    const [a, b] = await students(h, 'a', 'b')
    await seat(h, a, id, kids.id)
    await seat(h, b, id, kids.id)
    const from = venueInstant('2026-10-26', 0).toISOString()
    const to = venueInstant('2026-10-27', 0).toISOString()
    const rows = (await h.call('GET', `/admin/slots?from=${from}&to=${to}`, undefined, admin)).json
    expect(rows).toEqual([
      expect.objectContaining({ id, capacity: 4, lessonTypeId: kids.id, booking: null }),
    ])
    expect(rows[0].bookings).toHaveLength(2)
  })
})
