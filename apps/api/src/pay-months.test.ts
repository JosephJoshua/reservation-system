import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
  bookings,
  coaches,
  coachLessonTypes,
  coachPayEntries,
  lessonTypes,
  slots,
  students,
} from './db/schema'
import { type Harness, setup } from './test/harness'

/** 王 (主教练, ¥80 a lesson) and 李 (no category) teaching one-to-one lessons. */
async function venue(h: Harness) {
  const { coach: wang, lesson, trial } = h.seed()
  const li = h.db.insert(coaches).values({ name: '李教练', sort: 1 }).returning().get()
  h.db.insert(coachLessonTypes).values({ coachId: li.id, lessonTypeId: lesson.id }).run()
  const auth = { token: await h.admin() }
  const admin = auth.token
  const cat = await h.call(
    'POST',
    '/admin/coach-categories',
    { name: '主教练', payRates: [{ lessonTypeId: lesson.id, rate: 8000 }] },
    admin,
  )
  h.db.update(coaches).set({ categoryId: cat.json.id }).where(eq(coaches.id, wang.id)).run()
  let n = 0
  const student = () =>
    h.db
      .insert(students)
      .values({ openid: `o${++n}`, name: '学员' })
      .returning()
      .get()
  let hour = 8
  const lessonAt = (
    coachId: number,
    date: string,
    fields: Partial<typeof bookings.$inferInsert> = {},
    slotId?: number,
  ) => {
    const slot =
      (slotId && h.db.select().from(slots).where(eq(slots.id, slotId)).get()) ||
      h.slot(coachId, date, hour++)
    return h.db
      .insert(bookings)
      .values({
        slotId: slot.id,
        studentId: student().id,
        lessonTypeId: lesson.id,
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
  const report = async (month: string, token = auth.token) => {
    const res = await h.call('GET', `/admin/reports/monthly?month=${month}`, undefined, token)
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    return res.json
  }
  const confirm = async (month: string, token = auth.token, version?: string) => {
    const v = version ?? (await report(month, token)).payStatus.version
    return h.call('POST', `/admin/reports/pay-months/${month}/confirm`, { version: v }, token)
  }
  const pay = (r: { coaches: { name: string; pay: { amount: number } }[] }) =>
    Object.fromEntries(r.coaches.map((c) => [c.name, c.pay.amount]))
  const setRate = (rate: number) =>
    h.call(
      'PUT',
      `/admin/coach-categories/${cat.json.id}`,
      { name: '主教练', payRates: [{ lessonTypeId: lesson.id, rate }] },
      auth.token,
    )
  const setAttendance = (bookingId: number, attendance: 'attended' | 'no_show' | null) =>
    h.call('PUT', `/admin/bookings/${bookingId}/attendance`, { attendance }, auth.token)
  const setPayRules = async (pay: { noShows: boolean; lateCancels: boolean }) => {
    const s = (await h.call('GET', '/admin/settings', undefined, auth.token)).json
    return h.call('PUT', '/admin/settings', { ...s, pay }, auth.token)
  }
  /** Logs in again after the clock moved past the session's end. */
  const relogin = async () => {
    auth.token = await h.admin()
    return auth.token
  }
  return {
    relogin,
    wang,
    li,
    lesson,
    trial,
    admin,
    lessonAt,
    report,
    confirm,
    pay,
    setRate,
    setAttendance,
    setPayRules,
  }
}

async function payLog(h: Harness, admin: string) {
  return (
    await h.call('GET', '/admin/actions?actions=pay.confirm,pay.unconfirm', undefined, admin)
  ).json.map((e: { summary: string; amount: number | null }) => [e.summary, e.amount])
}

describe('confirming a month of coach pay', () => {
  it('fixes the amounts, once, and logs it', async () => {
    const h = setup({ now: '2026-11-05T02:00:00Z' })
    const v = await venue(h)
    v.lessonAt(v.wang.id, '2026-10-20', { attendance: 'attended' })
    v.lessonAt(v.wang.id, '2026-10-21')

    const open = await v.report('2026-10')
    expect(open.payStatus).toMatchObject({ confirmed: null, blocked: null })
    const first = await v.confirm('2026-10')
    expect(first.status).toBe(200)
    expect(first.json.payStatus.confirmed).toEqual({
      at: '2026-11-05T02:00:00.000Z',
      staff: '管理员',
    })
    // A double click or a retry is the same confirm.
    expect((await v.confirm('2026-10', v.admin, open.payStatus.version)).status).toBe(200)
    expect(await payLog(h, v.admin)).toEqual([['确认 2026-10 课时费，1 位教练，合计 ¥160', 16000]])
    expect(h.db.select().from(coachPayEntries).all()).toHaveLength(2)

    // Later rate and rule changes leave the confirmed month alone.
    await v.setRate(9000)
    await v.setPayRules({ noShows: false, lateCancels: true })
    const after = await v.report('2026-10')
    expect(v.pay(after)).toEqual({ 王教练: 16000, 李教练: 0 })
    expect(after.coaches[0].pay.lines).toEqual([
      { lessonTypeId: v.lesson.id, name: '一对一私教', lessons: 2, rate: 8000, amount: 16000 },
    ])
    expect(after.payStatus.rules).toEqual({ noShows: true, lateCancels: false })
    // The next month owes nothing for them.
    expect(v.pay(await v.report('2026-11'))).toEqual({ 王教练: 0, 李教练: 0 })
  })

  it('refuses a month that has not ended, is out of order, has unrated lessons or changed', async () => {
    const h = setup({ now: '2026-12-05T02:00:00Z' })
    const v = await venue(h)
    v.lessonAt(v.wang.id, '2026-10-20')
    const noRate = v.lessonAt(v.li.id, '2026-11-03')

    const refused = async (month: string, message: string, version?: string) => {
      const res = await v.confirm(month, undefined, version)
      expect(res.status).toBe(409)
      expect(res.json.error.message).toBe(message)
    }
    await refused('2026-12', '这个月还没结束')
    expect((await v.report('2026-12')).payStatus.blocked).toBe('这个月还没结束')
    await refused('2026-11', '还有 1 节课未设课时费，设置后再确认（不付课时费的课程可设为 0 元）')

    const stale = (await v.report('2026-10')).payStatus.version
    v.lessonAt(v.wang.id, '2026-10-22')
    await refused('2026-10', '课时费有变动，请刷新后再确认', stale)
    expect((await v.confirm('2026-10')).status).toBe(200)

    h.clock.now = new Date('2027-01-05T02:00:00Z')
    await v.relogin()
    await refused('2026-12', '请先确认 2026-11 的课时费')
    await refused('2026-09', '早于已确认的月份，不能再确认')
    h.db.delete(bookings).where(eq(bookings.id, noRate.id)).run()
    expect((await v.confirm('2026-11')).status).toBe(200)
    expect((await v.confirm('2026-12')).status).toBe(200)
    expect(await payLog(h, await v.relogin())).toHaveLength(3)
  })

  it('pays changes to a confirmed month in the next open month', async () => {
    const h = setup({ now: '2026-11-05T02:00:00Z' })
    const v = await venue(h)
    await v.setPayRules({ noShows: false, lateCancels: false })
    const a = v.lessonAt(v.wang.id, '2026-10-20', { attendance: 'attended' })
    const b = v.lessonAt(v.wang.id, '2026-10-21', { attendance: 'no_show' })
    v.lessonAt(v.wang.id, '2026-11-02', { attendance: 'attended' })
    expect((await v.confirm('2026-10')).status).toBe(200)
    // Rules changed after the confirm do not reach back.
    await v.setPayRules({ noShows: true, lateCancels: false })
    await v.setRate(9000)

    // a turns out a no-show, b came after all.
    expect((await v.setAttendance(a.id, 'no_show')).status).toBe(204)
    expect((await v.setAttendance(b.id, 'attended')).status).toBe(204)
    let nov = await v.report('2026-11')
    const wang = nov.coaches[0].pay
    expect(wang.adjustments).toEqual([
      {
        lessonTypeId: v.lesson.id,
        name: '一对一私教',
        startsAt: '2026-10-20T00:00:00.000Z',
        lessons: -1,
        rate: 8000,
        amount: -8000,
      },
      {
        lessonTypeId: v.lesson.id,
        name: '一对一私教',
        startsAt: '2026-10-21T01:00:00.000Z',
        lessons: 1,
        rate: 9000,
        amount: 9000,
      },
    ])
    // November's own lesson at today's rate, plus the two adjustments.
    expect(wang).toMatchObject({ lessons: 1, amount: 9000 - 8000 + 9000 })

    // Putting a back takes its adjustment away again.
    await v.setAttendance(a.id, 'attended')
    nov = await v.report('2026-11')
    expect(nov.coaches[0].pay.adjustments.map((x: { amount: number }) => x.amount)).toEqual([9000])
    // A later month does not show them before November is confirmed.
    h.clock.now = new Date('2027-01-05T02:00:00Z')
    await v.relogin()
    expect((await v.report('2026-12')).coaches[0].pay.adjustments).toEqual([])

    expect((await v.confirm('2026-11')).status).toBe(200)
    const confirmed = await v.report('2026-11')
    expect(confirmed.coaches[0].pay).toMatchObject({ lessons: 1, amount: 18000 })
    expect(confirmed.coaches[0].pay.adjustments).toHaveLength(1)
    // Paid once: nothing is owed in December until something changes again.
    expect((await v.report('2026-12')).coaches[0].pay.adjustments).toEqual([])
    await v.setAttendance(b.id, 'no_show')
    // b was paid in November at ¥90; taking it back takes back ¥90.
    expect((await v.report('2026-12')).coaches[0].pay.adjustments).toMatchObject([
      { startsAt: '2026-10-21T01:00:00.000Z', lessons: -1, rate: 9000, amount: -9000 },
    ])
  })

  it('pays a group session once, whichever seats count', async () => {
    const h = setup({ now: '2026-11-05T02:00:00Z' })
    const v = await venue(h)
    const group = h.db
      .insert(lessonTypes)
      .values({ name: '小班课', durationMinutes: 60, price: 8000, capacity: 4 })
      .returning()
      .get()
    const session = h.slot(v.wang.id, '2026-10-20', 15)
    h.db.update(slots).set({ lessonTypeId: group.id }).where(eq(slots.id, session.id)).run()
    await h.call(
      'PUT',
      `/admin/coach-categories/${(await h.call('GET', '/admin/coach-categories', undefined, v.admin)).json[0].id}`,
      {
        name: '主教练',
        payRates: [
          { lessonTypeId: v.lesson.id, rate: 8000 },
          { lessonTypeId: group.id, rate: 12000 },
        ],
      },
      v.admin,
    )
    const seats = [1, 2].map((seat) =>
      v.lessonAt(
        v.wang.id,
        '2026-10-20',
        { lessonTypeId: group.id, seat, attendance: 'attended' },
        session.id,
      ),
    )
    expect(v.pay(await v.report('2026-10'))).toEqual({ 王教练: 12000, 李教练: 0 })
    expect((await v.confirm('2026-10')).status).toBe(200)
    // One seat a no-show still leaves the session taught.
    await v.setPayRules({ noShows: false, lateCancels: false })
    await v.setAttendance(seats[0]?.id ?? 0, 'no_show')
    expect((await v.report('2026-11')).coaches[0].pay.adjustments).toEqual([])
  })
})

describe('reopening a confirmed month', () => {
  it('reopens only the last one, for 管理员, and logs it once', async () => {
    const h = setup({ now: '2026-12-05T02:00:00Z' })
    const v = await venue(h)
    v.lessonAt(v.wang.id, '2026-10-20')
    await v.confirm('2026-10')
    await v.confirm('2026-11')
    const money = await h.call(
      'POST',
      '/admin/staff',
      { name: '财务', username: 'money', password: 'staff-pass-1', roles: ['finance'] },
      v.admin,
    )
    expect(money.status).toBe(201)
    const finance = await h.admin('money', 'staff-pass-1')
    // 财务 confirms but cannot reopen.
    expect(
      (await h.call('DELETE', '/admin/reports/pay-months/2026-11', undefined, finance)).status,
    ).toBe(403)

    const early = await h.call('DELETE', '/admin/reports/pay-months/2026-10', undefined, v.admin)
    expect(early.status).toBe(409)
    expect(early.json.error.message).toBe('只能撤销最近一个确认的月份')
    for (let i = 0; i < 2; i++) {
      const res = await h.call('DELETE', '/admin/reports/pay-months/2026-11', undefined, v.admin)
      expect(res.status).toBe(200)
      expect(res.json.payStatus.confirmed).toBeNull()
    }
    expect((await payLog(h, v.admin))[0]).toEqual(['撤销 2026-11 课时费确认', null])
    expect(await payLog(h, v.admin)).toHaveLength(3)
    expect(
      h.db.select().from(coachPayEntries).where(eq(coachPayEntries.month, '2026-11')).all(),
    ).toEqual([])
    // Confirming again works as before.
    expect((await v.confirm('2026-11', finance)).status).toBe(200)
  })

  it('refuses a bad month', async () => {
    const h = setup()
    const admin = await h.admin()
    for (const month of ['2026-13', '2026-1', 'abc']) {
      const res = await h.call(
        'POST',
        `/admin/reports/pay-months/${month}/confirm`,
        { version: 'x' },
        admin,
      )
      expect(res.status).toBe(400)
    }
  })
})
