import { venueInstant } from '@rs/shared'
import { describe, expect, it } from 'vitest'
import {
  actionLog,
  bookings,
  coaches,
  invoices,
  lessonFeedback,
  orders,
  packageProducts,
  packages,
  refunds,
  students,
} from './db/schema'
import { setup } from './test/harness'

const at = (date: string, hour: number) => venueInstant(date, hour * 60)

/** A venue with two students, two coaches and a few of everything the admin lists. */
async function venue() {
  const h = setup({ now: '2026-10-24T12:00:00Z' })
  const { coach, lesson, trial } = h.seed()
  const li = h.db.insert(coaches).values({ name: '李教练' }).returning().get()
  const amy = h.db
    .insert(students)
    .values({ openid: 'o-amy', name: '张小美', phone: '13800000001' })
    .returning()
    .get()
  const bob = h.db
    .insert(students)
    .values({
      openid: 'o-bob',
      name: '刘大壮',
      phone: '13900000002',
      tester: true,
      createdAt: at('2026-09-01', 10),
    })
    .returning()
    .get()
  const admin = await h.admin()
  const book = (
    who: number,
    coachId: number,
    lessonTypeId: number,
    day: string,
    extra: Partial<typeof bookings.$inferInsert> = {},
  ) => {
    const slot = h.slot(coachId, day, 10)
    return h.db
      .insert(bookings)
      .values({
        slotId: slot.id,
        studentId: who,
        lessonTypeId,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        status: 'confirmed',
        paidWith: 'order',
        price: 20000,
        ...extra,
      })
      .returning()
      .get()
  }
  const order = (
    who: number,
    values: Partial<typeof orders.$inferInsert> & { outTradeNo: string },
  ) =>
    h.db
      .insert(orders)
      .values({
        studentId: who,
        kind: 'class',
        description: '一对一私教',
        amount: 20000,
        provider: 'wechat',
        status: 'paid',
        ...values,
      })
      .returning()
      .get()
  const get = async (path: string) => {
    const res = await h.call('GET', path, undefined, admin)
    expect(res.status).toBe(200)
    return { rows: res.json, total: Number(res.headers.get('X-Total-Count')) }
  }
  return { h, coach, li, lesson, trial, amy, bob, admin, book, order, get }
}

describe('admin list filters and totals', () => {
  it('filters bookings by lesson type, student, payment and who booked', async () => {
    const { coach, li, lesson, trial, amy, bob, book, order, get, h } = await venue()
    const a = book(amy.id, coach.id, lesson.id, '2026-10-26')
    const b = book(bob.id, li.id, trial.id, '2026-10-27', { paidWith: 'package' })
    const c = book(amy.id, li.id, lesson.id, '2026-10-28', { bookedByStaffId: 1 })
    order(amy.id, { outTradeNo: 'desk', bookingId: c.id, provider: 'offline' })
    order(amy.id, { outTradeNo: 'wx', bookingId: a.id })
    const ids = async (q: string) => {
      const { rows, total } = await get(`/admin/bookings?${q}`)
      expect(total).toBe(rows.length)
      return rows.map((r: { id: number }) => r.id)
    }
    expect(await ids('')).toEqual([a.id, b.id, c.id])
    expect(await ids(`lessonTypeId=${lesson.id}`)).toEqual([a.id, c.id])
    expect(await ids(`coachId=${li.id}&lessonTypeId=${lesson.id}`)).toEqual([c.id])
    expect(await ids('q=小美')).toEqual([a.id, c.id])
    expect(await ids('q=13900')).toEqual([b.id])
    expect(await ids(`q=${bob.id}`)).toEqual([b.id])
    // A phone typed or pasted with spaces, dashes or +86 still matches.
    expect(await ids(`q=${encodeURIComponent('139 0000 0002')}`)).toEqual([b.id])
    expect(await ids(`q=${encodeURIComponent('+86 139-0000-0002')}`)).toEqual([b.id])
    // A search for % or _ is not a wildcard.
    expect(await ids('q=%25')).toEqual([])
    expect(await ids('q=_')).toEqual([])
    expect(await ids('pay=package')).toEqual([b.id])
    expect(await ids('pay=offline')).toEqual([c.id])
    expect(await ids('pay=wechat')).toEqual([a.id])
    expect(await ids('source=staff')).toEqual([c.id])
    expect(await ids('source=student')).toEqual([a.id, b.id])
    // The total counts every match, not the page.
    expect(await get('/admin/bookings?limit=1&offset=1')).toMatchObject({
      rows: [{ id: b.id }],
      total: 3,
    })
    const bad = await h.call('GET', '/admin/bookings?pay=cash', undefined, await h.admin())
    expect(bad.status).toBe(400)
  })

  it('filters 课后点评 by state, lesson type and student', async () => {
    const { coach, lesson, trial, amy, bob, book, get, h } = await venue()
    const seen = book(amy.id, coach.id, lesson.id, '2026-10-20', { attendance: 'attended' })
    const unmarked = book(bob.id, coach.id, trial.id, '2026-10-21')
    const hidden = book(amy.id, coach.id, lesson.id, '2026-10-22', { attendance: 'attended' })
    const gone = book(bob.id, coach.id, lesson.id, '2026-10-23', { attendance: 'attended' })
    const now = h.clock.now
    const feedback = h.db
      .insert(lessonFeedback)
      .values([
        { bookingId: seen.id, text: '好', updatedAt: now },
        { bookingId: unmarked.id, text: '好', updatedAt: now },
        { bookingId: hidden.id, text: '好', updatedAt: now, hiddenAt: now },
        { bookingId: gone.id, text: '好', updatedAt: now, deletedAt: now },
      ])
      .returning()
      .all()
    const [f1, f2, f3, f4] = feedback.map((f) => f.id)
    const ids = async (q: string) => {
      const { rows, total } = await get(`/admin/feedback?${q}`)
      expect(total).toBe(rows.length)
      return rows.map((r: { id: number }) => r.id)
    }
    expect(await ids('')).toEqual([f4, f3, f2, f1])
    expect(await ids('state=visible')).toEqual([f1])
    expect(await ids('state=invisible')).toEqual([f2])
    expect(await ids('state=hidden')).toEqual([f3])
    expect(await ids('state=deleted')).toEqual([f4])
    expect(await ids(`lessonTypeId=${trial.id}`)).toEqual([f2])
    expect(await ids('q=大壮')).toEqual([f4, f2])
    expect(await get('/admin/feedback?limit=1&offset=3')).toMatchObject({
      rows: [{ id: f1 }],
      total: 4,
    })
  })

  it('filters students by lessons left, tester, deleted and when they joined', async () => {
    const { lesson, amy, bob, get, h } = await venue()
    const product = h.db
      .insert(packageProducts)
      .values({
        name: '十次课',
        lessonTypeId: lesson.id,
        lessonCount: 10,
        price: 1,
        validityDays: 90,
      })
      .returning()
      .get()
    const gone = h.db
      .insert(students)
      .values({ openid: 'deleted:1', name: '', deletedAt: at('2026-10-01', 0) })
      .returning()
      .get()
    h.db
      .insert(packages)
      .values({
        studentId: amy.id,
        productId: product.id,
        name: '十次课',
        lessonTypeId: lesson.id,
        coachIds: [],
        lessonsPurchased: 10,
        lessonsRemaining: 3,
        pricePaid: 100000,
        expiresAt: at('2027-01-01', 0),
        status: 'active',
        orderId: 1,
      })
      .run()
    // A deleted account keeps its package but is not listed under lessons left.
    h.db
      .insert(packages)
      .values({
        studentId: gone.id,
        productId: product.id,
        name: '十次课',
        lessonTypeId: lesson.id,
        coachIds: [],
        lessonsPurchased: 10,
        lessonsRemaining: 5,
        pricePaid: 100000,
        expiresAt: at('2027-01-01', 0),
        status: 'active',
        orderId: 2,
      })
      .run()
    const ids = async (q: string) => {
      const { rows, total } = await get(`/admin/students?${q}`)
      expect(total).toBe(rows.length)
      return rows.map((r: { id: number }) => r.id)
    }
    expect(await ids('')).toEqual([gone.id, bob.id, amy.id])
    expect(await ids('lessons=1')).toEqual([amy.id])
    expect(await ids('tester=1')).toEqual([bob.id])
    expect(await ids('deleted=1')).toEqual([gone.id])
    const joined = `from=${at('2026-08-01', 0).toISOString()}&to=${at('2026-09-30', 0).toISOString()}`
    expect(await ids(joined)).toEqual([bob.id])
    expect(await get('/admin/students?limit=1&offset=1')).toMatchObject({
      rows: [{ id: bob.id }],
      total: 3,
    })
  })

  it('filters orders, refunds and invoices, and counts them', async () => {
    const { amy, bob, order, get, h } = await venue()
    const o1 = order(amy.id, { outTradeNo: 'a', createdAt: at('2026-10-01', 9) })
    const o2 = order(bob.id, {
      outTradeNo: 'b',
      kind: 'package',
      provider: 'offline',
      createdAt: at('2026-10-10', 9),
    })
    const o3 = order(amy.id, { outTradeNo: 'c', kind: 'trial', createdAt: at('2026-10-20', 9) })
    const ids = async (path: string) => {
      const { rows, total } = await get(path)
      expect(total).toBe(rows.length)
      return rows.map((r: { id: number }) => r.id)
    }
    expect(await ids('/admin/orders')).toEqual([o3.id, o2.id, o1.id])
    expect(await ids('/admin/orders?kind=package')).toEqual([o2.id])
    expect(await ids('/admin/orders?provider=wechat')).toEqual([o3.id, o1.id])
    expect(await ids('/admin/orders?q=刘')).toEqual([o2.id])
    const october = `from=${at('2026-10-05', 0).toISOString()}&to=${at('2026-10-15', 0).toISOString()}`
    expect(await ids(`/admin/orders?${october}`)).toEqual([o2.id])
    expect(await get('/admin/orders?limit=1&offset=2')).toMatchObject({
      rows: [{ id: o1.id }],
      total: 3,
    })

    const refund = (orderId: number, n: string, createdAt: Date) =>
      h.db
        .insert(refunds)
        .values({
          outRefundNo: n,
          orderId,
          amount: 100,
          reason: '',
          status: 'requested',
          createdAt,
          updatedAt: createdAt,
        })
        .returning()
        .get()
    const r1 = refund(o1.id, 'r1', at('2026-10-02', 9))
    const r2 = refund(o2.id, 'r2', at('2026-10-11', 9))
    expect(await ids('/admin/refunds')).toEqual([r2.id, r1.id])
    expect(await ids('/admin/refunds?provider=offline')).toEqual([r2.id])
    expect(await ids('/admin/refunds?q=张')).toEqual([r1.id])
    expect(await ids(`/admin/refunds?${october}`)).toEqual([r2.id])

    const invoice = (orderId: number, studentId: number, titleKind: 'personal' | 'company') =>
      h.db
        .insert(invoices)
        .values({
          studentId,
          orderId,
          status: 'issued',
          titleKind,
          title: titleKind === 'company' ? '某公司' : '个人',
          email: 'a@b.cn',
          amount: 100,
        })
        .returning()
        .get()
    const i1 = invoice(o1.id, amy.id, 'personal')
    const i2 = invoice(o2.id, bob.id, 'company')
    expect(await ids('/admin/invoices')).toEqual([i2.id, i1.id])
    expect(await ids('/admin/invoices?titleKind=company')).toEqual([i2.id])
    expect(await ids('/admin/invoices?q=13800')).toEqual([i1.id])
    expect(await get('/admin/invoices?limit=1&offset=1')).toMatchObject({
      rows: [{ id: i1.id }],
      total: 2,
    })
  })

  it('searches and pages the action log by position', async () => {
    const { amy, get, h } = await venue()
    h.db
      .insert(actionLog)
      .values(
        Array.from({ length: 5 }, (_, i) => ({
          staffId: 1,
          action: 'student.update',
          summary: i % 2 ? `修改姓名 ${i}` : `修改手机号 ${i}`,
          studentId: i === 0 ? amy.id : null,
        })),
      )
      .run()
    const summaries = async (q: string) => {
      const { rows, total } = await get(`/admin/actions?${q}`)
      return { rows: rows.map((r: { summary: string }) => r.summary), total }
    }
    expect(await summaries('q=姓名')).toEqual({ rows: ['修改姓名 3', '修改姓名 1'], total: 2 })
    // The student it was done for counts too.
    expect(await summaries('q=小美')).toEqual({ rows: ['修改手机号 0'], total: 1 })
    expect(await summaries('limit=2&offset=2')).toEqual({
      rows: ['修改手机号 2', '修改姓名 1'],
      total: 5,
    })
  })

  it('exports with the same filters as the list', async () => {
    const { coach, lesson, trial, amy, bob, book, admin, h } = await venue()
    book(amy.id, coach.id, lesson.id, '2026-10-26')
    book(bob.id, coach.id, trial.id, '2026-10-27', { paidWith: 'package' })
    const res = await h.app.request(
      `/api/admin/exports/bookings?from=2026-10-01&to=2026-10-31&lessonTypeId=${trial.id}&q=大壮&pay=package`,
      { headers: { Authorization: `Bearer ${admin}` } },
    )
    expect(res.status).toBe(200)
    const lines = (await res.text()).trim().split('\r\n')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('刘大壮')
    const log = h.db.select().from(actionLog).all().at(-1)
    expect(log?.summary).toContain('课程：体验课')
    expect(log?.summary).toContain('支付：课时包')
  })
})
