import { defaultSettings } from '@rs/shared'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { bookings, coaches, coachLessonTypes, lessonTypes, slots, students } from './db/schema'
import { countsForPay } from './services/coach-pay'
import { type Harness, setup } from './test/harness'

const rules = defaultSettings.pay
const now = new Date('2026-10-26T12:00:00Z')
const ended = new Date('2026-10-26T03:00:00Z')
const later = new Date('2026-10-27T03:00:00Z')

describe('countsForPay', () => {
  const lesson = {
    status: 'confirmed',
    endsAt: ended,
    attendance: null,
    cancelledBy: null,
    late: false,
  } as const

  it('pays lessons that ended, marked or not', () => {
    expect(countsForPay(lesson, rules, now)).toBe(true)
    expect(countsForPay({ ...lesson, attendance: 'attended' }, rules, now)).toBe(true)
    expect(countsForPay({ ...lesson, endsAt: later }, rules, now)).toBe(false)
    expect(countsForPay({ ...lesson, endsAt: now }, rules, now)).toBe(true)
  })

  it('pays no-shows only when the venue counts them', () => {
    const noShow = { ...lesson, attendance: 'no_show' } as const
    expect(countsForPay(noShow, { noShows: true, lateCancels: false }, now)).toBe(true)
    expect(countsForPay(noShow, { noShows: false, lateCancels: true }, now)).toBe(false)
  })

  it('pays late student cancels only when the venue counts them, and never other cancels', () => {
    const late = { ...lesson, status: 'cancelled', cancelledBy: 'student', late: true } as const
    expect(countsForPay(late, { noShows: true, lateCancels: false }, now)).toBe(false)
    expect(countsForPay(late, { noShows: false, lateCancels: true }, now)).toBe(true)
    // Like a taught lesson, it counts once its time has passed.
    expect(
      countsForPay({ ...late, endsAt: later }, { noShows: true, lateCancels: true }, now),
    ).toBe(false)
    const all = { noShows: true, lateCancels: true }
    expect(countsForPay({ ...late, late: false }, all, now)).toBe(false)
    expect(countsForPay({ ...late, cancelledBy: 'venue' }, all, now)).toBe(false)
    expect(countsForPay({ ...lesson, status: 'pending_payment' }, all, now)).toBe(false)
    expect(countsForPay({ ...lesson, status: 'expired' }, all, now)).toBe(false)
  })
})

async function category(
  h: Harness,
  admin: string,
  name: string,
  payRates: { lessonTypeId: number; rate: number }[],
  prices: { lessonTypeId: number; price: number }[] = [],
) {
  const res = await h.call('POST', '/admin/coach-categories', { name, prices, payRates }, admin)
  expect(res.status).toBe(201)
  return res.json
}

async function payLog(h: Harness, admin: string) {
  return (await h.call('GET', '/admin/actions?actions=price.coach_pay', undefined, admin)).json.map(
    (e: { summary: string }) => e.summary,
  )
}

describe('pay rates on coach categories', () => {
  it('saves rates with the category and logs each change', async () => {
    const h = setup()
    const { lesson, trial } = h.seed()
    const admin = await h.admin()
    const cat = await category(h, admin, '主教练', [{ lessonTypeId: lesson.id, rate: 8000 }])
    expect(cat.payRates).toEqual([{ lessonTypeId: lesson.id, rate: 8000 }])
    expect(await payLog(h, admin)).toEqual(['类别「主教练」课时费：一对一私教 ¥80'])

    const put = (body: object) =>
      h.call('PUT', `/admin/coach-categories/${cat.id}`, { name: '主教练', ...body }, admin)
    // A price change alone is logged as a price, not as pay.
    let res = await put({
      prices: [{ lessonTypeId: lesson.id, price: 30000 }],
      payRates: [{ lessonTypeId: lesson.id, rate: 8000 }],
    })
    expect(res.status).toBe(200)
    expect(await payLog(h, admin)).toHaveLength(1)
    const priceLog = (await h.call('GET', '/admin/actions?actions=price.coach', undefined, admin))
      .json
    expect(priceLog.map((e: { summary: string }) => e.summary)).toEqual([
      '类别「主教练」：一对一私教 ¥300',
    ])

    res = await put({
      prices: [{ lessonTypeId: lesson.id, price: 30000 }],
      payRates: [
        { lessonTypeId: lesson.id, rate: 9050 },
        { lessonTypeId: trial.id, rate: 0 },
      ],
    })
    expect(res.json.payRates).toEqual([
      { lessonTypeId: lesson.id, rate: 9050 },
      { lessonTypeId: trial.id, rate: 0 },
    ])
    expect((await payLog(h, admin))[0]).toBe(
      '类别「主教练」课时费：一对一私教 ¥80 改为 ¥90.50；体验课 ¥0',
    )

    res = await put({ prices: [{ lessonTypeId: lesson.id, price: 30000 }], payRates: [] })
    expect(res.json.payRates).toEqual([])
    expect((await payLog(h, admin))[0]).toBe(
      '类别「主教练」课时费：一对一私教 改为未设置；体验课 改为未设置',
    )
  })

  it('refuses bad rates and unknown lesson types', async () => {
    const h = setup()
    const { lesson } = h.seed()
    const admin = await h.admin()
    const post = (payRates: unknown) =>
      h.call('POST', '/admin/coach-categories', { name: '主教练', payRates }, admin)
    expect((await post([{ lessonTypeId: lesson.id, rate: -1 }])).status).toBe(400)
    expect((await post([{ lessonTypeId: lesson.id, rate: 1.5 }])).status).toBe(400)
    const huge = await post([{ lessonTypeId: lesson.id, rate: 10_000_001 }])
    expect(huge.json.error.message).toBe('课时费超出允许范围')
    expect((await post([{ lessonTypeId: 999, rate: 100 }])).status).toBe(404)
    expect(await payLog(h, admin)).toEqual([])
  })

  it('keeps one rate per lesson type when a lesson type is sent twice', async () => {
    const h = setup()
    const { lesson } = h.seed()
    const admin = await h.admin()
    const cat = await category(h, admin, '主教练', [
      { lessonTypeId: lesson.id, rate: 100 },
      { lessonTypeId: lesson.id, rate: 200 },
    ])
    expect(cat.payRates).toEqual([{ lessonTypeId: lesson.id, rate: 200 }])
  })

  it('deletes a category that has rates and no coaches', async () => {
    const h = setup()
    const { lesson } = h.seed()
    const admin = await h.admin()
    const cat = await category(h, admin, '主教练', [{ lessonTypeId: lesson.id, rate: 100 }])
    const res = await h.call('DELETE', `/admin/coach-categories/${cat.id}`, undefined, admin)
    expect(res.status).toBe(204)
    expect((await h.call('GET', '/admin/coach-categories', undefined, admin)).json).toEqual([])
  })

  it('logs a change to which lessons count, once', async () => {
    const h = setup()
    const admin = await h.admin()
    const current = (await h.call('GET', '/admin/settings', undefined, admin)).json
    expect(current.pay).toEqual({ noShows: true, lateCancels: false })
    const save = async (pay: object) => {
      const before = (await h.call('GET', '/admin/settings', undefined, admin)).json
      return h.call('PUT', '/admin/settings', { ...before, pay }, admin)
    }
    expect((await save({ noShows: false, lateCancels: true })).status).toBe(200)
    expect((await save({ noShows: false, lateCancels: true })).status).toBe(200)
    expect(await payLog(h, admin)).toEqual(['课时费计算：缺席不计入，学员逾时取消计入'])
    const general = (
      await h.call('GET', '/admin/actions?actions=settings.update', undefined, admin)
    ).json
    expect(general).toEqual([])
  })
})

/** Two coaches in October: 王 is a 主教练, 李 has no category. */
function venue(h: Harness) {
  const { coach: wang, lesson, trial } = h.seed()
  const li = h.db.insert(coaches).values({ name: '李教练', sort: 1 }).returning().get()
  h.db.insert(coachLessonTypes).values({ coachId: li.id, lessonTypeId: lesson.id }).run()
  const student = h.db.insert(students).values({ openid: 'o1', name: '学员' }).returning().get()
  let hour = 8
  const lessonAt = (
    coachId: number,
    lessonTypeId: number,
    date: string,
    fields: Partial<typeof bookings.$inferInsert> = {},
  ) => {
    const slot = h.slot(coachId, date, hour++)
    return h.db
      .insert(bookings)
      .values({
        slotId: slot.id,
        studentId: student.id,
        lessonTypeId,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        status: 'confirmed',
        paidWith: 'order',
        price: 20000,
        ...fields,
      })
      .returning()
      .get()
  }
  return { wang, li, lesson, trial, lessonAt }
}

describe('coach pay in the monthly report', () => {
  it('pays each coach by rate and lesson type, following the venue setting', async () => {
    const h = setup({ now: '2026-10-28T12:00:00Z' })
    const { wang, li, lesson, trial, lessonAt } = venue(h)
    const admin = await h.admin()
    const cat = await category(h, admin, '主教练', [
      { lessonTypeId: lesson.id, rate: 8000 },
      { lessonTypeId: trial.id, rate: 3000 },
    ])
    h.db.update(coaches).set({ categoryId: cat.id }).where(eq(coaches.id, wang.id)).run()

    lessonAt(wang.id, lesson.id, '2026-10-20', { attendance: 'attended' })
    lessonAt(wang.id, lesson.id, '2026-10-21')
    lessonAt(wang.id, lesson.id, '2026-10-22', { attendance: 'no_show' })
    lessonAt(wang.id, trial.id, '2026-10-23', { attendance: 'attended' })
    lessonAt(wang.id, lesson.id, '2026-10-24', {
      status: 'cancelled',
      cancelledBy: 'student',
      late: true,
    })
    lessonAt(wang.id, lesson.id, '2026-10-24', { status: 'cancelled', cancelledBy: 'student' })
    lessonAt(wang.id, lesson.id, '2026-10-25', { status: 'cancelled', cancelledBy: 'venue' })
    // Not yet taught, outside the month, or never paid for.
    lessonAt(wang.id, lesson.id, '2026-10-30')
    lessonAt(wang.id, lesson.id, '2026-11-02', { attendance: 'attended' })
    lessonAt(wang.id, lesson.id, '2026-09-30', { attendance: 'attended' })
    lessonAt(wang.id, lesson.id, '2026-10-26', { status: 'expired' })
    // 李 has no category, so no rate.
    lessonAt(li.id, lesson.id, '2026-10-20', { attendance: 'attended' })

    const report = async () =>
      (await h.call('GET', '/admin/reports/monthly?month=2026-10', undefined, admin)).json
    let r = await report()
    expect(r.payRules).toEqual({ noShows: true, lateCancels: false })
    expect(r.coaches.map((c: { name: string; pay: unknown }) => [c.name, c.pay])).toEqual([
      [
        '王教练',
        {
          amount: 3 * 8000 + 3000,
          lessons: 4,
          unrated: 0,
          lines: [
            { lessonTypeId: lesson.id, name: '一对一私教', lessons: 3, rate: 8000, amount: 24000 },
            { lessonTypeId: trial.id, name: '体验课', lessons: 1, rate: 3000, amount: 3000 },
          ],
        },
      ],
      [
        '李教练',
        {
          amount: 0,
          lessons: 1,
          unrated: 1,
          lines: [
            { lessonTypeId: lesson.id, name: '一对一私教', lessons: 1, rate: null, amount: 0 },
          ],
        },
      ],
    ])

    const before = (await h.call('GET', '/admin/settings', undefined, admin)).json
    await h.call(
      'PUT',
      '/admin/settings',
      { ...before, pay: { noShows: false, lateCancels: true } },
      admin,
    )
    r = await report()
    expect(r.payRules).toEqual({ noShows: false, lateCancels: true })
    // The no-show drops out and the late cancel comes in.
    expect(r.coaches[0].pay).toMatchObject({ amount: 3 * 8000 + 3000, lessons: 4 })
    expect(r.coaches[0].pay.lines[0].lessons).toBe(3)

    await h.call(
      'PUT',
      '/admin/settings',
      { ...before, pay: { noShows: false, lateCancels: false } },
      admin,
    )
    expect((await report()).coaches[0].pay).toMatchObject({ amount: 2 * 8000 + 3000, lessons: 3 })
  })

  it('pays a moved lesson to the coach who teaches it', async () => {
    const h = setup({ now: '2026-10-28T12:00:00Z' })
    const { wang, li, lesson, lessonAt } = venue(h)
    const admin = await h.admin()
    const cat = await category(h, admin, '主教练', [{ lessonTypeId: lesson.id, rate: 8000 }])
    h.db.update(coaches).set({ categoryId: cat.id }).run()
    const b = lessonAt(wang.id, lesson.id, '2026-10-20')
    const moved = h.slot(li.id, '2026-10-21', 15)
    h.db
      .update(bookings)
      .set({ slotId: moved.id, startsAt: moved.startsAt, endsAt: moved.endsAt })
      .run()
    expect(b.id).toBe(1)
    const r = (await h.call('GET', '/admin/reports/monthly?month=2026-10', undefined, admin)).json
    expect(
      r.coaches.map((c: { name: string; pay: { amount: number } }) => [c.name, c.pay.amount]),
    ).toEqual([
      ['王教练', 0],
      ['李教练', 8000],
    ])
  })

  it('shows the lesson types in their own order', async () => {
    const h = setup({ now: '2026-10-28T12:00:00Z' })
    const { wang, lesson, trial, lessonAt } = venue(h)
    const admin = await h.admin()
    h.db.update(lessonTypes).set({ sort: 5 }).where(eq(lessonTypes.id, lesson.id)).run()
    lessonAt(wang.id, lesson.id, '2026-10-20')
    lessonAt(wang.id, trial.id, '2026-10-21')
    const r = (await h.call('GET', '/admin/reports/monthly?month=2026-10', undefined, admin)).json
    expect(r.coaches[0].pay.lines.map((l: { name: string }) => l.name)).toEqual([
      '体验课',
      '一对一私教',
    ])
  })
})

describe('课时费 in the bookings export', () => {
  it('shows the rate on lessons the coach is paid for', async () => {
    const h = setup({ now: '2026-10-28T12:00:00Z' })
    const { wang, li, lesson, lessonAt } = venue(h)
    const admin = await h.admin()
    const cat = await category(h, admin, '主教练', [{ lessonTypeId: lesson.id, rate: 8050 }])
    h.db.update(coaches).set({ categoryId: cat.id }).where(eq(coaches.id, wang.id)).run()
    lessonAt(wang.id, lesson.id, '2026-10-20', { attendance: 'attended' })
    lessonAt(wang.id, lesson.id, '2026-10-21', { status: 'cancelled', cancelledBy: 'venue' })
    lessonAt(wang.id, lesson.id, '2026-10-30')
    lessonAt(li.id, lesson.id, '2026-10-22')
    const res = await h.app.request('/api/admin/exports/bookings?from=2026-10-01&to=2026-10-31', {
      headers: { Authorization: `Bearer ${admin}` },
    })
    const rows = (await res.text())
      .trimEnd()
      .split('\r\n')
      .map((l) => l.split(',').at(-2))
    expect(rows).toEqual(['课时费（元）', '80.50', '', '未设置', ''])
  })
})

describe('coach pay for group sessions', () => {
  it('counts a session once, however many students took a seat', async () => {
    const h = setup({ now: '2026-10-28T12:00:00Z' })
    const { wang } = venue(h)
    const admin = await h.admin()
    const kids = h.db
      .insert(lessonTypes)
      .values({ name: '少儿小班课', durationMinutes: 60, price: 8000, capacity: 4 })
      .returning()
      .get()
    const cat = await category(h, admin, '主教练', [{ lessonTypeId: kids.id, rate: 10000 }])
    h.db.update(coaches).set({ categoryId: cat.id }).where(eq(coaches.id, wang.id)).run()
    const kid = (n: number) =>
      h.db
        .insert(students)
        .values({ openid: `k${n}`, name: `学员${n}` })
        .returning()
        .get()
    const seats = (
      date: string,
      list: Partial<typeof bookings.$inferInsert>[],
      session: Partial<typeof slots.$inferInsert> = {},
    ) => {
      const slot = h.slot(wang.id, date, 9)
      h.db
        .update(slots)
        .set({ lessonTypeId: kids.id, capacity: 4, ...session })
        .where(eq(slots.id, slot.id))
        .run()
      list.forEach((fields, i) => {
        h.db
          .insert(bookings)
          .values({
            slotId: slot.id,
            seat: i + 1,
            studentId: kid(Number(`${date.slice(-2)}${i}`)).id,
            lessonTypeId: kids.id,
            startsAt: slot.startsAt,
            endsAt: slot.endsAt,
            status: 'confirmed',
            paidWith: 'order',
            price: 8000,
            ...fields,
          })
          .run()
      })
    }
    seats('2026-10-20', [
      { attendance: 'attended' },
      { attendance: 'attended' },
      { attendance: 'no_show' },
    ])
    const off = { status: 'cancelled', cancelledBy: 'venue' } as const
    seats('2026-10-21', [off, off], { cancelledAt: new Date('2026-10-20T00:00:00Z') })

    const r = (await h.call('GET', '/admin/reports/monthly?month=2026-10', undefined, admin)).json
    expect(r.coaches[0]).toMatchObject({
      taught: 1,
      minutes: 60,
      attended: 2,
      noShow: 1,
      venueCancelled: 1,
      pay: { amount: 10000, lessons: 1 },
    })
    const res = await h.app.request('/api/admin/exports/bookings?from=2026-10-01&to=2026-10-31', {
      headers: { Authorization: `Bearer ${admin}` },
    })
    const pay = (await res.text())
      .trimEnd()
      .split('\r\n')
      .slice(1)
      .map((l) => l.split(',').at(-2))
    expect(pay).toEqual(['100.00', '', '', '', ''])
  })
})
