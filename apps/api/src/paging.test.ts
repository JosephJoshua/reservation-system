import { venueInstant } from '@rs/shared'
import { describe, expect, it } from 'vitest'
import {
  bookings,
  coachHours,
  orders,
  packageProducts,
  packages,
  refunds,
  slots,
  students,
} from './db/schema'
import { setup } from './test/harness'

const at = (date: string, hour: number) => venueInstant(date, hour * 60)

describe('paged admin lists', () => {
  it('pages students newest first, and searches within the pages', async () => {
    const h = setup()
    h.db
      .insert(students)
      .values(
        Array.from({ length: 7 }, (_, i) => ({
          openid: `o-${i}`,
          name: i % 2 ? `王${i}` : `李${i}`,
          phone: `1380000000${i}`,
        })),
      )
      .run()
    const admin = await h.admin()
    const get = async (q: string) =>
      (await h.call('GET', `/admin/students?${q}`, undefined, admin)).json.map(
        (s: { name: string }) => s.name,
      )
    expect(await get('limit=3')).toEqual(['李6', '王5', '李4'])
    const last = (await h.call('GET', '/admin/students?limit=3', undefined, admin)).json.at(-1).id
    expect(await get(`limit=3&before=${last}`)).toEqual(['王3', '李2', '王1'])
    expect(await get(`q=王&limit=2&before=${last}`)).toEqual(['王3', '王1'])
    expect((await h.call('GET', '/admin/students?limit=501', undefined, admin)).status).toBe(400)
  })

  it('pages orders and refunds by id, and bookings by position', async () => {
    const h = setup({ now: '2026-10-24T12:00:00Z' })
    const { coach, lesson } = h.seed()
    const amy = h.db.insert(students).values({ openid: 'o-amy', name: 'Amy' }).returning().get()
    const made = Array.from({ length: 5 }, (_, i) => {
      const slot = h.slot(coach.id, '2026-10-20', 9 + i)
      const booking = h.db
        .insert(bookings)
        .values({
          slotId: slot.id,
          studentId: amy.id,
          lessonTypeId: lesson.id,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          status: 'confirmed',
          paidWith: 'order',
          price: 20000,
        })
        .returning()
        .get()
      const order = h.db
        .insert(orders)
        .values({
          outTradeNo: `t${i}`,
          studentId: amy.id,
          kind: 'class',
          description: '一对一私教',
          amount: 20000,
          provider: 'wechat',
          status: 'paid',
          bookingId: booking.id,
          paidAt: slot.startsAt,
        })
        .returning()
        .get()
      h.db
        .insert(refunds)
        .values({
          outRefundNo: `r${i}`,
          orderId: order.id,
          amount: 100,
          reason: '',
          status: 'succeeded',
          updatedAt: slot.startsAt,
        })
        .run()
      return { booking, order }
    })
    const admin = await h.admin()
    const ids = async (path: string) =>
      (await h.call('GET', path, undefined, admin)).json.map((r: { id: number }) => r.id)
    const orderIds = made.map((m) => m.order.id).reverse()
    expect(await ids('/admin/orders?limit=2')).toEqual(orderIds.slice(0, 2))
    expect(await ids(`/admin/orders?limit=2&before=${orderIds[1]}`)).toEqual(orderIds.slice(2, 4))
    const refundIds = await ids('/admin/refunds?limit=5&status=succeeded')
    expect(await ids(`/admin/refunds?limit=2&status=succeeded&before=${refundIds[1]}`)).toEqual(
      refundIds.slice(2, 4),
    )
    const range = `from=${at('2026-10-20', 0).toISOString()}&to=${at('2026-10-21', 0).toISOString()}`
    const bookingIds = made.map((m) => m.booking.id)
    expect(await ids(`/admin/bookings?${range}&limit=2`)).toEqual(bookingIds.slice(0, 2))
    expect(await ids(`/admin/bookings?${range}&limit=2&offset=4`)).toEqual(bookingIds.slice(4))
    expect(await ids(`/admin/bookings?${range}&order=desc&limit=2&offset=1`)).toEqual(
      bookingIds.slice(2, 4).reverse(),
    )
  })

  it('pages dormant students', async () => {
    const h = setup({ now: '2026-10-24T12:00:00Z' })
    const { lesson } = h.seed()
    const admin = await h.admin()
    const product = h.db
      .insert(packageProducts)
      .values({
        name: '十次课',
        lessonTypeId: lesson.id,
        lessonCount: 10,
        price: 100000,
        validityDays: 90,
      })
      .returning()
      .get()
    for (let i = 0; i < 3; i++) {
      const s = h.db
        .insert(students)
        .values({ openid: `o-${i}`, name: `学员${i}` })
        .returning()
        .get()
      h.db
        .insert(packages)
        .values({
          studentId: s.id,
          productId: product.id,
          name: '十次课',
          lessonTypeId: lesson.id,
          coachIds: [],
          lessonsPurchased: 10,
          lessonsRemaining: 5,
          pricePaid: 100000,
          expiresAt: at('2027-01-01', 0),
          status: 'active',
          orderId: 1,
          createdAt: at('2026-08-01', 0),
        })
        .run()
    }
    const names = async (q: string) =>
      (await h.call('GET', `/admin/reports/dormant?${q}`, undefined, admin)).json.map(
        (d: { student: { name: string } }) => d.student.name,
      )
    expect(await names('')).toEqual(['学员0', '学员1', '学员2'])
    expect(await names('limit=2&offset=1')).toEqual(['学员1', '学员2'])
  })
})

describe('reports at a busy venue', () => {
  it('counts a payment in the last moment of a venue day on that day', async () => {
    const h = setup({ now: '2026-10-24T12:00:00Z' })
    const amy = h.db.insert(students).values({ openid: 'o-amy', name: 'Amy' }).returning().get()
    const paid = (outTradeNo: string, paidAt: Date) =>
      h.db
        .insert(orders)
        .values({
          outTradeNo,
          studentId: amy.id,
          kind: 'package',
          description: '课时包',
          amount: 100,
          provider: 'offline',
          status: 'paid',
          paidAt,
        })
        .run()
    paid('a', new Date(venueInstant('2026-10-02', 0).getTime() - 1))
    paid('b', venueInstant('2026-10-02', 0))
    paid('c', new Date(venueInstant('2026-10-03', 0).getTime() - 1))
    const admin = await h.admin()
    const res = await h.call(
      'GET',
      '/admin/reports/stats?from=2026-10-01&to=2026-10-03',
      undefined,
      admin,
    )
    expect(res.json.revenue.paid).toEqual([100, 200, 0])
  })

  it('reports a year with more lessons than one query can list', async () => {
    const h = setup({ now: '2026-10-24T12:00:00Z' })
    const { coach, lesson } = h.seed()
    const admin = await h.admin()
    const amy = h.db.insert(students).values({ openid: 'o-amy', name: 'Amy' }).returning().get()
    // SQLite takes at most 32766 values in one query; a busy year has more lessons than that.
    const client = h.db.$client
    const slot = client.prepare(
      'insert into slots (coach_id, starts_at, ends_at, open, capacity) values (?, ?, ?, 1, 1)',
    )
    const booking = client.prepare(
      "insert into bookings (slot_id, student_id, lesson_type_id, starts_at, ends_at, status, seat, paid_with, price, attendance) values (?, ?, ?, ?, ?, 'confirmed', 1, 'order', 20000, 'attended')",
    )
    const order = client.prepare(
      "insert into orders (out_trade_no, student_id, kind, description, amount, provider, status, booking_id, paid_at) values (?, ?, 'class', '', 20000, 'wechat', 'paid', ?, ?)",
    )
    // The coach works all day, every day.
    h.db
      .insert(coachHours)
      .values(
        [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
          coachId: coach.id,
          weekday,
          startMinute: 0,
          endMinute: 24 * 60,
          fromDate: '2000-01-01',
        })),
      )
      .run()
    const first = at('2025-10-25', 0).getTime()
    const n = 33_000
    client.transaction(() => {
      for (let i = 0; i < n; i++) {
        // Spread over the year, from 9:00, a minute later each lap.
        const start = first + (i % 360) * 86_400_000 + 9 * 3_600_000 + Math.floor(i / 360) * 60_000
        const s = slot.run(coach.id, start, start + 3_600_000)
        const b = booking.run(s.lastInsertRowid, amy.id, lesson.id, start, start + 3_600_000)
        order.run(`y${i}`, amy.id, b.lastInsertRowid, start)
      }
    })()
    expect(h.db.select().from(slots).all().length).toBe(n)
    const r = await h.call(
      'GET',
      '/admin/reports/stats?from=2025-10-25&to=2026-10-24',
      undefined,
      admin,
    )
    expect(r.status).toBe(200)
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
    expect(sum(r.json.lessons)).toBe(n)
    expect(sum(r.json.revenue.paid)).toBe(n * 20000)
    expect(sum(r.json.revenue.consumed)).toBe(n * 20000)
    expect(r.json.attendance).toEqual({ attended: n, noShow: 0, unmarked: 0 })
    // A day's lessons start a minute apart and overlap: 240 days have 92, the rest 91, and the
    // coach is busy from the first start to an hour after the last.
    const busy = 240 * (91 + 60) + 120 * (90 + 60)
    expect(r.json.coaches).toMatchObject([{ id: coach.id, name: coach.name, bookedMinutes: busy }])
    expect(r.json.coaches[0].offeredMinutes).toBeGreaterThan(busy)
    const booked = sum(r.json.heatmap.map((c: { booked: number }) => c.booked))
    expect(Math.abs(booked - busy / 60)).toBeLessThan(5)
    expect(r.json.students.total).toEqual({ new: 1, returning: 0 })
  }, 60_000)
})
