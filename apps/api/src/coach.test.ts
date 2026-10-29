import { venueInstant } from '@rs/shared'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { bookings, coaches, packageProducts, refunds } from './db/schema'
import { MAX_NOTICE_FAILURES, notifyCoaches } from './services/coach-notices'
import { sweep } from './sweeper'
import { type Harness, setup } from './test/harness'
import { fieldValue, type NoticeTemplate, type Notifier, parseTemplate } from './wx-notify'

const MON = 1
const at = (date: string, hhmm: string) =>
  venueInstant(date, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))).toISOString()

/** A seeded venue with the coach bound to the WeChat user `dev:coach`. */
async function withCoach(h: Harness) {
  const seeded = h.seed()
  const admin = await h.admin()
  const { code } = (await h.call('POST', `/admin/coaches/${seeded.coach.id}/bind-code`, {}, admin))
    .json
  const res = await h.call('POST', '/coach/bind', { code: 'dev:coach', bindCode: code })
  expect(res.status).toBe(200)
  return { ...seeded, admin, token: res.json.token as string }
}

async function book(h: Harness, token: string, slotId: number, lessonTypeId: number) {
  const res = await h.call('POST', '/bookings', { slotId, lessonTypeId }, token)
  if (res.json.orderId) await h.fakePay(res.json.orderId)
  return res.json.bookingId as number
}

describe('binding a coach to WeChat', () => {
  it('needs a bind code before the coach can log in', async () => {
    const h = setup()
    const { coach } = h.seed()
    const login = await h.call('POST', '/coach/login', { code: 'dev:coach' })
    expect(login.status).toBe(404)
    expect(login.json.error.code).toBe('not_bound')

    const admin = await h.admin()
    const { code, expiresAt } = (
      await h.call('POST', `/admin/coaches/${coach.id}/bind-code`, {}, admin)
    ).json
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/)
    expect(expiresAt).toBe('2026-10-24T02:00:00.000Z')
    const listed = (await h.call('GET', '/admin/coaches', undefined, admin)).json[0]
    expect(listed).toMatchObject({ bound: false, bindCode: code })
    expect(listed.openid).toBeUndefined()

    // Typed on a phone: lower case and a space are fine.
    const typed = `${code.slice(0, 4).toLowerCase()} ${code.slice(4)}`
    const bind = await h.call('POST', '/coach/bind', { code: 'dev:coach', bindCode: typed })
    expect(bind.status).toBe(200)
    expect(bind.json.coach).toMatchObject({ id: coach.id, name: '王教练', notifyTemplateIds: [] })
    expect((await h.call('GET', '/coach/me', undefined, bind.json.token)).status).toBe(200)
    expect((await h.call('POST', '/coach/login', { code: 'dev:coach' })).status).toBe(200)
    expect((await h.call('GET', '/admin/coaches', undefined, admin)).json[0]).toMatchObject({
      bound: true,
      bindCode: null,
    })

    // The code is single use.
    const again = await h.call('POST', '/coach/bind', { code: 'dev:other', bindCode: code })
    expect(again.json.error.code).toBe('bad_bind_code')
  })

  it('refuses a repeated bind whose first answer was lost, while the coach can log in', async () => {
    // The mini program falls back to logging in when its bind code is refused.
    const h = setup()
    const { coach } = h.seed()
    const admin = await h.admin()
    const { code } = (await h.call('POST', `/admin/coaches/${coach.id}/bind-code`, {}, admin)).json
    expect(
      (await h.call('POST', '/coach/bind', { code: 'dev:coach', bindCode: code })).status,
    ).toBe(200)
    const again = await h.call('POST', '/coach/bind', { code: 'dev:coach', bindCode: code })
    expect(again.json.error.code).toBe('bad_bind_code')
    const login = await h.call('POST', '/coach/login', { code: 'dev:coach' })
    expect(login.status).toBe(200)
    expect(login.json.coach.id).toBe(coach.id)
  })

  it('refuses an expired code', async () => {
    const h = setup()
    const { coach } = h.seed()
    const admin = await h.admin()
    const { code } = (await h.call('POST', `/admin/coaches/${coach.id}/bind-code`, {}, admin)).json
    h.clock.now = new Date('2026-10-24T02:00:01Z')
    const res = await h.call('POST', '/coach/bind', { code: 'dev:coach', bindCode: code })
    expect(res.status).toBe(400)
    expect(res.json.error.code).toBe('bad_bind_code')
  })

  it('keeps one WeChat user to one coach', async () => {
    const h = setup()
    const { coach } = await withCoach(h)
    const other = h.db.insert(coaches).values({ name: '李教练' }).returning().get()
    const admin = await h.admin()
    const { code } = (await h.call('POST', `/admin/coaches/${other.id}/bind-code`, {}, admin)).json
    const res = await h.call('POST', '/coach/bind', { code: 'dev:coach', bindCode: code })
    expect(res.status).toBe(409)
    expect(res.json.error.message).toBe(`这个微信已绑定教练「${coach.name}」`)
  })

  it('signs out the old phone when the coach binds a new one', async () => {
    const h = setup()
    const { coach, admin, token } = await withCoach(h)
    const { code } = (await h.call('POST', `/admin/coaches/${coach.id}/bind-code`, {}, admin)).json
    const fresh = await h.call('POST', '/coach/bind', { code: 'dev:new-phone', bindCode: code })
    expect(fresh.status).toBe(200)
    expect((await h.call('GET', '/coach/me', undefined, token)).status).toBe(401)
    expect((await h.call('GET', '/coach/me', undefined, fresh.json.token)).status).toBe(200)
  })

  it('cuts access when the coach is unbound or deactivated', async () => {
    const h = setup()
    const { coach, admin, token } = await withCoach(h)
    h.db.update(coaches).set({ active: false }).where(eq(coaches.id, coach.id)).run()
    expect((await h.call('GET', '/coach/me', undefined, token)).status).toBe(401)
    expect((await h.call('POST', '/coach/login', { code: 'dev:coach' })).status).toBe(403)
    h.db.update(coaches).set({ active: true }).where(eq(coaches.id, coach.id)).run()
    expect((await h.call('GET', '/coach/me', undefined, token)).status).toBe(200)

    expect(
      (await h.call('DELETE', `/admin/coaches/${coach.id}/binding`, undefined, admin)).status,
    ).toBe(204)
    expect((await h.call('GET', '/coach/me', undefined, token)).status).toBe(401)
    expect((await h.call('POST', '/coach/login', { code: 'dev:coach' })).status).toBe(404)
  })

  it('does not accept a student or admin token', async () => {
    const h = setup()
    await withCoach(h)
    const student = await h.student('coach')
    expect((await h.call('GET', '/coach/me', undefined, student)).status).toBe(401)
    expect((await h.call('GET', '/coach/me', undefined, await h.admin())).status).toBe(401)
  })

  it('tells the student profile when the same WeChat user is a coach', async () => {
    const h = setup()
    await withCoach(h)
    const asCoach = await h.student('coach')
    expect((await h.call('GET', '/me', undefined, asCoach)).json.isCoach).toBe(true)
    const student = await h.student('a')
    expect((await h.call('GET', '/me', undefined, student)).json.isCoach).toBe(false)
  })
})

describe('the coach schedule and lessons', () => {
  async function bookedLesson(h: Harness) {
    const ctx = await withCoach(h)
    const slot = h.slot(ctx.coach.id, '2026-10-26', 10)
    const student = await h.student('a')
    await h.call('PUT', '/me', { name: '小明', phone: '13800138000' }, student)
    const bookingId = await book(h, student, slot.id, ctx.lesson.id)
    return { ...ctx, slot, student, bookingId }
  }

  it('lists lessons with who booked them, the free working time and 请假', async () => {
    const h = setup()
    const { coach, token, slot, bookingId } = await bookedLesson(h)
    h.hours(coach.id, [{ weekday: MON, from: '09:00', to: '13:00' }])
    const admin = await h.admin()
    await h.call(
      'POST',
      `/admin/coaches/${coach.id}/exceptions`,
      {
        kind: 'off',
        startsAt: at('2026-10-26', '12:00'),
        endsAt: at('2026-10-26', '13:00'),
        note: '体检',
      },
      admin,
    )
    const res = await h.call(
      'GET',
      '/coach/schedule?from=2026-10-26&to=2026-10-26',
      undefined,
      token,
    )
    expect(res.json).toEqual({
      lessons: [
        {
          id: slot.id,
          startsAt: at('2026-10-26', '10:00'),
          endsAt: at('2026-10-26', '11:00'),
          lesson: {
            bookingId,
            status: 'confirmed',
            attendance: null,
            studentName: '小明',
            lessonTypeName: '一对一私教',
            isTrial: false,
          },
          group: null,
        },
      ],
      free: [
        { startsAt: at('2026-10-26', '09:00'), endsAt: at('2026-10-26', '10:00') },
        { startsAt: at('2026-10-26', '11:00'), endsAt: at('2026-10-26', '12:00') },
      ],
      off: [
        {
          id: expect.any(Number),
          startsAt: at('2026-10-26', '12:00'),
          endsAt: at('2026-10-26', '13:00'),
          note: '体检',
          closure: false,
        },
      ],
      coachEdits: true,
    })
    expect(
      (await h.call('GET', '/coach/schedule?from=2026-10-26&to=2027-03-31', undefined, token))
        .status,
    ).toBe(400)
    expect(
      (await h.call('GET', '/coach/schedule?from=2026-10-27&to=2026-10-26', undefined, token))
        .status,
    ).toBe(400)
    expect(
      (await h.call('GET', '/coach/schedule?from=2026-02-30&to=2026-13-45', undefined, token))
        .status,
    ).toBe(400)
  })

  it('shows a student who deleted their account without their details', async () => {
    const h = setup()
    const { student, token, bookingId } = await bookedLesson(h)
    h.clock.now = new Date('2026-10-26T03:30:00Z') // after the lesson
    expect((await h.call('DELETE', '/me', undefined, student)).status).toBe(204)
    const lesson = (await h.call('GET', `/coach/lessons/${bookingId}`, undefined, token)).json
    expect(lesson.student).toEqual({ id: 1, name: '已注销学员', phone: '' })
    const [slot] = (
      await h.call('GET', '/coach/schedule?from=2026-10-26&to=2026-10-26', undefined, token)
    ).json.lessons
    expect(slot.lesson.studentName).toBe('已注销学员')
    const note = await h.call('PUT', `/coach/lessons/${bookingId}/note`, { note: '反手' }, token)
    expect(note.json.error.code).toBe('account_deleted')
  })

  it('shows the phone only while the 学员档案 is open', async () => {
    const h = setup()
    const { coach, lesson, token, student, bookingId } = await bookedLesson(h)
    const phoneOf = async (id: number) =>
      (await h.call('GET', `/coach/lessons/${id}`, undefined, token)).json.student.phone
    expect(await phoneOf(bookingId)).toBe('13800138000')
    // A hold not paid yet, and one cancelled.
    const held = await h.call(
      'POST',
      '/bookings',
      { slotId: h.slot(coach.id, '2026-10-27', 10).id, lessonTypeId: lesson.id },
      student,
    )
    const hold = h.db.select().from(bookings).where(eq(bookings.id, held.json.bookingId)).get()
    expect(hold?.status).toBe('pending_payment')
    expect(await phoneOf(held.json.bookingId)).toBe('')
    const cancelled = await book(h, student, h.slot(coach.id, '2026-10-28', 10).id, lesson.id)
    await h.call('POST', `/bookings/${cancelled}/cancel`, {}, student)
    expect(await phoneOf(cancelled)).toBe('')
    // Until a week after the lesson ends (11:00 venue time is 03:00 UTC).
    h.clock.now = new Date('2026-11-02T02:59:00Z')
    expect(await phoneOf(bookingId)).toBe('13800138000')
    h.clock.now = new Date('2026-11-02T03:01:00Z')
    expect(await phoneOf(bookingId)).toBe('')
  })

  it('shows a lesson with the student and earlier lessons together', async () => {
    const h = setup()
    const { coach, lesson, token, student, bookingId } = await bookedLesson(h)
    const later = await book(h, student, h.slot(coach.id, '2026-10-28', 10).id, lesson.id)
    h.clock.now = new Date('2026-10-26T03:30:00Z')
    await h.call('PUT', `/coach/lessons/${bookingId}/note`, { note: '反手要多练' }, token)

    const res = await h.call('GET', `/coach/lessons/${later}`, undefined, token)
    expect(res.json).toMatchObject({
      id: later,
      status: 'confirmed',
      student: { name: '小明', phone: '13800138000' },
      paidWith: 'order',
      price: 20000,
      canMarkAttendance: false,
      canCancel: true,
      lessonsTogether: 1,
      history: [{ id: bookingId, coachNote: '反手要多练', attendance: null }],
    })
    // The earlier lesson does not see the later one, which has not happened yet.
    expect(
      (await h.call('GET', `/coach/lessons/${bookingId}`, undefined, token)).json.history,
    ).toEqual([])
    await h.call('PUT', `/coach/lessons/${bookingId}/attendance`, { attendance: 'no_show' }, token)
    const after = (await h.call('GET', `/coach/lessons/${later}`, undefined, token)).json
    expect(after.lessonsTogether).toBe(0)
    expect(after.history).toMatchObject([{ id: bookingId, attendance: 'no_show' }])
  })

  it('hides other coaches lessons', async () => {
    const h = setup()
    const { bookingId } = await bookedLesson(h)
    const other = h.db.insert(coaches).values({ name: '李教练' }).returning().get()
    const admin = await h.admin()
    const { code } = (await h.call('POST', `/admin/coaches/${other.id}/bind-code`, {}, admin)).json
    const token = (await h.call('POST', '/coach/bind', { code: 'dev:li', bindCode: code })).json
      .token
    expect((await h.call('GET', `/coach/lessons/${bookingId}`, undefined, token)).status).toBe(404)
    const note = await h.call('PUT', `/coach/lessons/${bookingId}/note`, { note: 'x' }, token)
    expect(note.status).toBe(404)
    const cancel = await h.call(
      'POST',
      `/coach/lessons/${bookingId}/cancel`,
      { reason: 'x' },
      token,
    )
    expect(cancel.status).toBe(404)
    h.clock.now = new Date('2026-10-26T02:30:00Z')
    const mark = await h.call(
      'PUT',
      `/coach/lessons/${bookingId}/attendance`,
      { attendance: 'attended' },
      token,
    )
    expect(mark.status).toBe(404)
  })

  it('marks attendance once the lesson starts, for a week', async () => {
    const h = setup()
    const { token, bookingId } = await bookedLesson(h)
    const mark = (attendance: string | null, t = token) =>
      h.call('PUT', `/coach/lessons/${bookingId}/attendance`, { attendance }, t)
    expect((await mark('attended')).json.error.code).toBe('not_started')

    h.clock.now = new Date('2026-10-26T02:00:00Z')
    const marked = await mark('no_show')
    expect(marked.json).toMatchObject({ attendance: 'no_show', canMarkAttendance: true })
    expect((await mark(null)).json.attendance).toBeNull()

    h.clock.now = new Date('2026-11-02T03:00:01Z')
    expect((await mark('attended')).json.error.code).toBe('too_late')
    const admin = await h.admin()
    const byAdmin = await h.call(
      'PUT',
      `/admin/bookings/${bookingId}/attendance`,
      { attendance: 'attended' },
      admin,
    )
    expect(byAdmin.status).toBe(204)
    const list = await h.call('GET', '/admin/bookings?from=2026-10-26T00:00:00Z', undefined, admin)
    expect(list.json[0]).toMatchObject({
      id: bookingId,
      attendance: 'attended',
      status: 'completed',
    })
    expect((await mark('bogus')).status).toBe(400)
  })

  it('does not touch money or the package on a no-show', async () => {
    const h = setup()
    const { token, bookingId } = await bookedLesson(h)
    h.clock.now = new Date('2026-10-26T03:30:00Z')
    await h.call('PUT', `/coach/lessons/${bookingId}/attendance`, { attendance: 'no_show' }, token)
    expect(h.db.select().from(refunds).all()).toHaveLength(0)
    expect(h.db.select().from(bookings).where(eq(bookings.id, bookingId)).get()?.status).toBe(
      'confirmed',
    )
  })

  it('lets the coach cancel with a full refund', async () => {
    const h = setup()
    const { token, slot, lesson, bookingId } = await bookedLesson(h)
    h.clock.now = new Date('2026-10-26T01:30:00Z') // 30 minutes before, past the student deadline
    const res = await h.call(
      'POST',
      `/coach/lessons/${bookingId}/cancel`,
      { reason: '生病' },
      token,
    )
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ status: 'cancelled', cancelledBy: 'venue', canCancel: false })
    expect(res.json.cancelReason).toBe('教练取消：生病')
    expect(h.db.select().from(refunds).get()).toMatchObject({ amount: 20000, status: 'succeeded' })
    const row = h.db.select().from(bookings).where(eq(bookings.id, bookingId)).get()
    expect(row?.coachToldCancelledAt).not.toBeNull()
    // The slot is free again.
    const again = await h.call(
      'POST',
      '/bookings',
      { slotId: slot.id, lessonTypeId: lesson.id },
      await h.student('z'),
    )
    expect(again.json.error.code).toBe('too_soon')
    const note = await h.call('PUT', `/coach/lessons/${bookingId}/note`, { note: 'x' }, token)
    expect(note.json.error.code).toBe('not_live')
    const empty = await h.call('POST', `/coach/lessons/${bookingId}/cancel`, { reason: '' }, token)
    expect(empty.status).toBe(400)
  })

  it('tells the coach which lessons were paid at the front desk', async () => {
    const h = setup()
    const { token, coach, admin, bookingId } = await bookedLesson(h)
    const online = await h.call('GET', `/coach/lessons/${bookingId}`, undefined, token)
    expect(online.json).toMatchObject({ paidWith: 'order', paidOffline: false })

    const student = await h.student('b')
    const studentId = (await h.call('GET', '/me', undefined, student)).json.id as number
    const desk = await h.call(
      'POST',
      '/admin/bookings',
      {
        studentId,
        slotId: h.slot(coach.id, '2026-10-26', 11).id,
        lessonTypeId: 1,
        payWith: 'offline',
        amount: 20000,
        method: 'cash',
      },
      admin,
    )
    expect(desk.status).toBe(201)
    const offline = await h.call('GET', `/coach/lessons/${desk.json.bookingId}`, undefined, token)
    expect(offline.json).toMatchObject({ paidWith: 'order', price: 20000, paidOffline: true })
  })

  it('still cancels when the action log cannot be written', async () => {
    const h = setup()
    const { token, bookingId } = await bookedLesson(h)
    h.db.$client.exec('DROP TABLE action_log')
    const res = await h.call(
      'POST',
      `/coach/lessons/${bookingId}/cancel`,
      { reason: '生病' },
      token,
    )
    expect(res.status).toBe(200)
    expect(res.json.status).toBe('cancelled')
  })

  it('logs a coach cancel once, as the coach, and staff see it as 教练取消', async () => {
    const h = setup()
    const { token, bookingId } = await bookedLesson(h)
    for (let i = 0; i < 2; i++) {
      const res = await h.call(
        'POST',
        `/coach/lessons/${bookingId}/cancel`,
        { reason: '生病' },
        token,
      )
      expect(res.status).toBe(200)
    }
    const admin = await h.admin()
    const log = (await h.call('GET', '/admin/actions', undefined, admin)).json
    expect(log).toMatchObject([
      {
        action: 'coach.cancel',
        summary: '10月26日 10:00 王教练 一对一私教，原因：生病，退款 ¥200',
        amount: 20000,
        staff: null,
        coach: { name: '王教练' },
        targetKind: 'booking',
        targetId: bookingId,
      },
    ])
    expect(log).toHaveLength(1)
    const coachId = log[0].coach.id
    const own = await h.call('GET', `/admin/actions?coachId=${coachId}`, undefined, admin)
    expect(own.json).toHaveLength(1)
    const byStaff = await h.call('GET', '/admin/actions?staffId=1', undefined, admin)
    expect(byStaff.json).toEqual([])
    // The bookings export names the coach, with the reason as they gave it.
    const res = await h.app.request('/api/admin/exports/bookings?from=2026-10-01&to=2026-10-31', {
      headers: { Authorization: `Bearer ${admin}` },
    })
    const row = (await res.text()).trimEnd().split('\r\n')[1]?.split(',') ?? []
    expect(row.slice(14, 16)).toEqual(['教练', '生病'])
  })

  it('still announces a student cancel that beat the coach cancel', async () => {
    const h = setup()
    const { token, student, bookingId } = await bookedLesson(h)
    await h.call('POST', `/bookings/${bookingId}/cancel`, undefined, student)
    const res = await h.call(
      'POST',
      `/coach/lessons/${bookingId}/cancel`,
      { reason: '生病' },
      token,
    )
    expect(res.status).toBe(409)
    const row = h.db.select().from(bookings).where(eq(bookings.id, bookingId)).get()
    expect(row).toMatchObject({
      status: 'cancelled',
      cancelledBy: 'student',
      coachToldCancelledAt: null,
    })
  })

  it('drops the attendance mark when the venue cancels a lesson under way', async () => {
    const h = setup()
    const { token, bookingId } = await bookedLesson(h)
    h.clock.now = new Date('2026-10-26T02:10:00Z')
    await h.call('PUT', `/coach/lessons/${bookingId}/attendance`, { attendance: 'attended' }, token)
    const admin = await h.admin()
    const res = await h.call(
      'POST',
      `/admin/bookings/${bookingId}/cancel`,
      { reason: '停电' },
      admin,
    )
    expect(res.status).toBeLessThan(300)
    const row = h.db.select().from(bookings).where(eq(bookings.id, bookingId)).get()
    expect(row).toMatchObject({ status: 'cancelled', attendance: null })
  })

  it('does not let the coach cancel a lesson that has started', async () => {
    const h = setup()
    const { token, bookingId } = await bookedLesson(h)
    h.clock.now = new Date('2026-10-26T02:10:00Z')
    expect(
      (await h.call('GET', `/coach/lessons/${bookingId}`, undefined, token)).json.canCancel,
    ).toBe(false)
    const res = await h.call(
      'POST',
      `/coach/lessons/${bookingId}/cancel`,
      { reason: '生病' },
      token,
    )
    expect(res.status).toBe(409)
    expect(res.json.error.code).toBe('started')
    const row = h.db.select().from(bookings).where(eq(bookings.id, bookingId)).get()
    expect(row).toMatchObject({ status: 'confirmed', coachToldCancelledAt: null })
  })
})

describe('coach notices', () => {
  function fakeNotifier(result: 'sent' | 'refused' | 'fail' = 'sent') {
    const template: NoticeTemplate = {
      id: 'tpl',
      fields: { thing1: 'student', time2: 'time', thing3: 'lesson' },
    }
    const sent: { openid: string; page: string; data: Record<string, string> }[] = []
    const notifier: Notifier = {
      template: (kind) => (kind.startsWith('coach_') ? { ...template, id: kind } : undefined),
      async send(openid, _template, page, values) {
        if (result === 'fail') throw new Error('offline')
        sent.push({ openid, page, data: { ...values } })
        return result
      },
    }
    return { notifier, sent }
  }

  it('tells the coach about paid and package bookings, not unpaid holds', async () => {
    const h = setup()
    const { notifier, sent } = fakeNotifier()
    h.deps.notifier = notifier
    const { coach, lesson, token } = await withCoach(h)
    expect((await h.call('GET', '/coach/me', undefined, token)).json.notifyTemplateIds).toEqual([
      'coach_booked',
      'coach_cancelled',
      'coach_moved',
    ])
    const student = await h.student('a')
    await h.call('PUT', '/me', { name: '小明' }, student)
    const unpaid = await h.call(
      'POST',
      '/bookings',
      { slotId: h.slot(coach.id, '2026-10-26', 9).id, lessonTypeId: lesson.id },
      student,
    )
    expect(unpaid.status).toBe(201)
    await notifyCoaches(h.deps)
    expect(sent).toHaveLength(0)

    const id = await book(h, student, h.slot(coach.id, '2026-10-26', 10).id, lesson.id)
    await notifyCoaches(h.deps)
    await notifyCoaches(h.deps)
    expect(sent).toEqual([
      {
        openid: 'dev_coach',
        page: `coach/lesson/index?id=${id}`,
        data: {
          student: '小明',
          lesson: '一对一私教',
          time: '2026年10月26日 10:00~11:00',
          coach: '王教练',
          reason: '',
        },
      },
    ])

    await h.call('POST', `/bookings/${id}/cancel`, undefined, student)
    await notifyCoaches(h.deps)
    expect(sent).toHaveLength(2)
    expect(sent[1]?.page).toBe(`coach/lesson/index?id=${id}`)
  })

  it('retries when WeChat is down and gives up once the lesson starts', async () => {
    const h = setup()
    const { notifier } = fakeNotifier('fail')
    h.deps.notifier = notifier
    const { coach, lesson } = await withCoach(h)
    const id = await book(h, await h.student('a'), h.slot(coach.id, '2026-10-26', 10).id, lesson.id)
    await notifyCoaches(h.deps)
    const told = () =>
      h.db.select().from(bookings).where(eq(bookings.id, id)).get()?.coachToldBookedAt
    expect(told()).toBeNull()
    expect(h.logs.some((l) => l.message === 'coach notice failed')).toBe(true)
    h.clock.now = new Date('2026-10-26T02:00:00Z')
    await notifyCoaches(h.deps)
    expect(told()).not.toBeNull()
  })

  it('waits longer after each failed send and gives up after the last', async () => {
    const h = setup()
    let tries = 0
    h.deps.notifier = {
      template: (kind) => ({ id: kind, fields: { thing1: 'student' } }),
      async send() {
        tries++
        throw new Error('subscribe send: 47003 argument invalid')
      },
    }
    const { coach, lesson } = await withCoach(h)
    const id = await book(h, await h.student('a'), h.slot(coach.id, '2026-11-03', 10).id, lesson.id)
    const row = () => h.db.select().from(bookings).where(eq(bookings.id, id)).get()
    const start = h.clock.now.getTime()
    const waits: number[] = []
    for (let i = 1; i < MAX_NOTICE_FAILURES; i++) {
      await notifyCoaches(h.deps)
      expect(tries).toBe(i)
      expect(row()).toMatchObject({ coachNoticeFailures: i, coachToldBookedAt: null })
      // Not tried again before its time.
      await notifyCoaches(h.deps)
      expect(tries).toBe(i)
      const retryAt = row()?.coachNoticeRetryAt as Date
      waits.push((retryAt.getTime() - h.clock.now.getTime()) / 60_000)
      h.clock.now = retryAt
    }
    expect(waits).toEqual([1, 2, 4, 8, 16, 32, 60])
    await notifyCoaches(h.deps)
    expect(tries).toBe(MAX_NOTICE_FAILURES)
    expect(row()).toMatchObject({ coachNoticeFailures: 0, coachNoticeRetryAt: null })
    expect(row()?.coachToldBookedAt).not.toBeNull()
    expect(h.logs.some((l) => l.message === 'coach notice given up')).toBe(true)
    await notifyCoaches(h.deps)
    expect(tries).toBe(MAX_NOTICE_FAILURES)
    expect(h.clock.now.getTime() - start).toBe(123 * 60_000)
  })

  it('starts afresh for the next message about a lesson', async () => {
    const h = setup()
    const sent: string[] = []
    const down = true
    h.deps.notifier = {
      template: (kind) =>
        kind.startsWith('coach_') ? { id: kind, fields: { thing1: 'student' } } : undefined,
      async send(_openid, template) {
        if (down && template.id === 'coach_moved') throw new Error('offline')
        sent.push(template.id)
        return 'sent'
      },
    }
    const { coach, lesson, admin } = await withCoach(h)
    const student = await h.student('a')
    const id = await book(h, student, h.slot(coach.id, '2026-10-26', 10).id, lesson.id)
    await notifyCoaches(h.deps)
    const to = h.slot(coach.id, '2026-10-27', 10)
    expect(
      (await h.call('POST', `/admin/bookings/${id}/move`, { slotId: to.id }, admin)).status,
    ).toBe(204)
    // The move message fails a few times, an 8 minute wait building up.
    for (let i = 0; i < 4; i++) {
      await notifyCoaches(h.deps)
      const row = h.db.select().from(bookings).where(eq(bookings.id, id)).get()
      if (row?.coachNoticeRetryAt) h.clock.now = row.coachNoticeRetryAt
    }
    expect(h.db.select().from(bookings).where(eq(bookings.id, id)).get()).toMatchObject({
      coachNoticeFailures: 4,
      coachNoticeKind: 'moved',
    })
    // The student cancels: the coach hears it at once, not after the move message's wait.
    expect((await h.call('POST', `/bookings/${id}/cancel`, {}, student)).status).toBe(200)
    await notifyCoaches(h.deps)
    expect(sent).toEqual(['coach_booked', 'coach_cancelled'])
    expect(h.db.select().from(bookings).where(eq(bookings.id, id)).get()).toMatchObject({
      coachNoticeFailures: 0,
      coachNoticeKind: null,
      coachNoticeRetryAt: null,
    })
  })

  it('does not tell a coach about changes to a lesson they never heard of', async () => {
    const h = setup()
    const sent: string[] = []
    let down = true
    h.deps.notifier = {
      template: (kind) =>
        kind.startsWith('coach_') ? { id: kind, fields: { thing1: 'student' } } : undefined,
      async send(_openid, template) {
        if (down) throw new Error('offline')
        sent.push(template.id)
        return 'sent'
      },
    }
    const { coach, lesson } = await withCoach(h)
    const student = await h.student('a')
    const id = await book(h, student, h.slot(coach.id, '2026-10-30', 10).id, lesson.id)
    for (let i = 0; i < MAX_NOTICE_FAILURES; i++) {
      await notifyCoaches(h.deps)
      const row = h.db.select().from(bookings).where(eq(bookings.id, id)).get()
      if (row?.coachNoticeRetryAt) h.clock.now = row.coachNoticeRetryAt
    }
    expect(h.db.select().from(bookings).where(eq(bookings.id, id)).get()).toMatchObject({
      coachNoticeKind: 'given_up',
    })
    down = false
    expect((await h.call('POST', `/bookings/${id}/cancel`, {}, student)).status).toBe(200)
    await notifyCoaches(h.deps)
    expect(sent).toEqual([])
    expect(
      h.db.select().from(bookings).where(eq(bookings.id, id)).get()?.coachToldCancelledAt,
    ).not.toBeNull()
  })

  it('does not let failing messages hold up the others', async () => {
    const h = setup()
    const sent: string[] = []
    h.deps.notifier = {
      template: (kind) => ({ id: kind, fields: { thing1: 'student' } }),
      async send(_openid, _template, _page, values) {
        if (values.student !== 'GOOD') throw new Error('subscribe send: 47003 argument invalid')
        sent.push(values.student)
        return 'sent'
      },
    }
    const { coach, lesson } = await withCoach(h)
    const bad = await h.student('bad')
    await h.call('PUT', '/me', { name: 'BAD' }, bad)
    // More failing lessons than one run looks at, all before the good one.
    for (let i = 0; i < 60; i++) {
      const day = `2026-10-${25 + (i % 6)}`
      await book(h, bad, h.slot(coach.id, day, 8 + Math.floor(i / 6)).id, lesson.id)
    }
    const good = await h.student('good')
    await h.call('PUT', '/me', { name: 'GOOD' }, good)
    await book(h, good, h.slot(coach.id, '2026-11-04', 10).id, lesson.id)
    const confirmed = h.db.select().from(bookings).where(eq(bookings.status, 'confirmed')).all()
    expect(confirmed).toHaveLength(61)
    await notifyCoaches(h.deps)
    expect(sent).toEqual([])
    await notifyCoaches(h.deps)
    expect(sent).toEqual(['GOOD'])
  })

  it('closes expired orders before sending coach messages', async () => {
    const h = setup()
    const order: string[] = []
    const { coach, lesson } = await withCoach(h)
    const student = await h.student('a')
    await book(h, student, h.slot(coach.id, '2026-10-26', 10).id, lesson.id)
    const hold = await h.call(
      'POST',
      '/bookings',
      { slotId: h.slot(coach.id, '2026-10-27', 10).id, lessonTypeId: lesson.id },
      student,
    )
    h.clock.now = new Date(h.clock.now.getTime() + 30 * 60_000)
    h.deps.notifier = {
      template: (kind) =>
        kind.startsWith('coach_') ? { id: kind, fields: { thing1: 'student' } } : undefined,
      async send() {
        const held = h.db.select().from(bookings).where(eq(bookings.id, hold.json.bookingId)).get()
        order.push(`send with hold ${held?.status}`)
        return 'sent'
      },
    }
    await sweep(h.deps)
    expect(order).toEqual(['send with hold expired'])
  })

  it('marks bookings as handled when no template is set up', async () => {
    const h = setup()
    const { coach, lesson } = await withCoach(h)
    await book(h, await h.student('a'), h.slot(coach.id, '2026-10-26', 10).id, lesson.id)
    await notifyCoaches(h.deps)
    const pending = h.db
      .select()
      .from(bookings)
      .where(and(eq(bookings.status, 'confirmed')))
      .all()
      .filter((b) => b.coachToldBookedAt === null)
    expect(pending).toHaveLength(0)
  })

  it('reads templates and fits values to WeChat limits', () => {
    expect(parseTemplate('abc thing1=student time2=time')).toEqual({
      id: 'abc',
      fields: { thing1: 'student', time2: 'time' },
    })
    expect(parseTemplate('')).toBeUndefined()
    expect(() => parseTemplate('abc thing1=nobody')).toThrow()
    expect(() => parseTemplate('abc')).toThrow()
    expect(fieldValue('thing1', '一二三四五六七八九十一二三四五六七八九十一')).toBe(
      '一二三四五六七八九十一二三四五六七八九…',
    )
    expect(fieldValue('name2', '')).toBe('-')
    expect(fieldValue('thing4', '今天练了：\n1. 反手  拧拉\n')).toBe('今天练了： 1. 反手 拧拉')
    expect(fieldValue('thing4', ' \n ')).toBe('-')
    expect(fieldValue('time3', '2026年10月26日 10:00~11:00')).toBe('2026年10月26日 10:00~11:00')
  })
})

describe('monthly report', () => {
  it('counts lessons per coach, money and prepaid lessons', async () => {
    const h = setup()
    const { coach, lesson, token, admin } = await withCoach(h)
    const a = await h.student('a')
    const b = await h.student('b')
    const attended = await book(h, a, h.slot(coach.id, '2026-10-26', 10).id, lesson.id)
    const noShow = await book(h, b, h.slot(coach.id, '2026-10-26', 12).id, lesson.id)
    const venueCancel = await book(h, a, h.slot(coach.id, '2026-10-27', 10).id, lesson.id)
    await h.call('POST', `/admin/bookings/${venueCancel}/cancel`, { reason: '场地维修' }, admin)
    const product = h.db
      .insert(packageProducts)
      .values({
        name: '10 次课',
        lessonTypeId: lesson.id,
        lessonCount: 10,
        price: 180000,
        validityDays: 90,
      })
      .returning()
      .get()
    await h.call(
      'POST',
      '/admin/packages/offline-sale',
      { studentId: 2, productId: product.id, amount: 150000, method: 'cash' },
      admin,
    )
    h.clock.now = new Date('2026-10-26T05:00:00Z')
    await h.call('PUT', `/coach/lessons/${attended}/attendance`, { attendance: 'attended' }, token)
    await h.call('PUT', `/coach/lessons/${noShow}/attendance`, { attendance: 'no_show' }, token)

    const later = await h.admin()
    const res = await h.call('GET', '/admin/reports/monthly?month=2026-10', undefined, later)
    expect(res.json).toEqual({
      month: '2026-10',
      coaches: [
        {
          id: coach.id,
          name: '王教练',
          taught: 2,
          minutes: 120,
          attended: 1,
          noShow: 1,
          unmarked: 0,
          venueCancelled: 1,
          lateCancelled: 0,
          // No category, so no rate; no-shows count by default.
          pay: {
            amount: 0,
            lessons: 2,
            unrated: 2,
            lines: [
              { lessonTypeId: lesson.id, name: '一对一私教', lessons: 2, rate: null, amount: 0 },
            ],
            adjustments: [],
          },
        },
      ],
      payStatus: expect.objectContaining({
        rules: { noShows: true, lateCancels: false },
        confirmed: null,
      }),
      revenue: {
        wechat: 60000,
        offline: 150000,
        byKind: { class: 60000, trial: 0, package: 150000 },
        refunded: 20000,
        net: 190000,
      },
      packagesOutstanding: { lessons: 10, value: 150000 },
    })
    const empty = await h.call('GET', '/admin/reports/monthly?month=2026-11', undefined, later)
    expect(empty.json.revenue.net).toBe(0)
    expect(
      (await h.call('GET', '/admin/reports/monthly?month=2026-13', undefined, later)).status,
    ).toBe(400)
  })
})
