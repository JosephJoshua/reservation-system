import { venueInstant } from '@rs/shared'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
  bookings,
  coaches,
  lessonTypes,
  orders,
  packageLedger,
  packageProducts,
  packages,
  refunds,
  scheduleExceptions,
  slots,
  students,
} from './db/schema'
import { type Harness, setup } from './test/harness'

const at = (date: string, hour: number) => venueInstant(date, hour * 60)
let seq = 0

/** A small October at the venue, seen on the evening of 10-24. */
function october(h: Harness) {
  const { coach: wang, lesson } = h.seed()
  const li = h.db.insert(coaches).values({ name: '李教练', sort: 1 }).returning().get()
  const person = (name: string) =>
    h.db
      .insert(students)
      .values({ openid: `o-${name}`, name, phone: '13800000000' })
      .returning()
      .get()
  const [amy, bo, cai] = [person('Amy'), person('Bo'), person('Cai')]

  const order = (studentId: number, amount: number, paidAt: Date, fields = {}) =>
    h.db
      .insert(orders)
      .values({
        outTradeNo: `t${++seq}`,
        studentId,
        kind: 'class',
        description: '',
        amount,
        provider: 'wechat',
        status: 'paid',
        paidAt,
        ...fields,
      })
      .returning()
      .get()
  // The coach works that hour (加班), unless the slot is closed; a group session needs no 排班.
  const slot = (
    coachId: number,
    date: string,
    hour: number,
    fields: Partial<typeof slots.$inferInsert> = {},
  ) => {
    const span = { startsAt: at(date, hour), endsAt: at(date, hour + 1) }
    if (fields.open !== false && !fields.lessonTypeId) {
      h.db
        .insert(scheduleExceptions)
        .values({ coachId, kind: 'extra', ...span })
        .run()
    }
    return h.db
      .insert(slots)
      .values({ coachId, ...span, ...fields })
      .returning()
      .get()
  }
  const book = (
    slotRow: typeof slots.$inferSelect,
    studentId: number,
    fields: Partial<typeof bookings.$inferInsert> = {},
  ) =>
    h.db
      .insert(bookings)
      .values({
        slotId: slotRow.id,
        studentId,
        lessonTypeId: lesson.id,
        startsAt: slotRow.startsAt,
        endsAt: slotRow.endsAt,
        status: 'confirmed',
        paidWith: 'order',
        price: 20000,
        ...fields,
      })
      .returning()
      .get()
  const paidLesson = (
    studentId: number,
    coachId: number,
    date: string,
    hour: number,
    fields = {},
  ) => {
    const s = slot(coachId, date, hour)
    const b = book(s, studentId, fields)
    const o = order(studentId, 20000, at(date, hour - 24), { bookingId: b.id })
    return { slot: s, booking: b, order: o }
  }

  // Amy buys 10 lessons for ¥1500 on 10-01 and books two of them.
  const product = h.db
    .insert(packageProducts)
    .values({
      name: '十次课',
      lessonTypeId: lesson.id,
      lessonCount: 10,
      price: 150000,
      validityDays: 90,
    })
    .returning()
    .get()
  const pkgOrder = order(amy.id, 150000, at('2026-10-01', 10), {
    kind: 'package',
    productId: product.id,
  })
  const pkg = h.db
    .insert(packages)
    .values({
      studentId: amy.id,
      productId: product.id,
      name: '十次课',
      lessonTypeId: lesson.id,
      coachIds: [],
      lessonsPurchased: 10,
      lessonsRemaining: 8,
      pricePaid: 150000,
      expiresAt: at('2026-12-30', 0),
      status: 'active',
      orderId: pkgOrder.id,
      createdAt: at('2026-10-01', 10),
    })
    .returning()
    .get()
  const ledger = (
    delta: number,
    kind: 'purchase' | 'use' | 'return',
    when: Date,
    bookingId?: number,
  ) =>
    h.db
      .insert(packageLedger)
      .values({ packageId: pkg.id, delta, kind, actor: 'student', createdAt: when, bookingId })
      .run()
  ledger(10, 'purchase', at('2026-10-01', 10))
  const a1 = book(slot(wang.id, '2026-10-10', 10), amy.id, {
    paidWith: 'package',
    packageId: pkg.id,
    attendance: 'attended',
  })
  ledger(-1, 'use', at('2026-10-09', 10), a1.id)
  const a2 = book(slot(wang.id, '2026-10-20', 10), amy.id, {
    paidWith: 'package',
    packageId: pkg.id,
    attendance: 'no_show',
  })
  ledger(-1, 'use', at('2026-10-19', 10), a2.id)

  // Bo came in September, took a lesson on 10-15, then cancelled late on 10-22 and lost it.
  paidLesson(bo.id, li.id, '2026-09-20', 10, { attendance: 'attended' })
  paidLesson(bo.id, li.id, '2026-10-15', 11)
  paidLesson(bo.id, li.id, '2026-10-22', 11, {
    status: 'cancelled',
    cancelledBy: 'student',
    late: true,
  })
  // The venue cancelled his 10-23 lesson and refunded it.
  const cancelled = paidLesson(bo.id, li.id, '2026-10-23', 11, {
    status: 'cancelled',
    cancelledBy: 'venue',
  })
  h.db
    .insert(refunds)
    .values({
      outRefundNo: 'r1',
      orderId: cancelled.order.id,
      amount: 20000,
      reason: '',
      status: 'succeeded',
      updatedAt: at('2026-10-23', 9),
    })
    .run()

  // 王 also had an hour nobody booked, and one he closed.
  slot(wang.id, '2026-10-21', 14)
  slot(wang.id, '2026-10-21', 15, { open: false })
  // Tonight's lesson has not ended yet.
  paidLesson(cai.id, wang.id, '2026-10-24', 21)

  // A group class for 4 on 10-18 with Cai and Amy in it, and one tomorrow.
  const group = h.db
    .insert(lessonTypes)
    .values({ name: '小班课', durationMinutes: 60, price: 8000, capacity: 4 })
    .returning()
    .get()
  const session = slot(li.id, '2026-10-18', 9, { lessonTypeId: group.id, capacity: 4 })
  for (const [seat, s] of [cai, amy].entries()) {
    const b = book(session, s.id, { lessonTypeId: group.id, seat: seat + 1, price: 8000 })
    order(s.id, 8000, at('2026-10-17', 9), { bookingId: b.id })
  }
  slot(li.id, '2026-10-25', 9, { lessonTypeId: group.id, capacity: 4 })

  return { wang, li, amy, bo, cai, pkg, group, lesson }
}

describe('GET /admin/reports/stats', () => {
  it('reports money, lessons, students, coach hours and packages for a range', async () => {
    const h = setup({ now: '2026-10-24T12:00:00Z' })
    const v = october(h)
    const admin = await h.admin()
    const res = await h.call(
      'GET',
      '/admin/reports/stats?from=2026-10-01&to=2026-10-31',
      undefined,
      admin,
    )
    expect(res.status).toBe(200)
    const r = res.json
    // Days after today are left out.
    expect(r.to).toBe('2026-10-24')
    expect(r.grain).toBe('day')
    expect(r.buckets).toHaveLength(24)
    const day = (d: number) => d - 1
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

    expect(r.revenue.paid[day(1)]).toBe(150000)
    expect(r.revenue.paid[day(17)]).toBe(16000)
    // Tonight's lesson was paid yesterday.
    expect(r.revenue.paid[day(23)]).toBe(20000)
    expect(sum(r.revenue.paid)).toBe(150000 + 4 * 20000 + 16000)
    expect(r.revenue.refunded[day(23)]).toBe(20000)
    // 课消: ¥150 per package lesson, the no-show too; the late cancel keeps its ¥200; the
    // venue-cancelled and the unfinished lessons count for nothing.
    expect(r.revenue.consumed[day(10)]).toBe(15000)
    expect(r.revenue.consumed[day(20)]).toBe(15000)
    expect(r.revenue.consumed[day(15)]).toBe(20000)
    expect(r.revenue.consumed[day(18)]).toBe(16000)
    expect(r.revenue.consumed[day(22)]).toBe(20000)
    expect(r.revenue.consumed[day(23)]).toBe(0)
    expect(r.revenue.consumed[day(24)]).toBe(0)

    // The group class counts once.
    expect(sum(r.lessons)).toBe(4)
    expect(r.lessons[day(18)]).toBe(1)
    expect(r.attendance).toEqual({ attended: 1, noShow: 1, unmarked: 3 })

    // Bo came before October; Amy and Cai are new.
    expect(r.students.total).toEqual({ new: 2, returning: 1 })
    expect(r.students.new[day(10)]).toBe(1)
    expect(r.students.new[day(18)]).toBe(1)
    expect(r.students.new[day(20)]).toBe(0)
    expect(r.students.returning[day(20)]).toBe(1)
    expect(r.students.returning[day(15)]).toBe(1)

    // 王: 10-10, 10-20 and the empty 10-21 hour on offer; the closed hour is not. 李: 10-15 and
    // 10-18, plus the 10-22 and 10-23 hours, open again after their cancels.
    expect(r.coaches).toEqual([
      { id: v.wang.id, name: '王教练', offeredMinutes: 180, bookedMinutes: 120 },
      { id: v.li.id, name: '李教练', offeredMinutes: 240, bookedMinutes: 120 },
    ])
    // Saturday 10-10 and Tuesday 10-20 at 10:00, Wednesday 10-21 at 14:00.
    expect(r.heatmap).toContainEqual({ weekday: 5, hour: 10, offered: 1, booked: 1 })
    expect(r.heatmap).toContainEqual({ weekday: 1, hour: 10, offered: 1, booked: 1 })
    expect(r.heatmap).toContainEqual({ weekday: 2, hour: 14, offered: 1, booked: 0 })
    expect(r.heatmap.some((c: { hour: number }) => c.hour === 15)).toBe(false)

    expect(r.groups).toEqual([
      { lessonTypeId: v.group.id, name: '小班课', sessions: 1, seats: 4, booked: 2 },
    ])
    expect(r.packages.sales).toEqual([
      { productId: v.pkg.productId, name: '十次课', count: 1, amount: 150000 },
    ])
    // 10 lessons from 10-01. A booked lesson stays prepaid until it takes place on 10-10.
    expect(r.packages.liability[day(1)]).toBe(150000)
    expect(r.packages.liability[day(9)]).toBe(150000)
    expect(r.packages.liability[day(10)]).toBe(135000)
    expect(r.packages.liability[day(24)]).toBe(120000)
    expect(r.renewal).toEqual({ ended: 0, renewed: 0 })
  })

  it('counts a lesson booked outside 排班 as time on offer', async () => {
    const h = setup({ now: '2026-10-24T12:00:00Z' })
    const v = october(h)
    const admin = await h.admin()
    const report = async () =>
      (await h.call('GET', '/admin/reports/stats?from=2026-10-01&to=2026-10-31', undefined, admin))
        .json.coaches as { id: number; offeredMinutes: number; bookedMinutes: number }[]
    const before = (await report()).find((c) => c.id === v.li.id)
    // 李 had no 排班 at 10-12 13:00; the desk booked Cai then anyway.
    const span = { startsAt: at('2026-10-12', 13), endsAt: at('2026-10-12', 14) }
    const row = h.db
      .insert(slots)
      .values({ coachId: v.li.id, ...span })
      .returning()
      .get()
    h.db
      .insert(bookings)
      .values({
        slotId: row.id,
        studentId: v.cai.id,
        lessonTypeId: v.lesson.id,
        ...span,
        status: 'confirmed',
        paidWith: 'order',
        price: 20000,
      })
      .run()
    const after = (await report()).find((c) => c.id === v.li.id)
    expect(after?.offeredMinutes).toBe((before?.offeredMinutes ?? 0) + 60)
    expect(after?.bookedMinutes).toBe((before?.bookedMinutes ?? 0) + 60)
  })

  it('leaves closed empty sessions and inactive coaches out of time on offer', async () => {
    const h = setup({ now: '2026-10-24T12:00:00Z' })
    const v = october(h)
    const admin = await h.admin()
    const report = async () =>
      (await h.call('GET', '/admin/reports/stats?from=2026-10-01&to=2026-10-31', undefined, admin))
        .json.coaches as { id: number; offeredMinutes: number }[]
    const offered = async (id: number) => (await report()).find((c) => c.id === id)?.offeredMinutes
    const before = await offered(v.li.id)
    const session = (open: boolean, hour: number) =>
      h.db
        .insert(slots)
        .values({
          coachId: v.li.id,
          lessonTypeId: v.lesson.id,
          capacity: 4,
          open,
          startsAt: at('2026-10-14', hour),
          endsAt: at('2026-10-14', hour + 1),
        })
        .run()
    session(false, 15)
    expect(await offered(v.li.id)).toBe(before)
    session(true, 17)
    expect(await offered(v.li.id)).toBe((before ?? 0) + 60)

    // 李 stops taking lessons: their 排班 was not for sale, the open session still was.
    h.db.update(coaches).set({ active: false }).where(eq(coaches.id, v.li.id)).run()
    expect(await offered(v.li.id)).toBeLessThan(before ?? 0)
  })

  it('groups long ranges by week or month', async () => {
    const h = setup({ now: '2026-10-24T12:00:00Z' })
    october(h)
    const admin = await h.admin()
    const weeks = (
      await h.call('GET', '/admin/reports/stats?from=2026-09-01&to=2026-10-24', undefined, admin)
    ).json
    expect(weeks.grain).toBe('week')
    const months = (
      await h.call('GET', '/admin/reports/stats?from=2026-01-01&to=2026-10-24', undefined, admin)
    ).json
    expect(months.grain).toBe('month')
    expect(months.buckets).toHaveLength(10)
    expect(months.lessons.at(-2)).toBe(1)
    expect(months.lessons.at(-1)).toBe(4)
  })

  it('counts packages that ran out and whether the student bought again', async () => {
    const h = setup({ now: '2026-10-24T12:00:00Z' })
    const v = october(h)
    const admin = await h.admin()
    // Packages need an order each; these stand-ins are not looked up.
    let fakeOrder = 9000
    const old = (studentId: number, fields: Partial<typeof packages.$inferInsert>) =>
      h.db
        .insert(packages)
        .values({
          studentId,
          productId: v.pkg.productId,
          name: '十次课',
          lessonTypeId: v.pkg.lessonTypeId,
          coachIds: [],
          lessonsPurchased: 10,
          lessonsRemaining: 0,
          pricePaid: 150000,
          expiresAt: at('2026-12-01', 0),
          status: 'active',
          orderId: fakeOrder++,
          createdAt: at('2026-07-01', 0),
          ...fields,
        })
        .returning()
        .get()
    // Amy used hers up on 10-05 and bought again; Bo's expired on 10-12 with lessons left; Cai's
    // was used up in September; a refunded one is left out.
    const amyOld = old(v.amy.id, {})
    h.db
      .insert(packageLedger)
      .values({
        packageId: amyOld.id,
        delta: -1,
        kind: 'use',
        actor: 'student',
        createdAt: at('2026-10-05', 0),
      })
      .run()
    old(v.bo.id, { lessonsRemaining: 3, expiresAt: at('2026-10-12', 0) })
    const caiOld = old(v.cai.id, {})
    h.db
      .insert(packageLedger)
      .values({
        packageId: caiOld.id,
        delta: -1,
        kind: 'use',
        actor: 'student',
        createdAt: at('2026-09-05', 0),
      })
      .run()
    old(v.cai.id, { lessonsRemaining: 0, status: 'refunded', expiresAt: at('2026-10-10', 0) })

    const r = (
      await h.call('GET', '/admin/reports/stats?from=2026-10-01&to=2026-10-24', undefined, admin)
    ).json
    expect(r.renewal).toEqual({ ended: 2, renewed: 1 })

    // Bo buys again 40 days after his ran out: too late to count as a renewal of it.
    old(v.bo.id, { lessonsRemaining: 10, createdAt: at('2026-11-21', 0) })
    const later = (
      await h.call('GET', '/admin/reports/stats?from=2026-10-01&to=2026-10-24', undefined, admin)
    ).json
    expect(later.renewal).toEqual({ ended: 2, renewed: 1 })
  })

  it('refuses bad ranges', async () => {
    const h = setup({ now: '2026-10-24T12:00:00Z' })
    const admin = await h.admin()
    const get = (q: string) => h.call('GET', `/admin/reports/stats?${q}`, undefined, admin)
    expect((await get('from=2026-10-10&to=2026-10-01')).status).toBe(400)
    expect((await get('from=2026-02-30&to=2026-03-01')).status).toBe(400)
    expect((await get('from=2024-01-01&to=2026-10-01')).status).toBe(400)
    const future = await get('from=2026-11-01&to=2026-11-30')
    expect(future.json.error.message).toBe('开始日期不能晚于今天')
    expect((await get('from=2026-10-01')).status).toBe(400)
    expect((await h.call('GET', '/admin/reports/stats?from=2026-10-01&to=2026-10-02')).status).toBe(
      401,
    )
  })
})

describe('GET /admin/reports/dormant', () => {
  it('lists students with lessons left, no lesson in 30 days and nothing booked', async () => {
    const h = setup({ now: '2026-10-24T12:00:00Z' })
    const v = october(h)
    let admin = await h.admin()
    const list = async () => (await h.call('GET', '/admin/reports/dormant', undefined, admin)).json
    // Amy came on 10-20.
    expect(await list()).toEqual([])

    h.clock.now = new Date('2026-11-25T12:00:00Z')
    admin = await h.admin()
    expect(await list()).toEqual([
      {
        student: { id: v.amy.id, name: 'Amy', phone: '13800000000' },
        lessonsLeft: 8,
        expiresAt: at('2026-12-30', 0).toISOString(),
        lastLessonAt: at('2026-10-20', 10).toISOString(),
      },
    ])

    // A package bought in the last 30 days is a fresh start, lesson or not.
    const fresh = h.db
      .insert(students)
      .values({ openid: 'o-fresh', name: 'Fresh' })
      .returning()
      .get()
    h.db
      .insert(packages)
      .values({
        studentId: fresh.id,
        productId: v.pkg.productId,
        name: '十次课',
        lessonTypeId: v.pkg.lessonTypeId,
        coachIds: [],
        lessonsPurchased: 10,
        lessonsRemaining: 10,
        pricePaid: 150000,
        expiresAt: at('2027-02-01', 0),
        status: 'active',
        orderId: 9999,
        createdAt: at('2026-11-20', 0),
      })
      .run()
    expect((await list()).map((d: { student: { id: number } }) => d.student.id)).toEqual([v.amy.id])

    // A lesson booked ahead takes her off the list.
    const s = h.db
      .insert(slots)
      .values({ coachId: v.wang.id, startsAt: at('2026-11-30', 10), endsAt: at('2026-11-30', 11) })
      .returning()
      .get()
    h.db
      .insert(bookings)
      .values({
        slotId: s.id,
        studentId: v.amy.id,
        lessonTypeId: v.pkg.lessonTypeId,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        status: 'confirmed',
        paidWith: 'package',
        packageId: v.pkg.id,
        price: 20000,
      })
      .run()
    expect(await list()).toEqual([])
  })
})

describe('GET /admin/summary', () => {
  it("shows today's lessons, this month against last month and unmarked lessons", async () => {
    const h = setup({ now: '2026-10-24T12:00:00Z' })
    const v = october(h)
    const admin = await h.admin()
    const s = (await h.call('GET', '/admin/summary', undefined, admin)).json
    expect(s.date).toBe('2026-10-24')
    expect(s.sessions).toEqual([
      {
        slotId: expect.any(Number),
        startsAt: at('2026-10-24', 21).toISOString(),
        endsAt: at('2026-10-24', 22).toISOString(),
        coach: '王教练',
        lessonType: '一对一私教',
        capacity: null,
        students: [
          {
            bookingId: expect.any(Number),
            student: { id: v.cai.id, name: 'Cai', phone: '13800000000' },
            attendance: null,
          },
        ],
      },
    ])
    // Ended in the last week with no mark: the two 10-18 seats. Tonight's has not ended.
    expect(s.unmarked).toBe(2)
    // The 待签到 card opens the same bookings.
    const from = at('2026-10-17', 0).toISOString()
    const listed = await h.call(
      'GET',
      `/admin/bookings?status=completed&unmarked=1&from=${from}`,
      undefined,
      admin,
    )
    expect(listed.json.map((b: { startsAt: string }) => b.startsAt)).toEqual([
      at('2026-10-18', 9).toISOString(),
      at('2026-10-18', 9).toISOString(),
    ])
    const file = await h.app.request(
      '/api/admin/exports/bookings?from=2026-10-17&to=2026-10-24&status=completed&unmarked=1',
      { headers: { Authorization: `Bearer ${admin}` } },
    )
    expect((await file.text()).trimEnd().split('\r\n')).toHaveLength(3)
    expect(s.revenue.month).toBe(150000 + 4 * 20000 + 16000 - 20000)
    // September up to the 24th evening: Bo's 09-20 lesson, paid on 09-19.
    expect(s.revenue.lastMonth).toBe(20000)
    expect(s.revenue.today).toBe(0)
    expect(s.newStudents).toEqual({ month: 2, lastMonth: 1 })
    expect(s.upcomingBookings).toBe(1)
    // 待上课预约 opens the same bookings: 预约's default range of two weeks from today.
    const twoWeeks = await h.call(
      'GET',
      `/admin/bookings?status=confirmed&from=${at('2026-10-24', 0).toISOString()}&to=${at('2026-11-07', 0).toISOString()}`,
      undefined,
      admin,
    )
    expect(twoWeeks.json).toHaveLength(s.upcomingBookings)
  })

  it('counts upcoming bookings over the range its link opens', async () => {
    const h = setup({ now: '2026-10-24T12:00:00Z' })
    const { coach, lesson } = h.seed()
    const admin = await h.admin()
    const t = await h.student('a')
    const book = async (date: string) => {
      const res = await h.call(
        'POST',
        '/bookings',
        { slotId: h.slot(coach.id, date).id, lessonTypeId: lesson.id },
        t,
      )
      await h.call('POST', `/dev/fake-pay/${res.json.orderId}`, undefined, t)
    }
    await book('2026-10-26')
    await book('2026-11-06')
    await book('2026-10-28')
    // Past the two weeks the tile opens.
    h.db
      .update(bookings)
      .set({ startsAt: at('2026-11-07', 10) })
      .where(eq(bookings.id, 2))
      .run()
    // Earlier today, already over: no longer to come, as in the list the tile opens.
    h.db
      .update(bookings)
      .set({ startsAt: at('2026-10-24', 10), endsAt: at('2026-10-24', 11) })
      .where(eq(bookings.id, 3))
      .run()
    const s = (await h.call('GET', '/admin/summary', undefined, admin)).json
    expect(s.upcomingBookings).toBe(1)
  })
})
