import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { actionLog, bookings, coaches, idempotencyKeys, scheduleExceptions } from './db/schema'
import { type Harness, setup } from './test/harness'

const CODE = 'https://yuyue.example.com/checkin'

/** A paid lesson on Monday 2026-10-26 at 10:00 venue time (02:00Z), and a bound coach. */
async function lesson(h: Harness) {
  const { coach, lesson } = h.seed()
  const admin = await h.admin()
  const { code } = (await h.call('POST', `/admin/coaches/${coach.id}/bind-code`, {}, admin)).json
  const coachToken = (await h.call('POST', '/coach/bind', { code: 'dev:coach', bindCode: code }))
    .json.token as string
  const slot = h.slot(coach.id, '2026-10-26', 10)
  const student = await h.student('a')
  await h.call('PUT', '/me', { name: '小明', phone: '13800138000' }, student)
  const res = await h.call(
    'POST',
    '/bookings',
    { slotId: slot.id, lessonTypeId: lesson.id },
    student,
  )
  await h.fakePay(res.json.orderId)
  return {
    coach,
    lesson,
    admin,
    coachToken,
    student,
    slot,
    bookingId: res.json.bookingId as number,
  }
}

const row = (h: Harness, id: number) =>
  h.db.select().from(bookings).where(eq(bookings.id, id)).get()

describe('student check-in', () => {
  it('opens 30 minutes before the lesson and lasts until it ends', async () => {
    const h = setup()
    const { student, bookingId } = await lesson(h)
    const scan = () => h.call('POST', '/check-in', { code: CODE }, student)

    h.clock.now = new Date('2026-10-25T10:00:00Z')
    expect((await scan()).json.error.message).toBe(
      '下节课10月26日 10:00 开始，课前 30 分钟起可签到',
    )

    h.clock.now = new Date('2026-10-26T01:29:00Z')
    const early = await scan()
    expect(early.status).toBe(409)
    expect(early.json.error).toMatchObject({
      code: 'nothing_to_check_in',
      message: '下节课今天 10:00 开始，课前 30 分钟起可签到',
    })
    let detail = (await h.call('GET', `/bookings/${bookingId}`, undefined, student)).json
    expect(detail.canCheckIn).toBe(false)

    h.clock.now = new Date('2026-10-26T01:30:00Z')
    detail = (await h.call('GET', `/bookings/${bookingId}`, undefined, student)).json
    expect(detail.canCheckIn).toBe(true)
    const first = await scan()
    expect(first.status).toBe(200)
    expect(first.json).toEqual([
      {
        bookingId,
        startsAt: '2026-10-26T02:00:00.000Z',
        endsAt: '2026-10-26T03:00:00.000Z',
        coachName: '王教练',
        lessonTypeName: '一对一私教',
        already: false,
      },
    ])
    expect(row(h, bookingId)).toMatchObject({
      attendance: 'attended',
      attendanceBy: 'student',
      attendanceAt: new Date('2026-10-26T01:30:00Z'),
    })

    // A second scan is fine and keeps the first time.
    h.clock.now = new Date('2026-10-26T01:40:00Z')
    expect((await scan()).json[0].already).toBe(true)
    expect(row(h, bookingId)?.attendanceAt).toEqual(new Date('2026-10-26T01:30:00Z'))
    detail = (await h.call('GET', `/bookings/${bookingId}`, undefined, student)).json
    expect(detail).toMatchObject({ attendance: 'attended', canCheckIn: false })

    h.clock.now = new Date('2026-10-26T03:00:00Z')
    expect((await scan()).json.error).toMatchObject({
      code: 'nothing_to_check_in',
      message: '没有待上的课程。如果是在前台预约的，请联系前台',
    })
  })

  it('refuses other codes, a lesson marked absent and a venue that turned it off', async () => {
    const h = setup()
    const { student, bookingId } = await lesson(h)
    h.clock.now = new Date('2026-10-26T02:10:00Z')
    // Staff sessions do not last the days the clock skips.
    const admin = await h.admin()
    for (const code of ['https://yuyue.example.com/other', 'checkin', 'https://x.com/checkin/a']) {
      const res = await h.call('POST', '/check-in', { code }, student)
      expect(res.json.error.code).toBe('not_check_in_code')
    }
    expect((await h.call('POST', '/check-in', { code: CODE })).status).toBe(401)

    await h.call('PUT', `/admin/bookings/${bookingId}/attendance`, { attendance: 'no_show' }, admin)
    const absent = await h.call('POST', '/check-in', { code: CODE }, student)
    expect(absent.json.error).toMatchObject({
      code: 'marked',
      message: '该课程已记为缺席，请联系前台',
    })
    expect(row(h, bookingId)?.attendance).toBe('no_show')

    await h.call('PUT', `/admin/bookings/${bookingId}/attendance`, { attendance: null }, admin)
    h.settings((s) => {
      s.attendance.selfCheckIn = false
    })
    const off = await h.call('POST', '/check-in', { code: CODE }, student)
    expect(off.status).toBe(403)
    expect(off.json.error.code).toBe('check_in_off')
    const detail = (await h.call('GET', `/bookings/${bookingId}`, undefined, student)).json
    expect(detail.canCheckIn).toBe(false)
  })

  it('checks in every seat open at once and skips cancelled lessons', async () => {
    const h = setup()
    const { coach, lesson: type, student, bookingId } = await lesson(h)
    const next = h.slot(coach.id, '2026-10-26', 11)
    const res = await h.call(
      'POST',
      '/bookings',
      { slotId: next.id, lessonTypeId: type.id },
      student,
    )
    await h.fakePay(res.json.orderId)
    const cancelled = h.slot(coach.id, '2026-10-26', 9)
    const c = await h.call(
      'POST',
      '/bookings',
      { slotId: cancelled.id, lessonTypeId: type.id },
      student,
    )
    await h.fakePay(c.json.orderId)
    await h.call('POST', `/bookings/${c.json.bookingId}/cancel`, { acceptLate: true }, student)

    // 10:40: the 10:00 lesson is under way and the 11:00 one opens at 10:30.
    h.clock.now = new Date('2026-10-26T02:40:00Z')
    const scan = await h.call('POST', '/check-in', { code: CODE }, student)
    expect(scan.json.map((l: { bookingId: number }) => l.bookingId)).toEqual([
      bookingId,
      res.json.bookingId,
    ])
    expect(row(h, c.json.bookingId)?.attendance).toBeNull()
  })
})

describe('front desk 签到', () => {
  it('says when the lesson is disrupted, and still lets the desk mark it', async () => {
    const h = setup()
    const { coach, slot, bookingId } = await lesson(h)
    h.clock.now = new Date('2026-10-26T01:35:00Z')
    const admin = await h.admin()
    const seen = async () => ({
      list: (await h.call('GET', '/admin/front-desk', undefined, admin)).json[0].disruption,
      lesson: (await h.call('GET', `/admin/slots/${slot.id}`, undefined, admin)).json.disruption,
      booking: (await h.call('GET', `/admin/bookings?id=${bookingId}`, undefined, admin)).json[0]
        .lessonDisruption,
    })
    expect(await seen()).toEqual({ list: null, lesson: null, booking: null })

    const off = h.db
      .insert(scheduleExceptions)
      .values({
        coachId: coach.id,
        kind: 'off',
        startsAt: new Date('2026-10-26T00:00:00Z'),
        endsAt: new Date('2026-10-26T10:00:00Z'),
      })
      .returning()
      .get()
    expect(await seen()).toEqual({ list: 'off', lesson: 'off', booking: 'off' })
    // Staff on site know best: asked in the admin, not refused.
    const mark = await h.call(
      'PUT',
      `/admin/bookings/${bookingId}/attendance`,
      { attendance: 'attended' },
      admin,
    )
    expect(mark.status).toBe(204)
    // A 闭馆 comes first, and still shows once the lesson ended.
    h.db
      .insert(scheduleExceptions)
      .values({ coachId: null, kind: 'off', startsAt: off.startsAt, endsAt: off.endsAt })
      .run()
    h.clock.now = new Date('2026-10-26T05:00:00Z')
    expect(await seen()).toEqual({ list: 'closed', lesson: 'closed', booking: 'closed' })
    // The student-side value ends with the lesson; the staff one does not.
    const [listed] = (await h.call('GET', `/admin/bookings?id=${bookingId}`, undefined, admin)).json
    expect(listed.disruption).toBeNull()

    // A coach who stopped teaching after the lesson may well have given it.
    h.db.delete(scheduleExceptions).run()
    h.db.update(coaches).set({ active: false }).where(eq(coaches.id, coach.id)).run()
    expect(await seen()).toEqual({ list: null, lesson: null, booking: null })
    h.clock.now = new Date('2026-10-26T02:30:00Z')
    expect(await seen()).toEqual({ list: 'inactive', lesson: 'inactive', booking: 'inactive' })
  })

  it('lists the day with who marked each lesson', async () => {
    const h = setup()
    const { coachToken, student, bookingId } = await lesson(h)
    h.clock.now = new Date('2026-10-26T01:00:00Z')
    const admin = await h.admin()
    const list = async () => (await h.call('GET', '/admin/front-desk', undefined, admin)).json
    expect(await list()).toEqual([
      {
        bookingId,
        slotId: expect.any(Number),
        startsAt: '2026-10-26T02:00:00.000Z',
        endsAt: '2026-10-26T03:00:00.000Z',
        coach: { id: expect.any(Number), name: '王教练' },
        lessonTypeName: '一对一私教',
        capacity: 1,
        student: { id: expect.any(Number), name: '小明', phone: '13800138000' },
        attendance: null,
        attendanceAt: null,
        markedBy: null,
        canArrive: false,
        canMarkAbsent: false,
        disruption: null,
      },
    ])
    const other = await h.call('GET', '/admin/front-desk?date=2026-10-27', undefined, admin)
    expect(other.json).toEqual([])
    expect(
      (await h.call('GET', '/admin/front-desk?date=2026-02-30', undefined, admin)).status,
    ).toBe(400)

    const mark = (attendance: string | null) =>
      h.call('PUT', `/admin/bookings/${bookingId}/attendance`, { attendance }, admin)
    expect((await mark('attended')).json.error.code).toBe('not_started')

    // 09:35: the student walks in early.
    h.clock.now = new Date('2026-10-26T01:35:00Z')
    expect((await list())[0]).toMatchObject({ canArrive: true, canMarkAbsent: false })
    expect((await mark('no_show')).json.error.code).toBe('not_started')
    // A slip on the wrong row can be undone before the lesson starts.
    expect((await mark('attended')).status).toBe(204)
    expect((await mark(null)).status).toBe(204)
    expect((await mark('attended')).status).toBe(204)
    expect((await list())[0]).toMatchObject({
      attendance: 'attended',
      attendanceAt: '2026-10-26T01:35:00.000Z',
      markedBy: { kind: 'staff', name: '管理员' },
    })

    // A student scan does not take over a staff mark, and nor does a repeat.
    await h.call('POST', '/check-in', { code: CODE }, student)
    expect((await mark('attended')).status).toBe(204)
    expect((await list())[0].markedBy).toEqual({ kind: 'staff', name: '管理员' })

    // The coach cannot change or clear the front desk's mark.
    h.clock.now = new Date('2026-10-26T02:05:00Z')
    for (const attendance of ['no_show', null]) {
      const res = await h.call(
        'PUT',
        `/coach/lessons/${bookingId}/attendance`,
        { attendance },
        coachToken,
      )
      expect(res.status).toBe(409)
      expect(res.json.error).toEqual({
        code: 'staff_marked',
        message: '前台已登记这节课的签到，如需修改请联系前台',
      })
    }
    const seen = await h.call('GET', `/coach/lessons/${bookingId}`, undefined, coachToken)
    expect(seen.json).toMatchObject({
      attendance: 'attended',
      attendanceBy: 'staff',
      canMarkAttendance: false,
    })
    expect((await list())[0].markedBy).toEqual({ kind: 'staff', name: '管理员' })

    // Once the desk clears it, the coach marks it.
    expect((await mark(null)).status).toBe(204)
    await h.call(
      'PUT',
      `/coach/lessons/${bookingId}/attendance`,
      { attendance: 'no_show' },
      coachToken,
    )
    expect((await list())[0]).toMatchObject({
      attendance: 'no_show',
      markedBy: { kind: 'coach', name: null },
      canMarkAbsent: true,
    })

    expect((await mark(null)).status).toBe(204)
    expect(row(h, bookingId)).toMatchObject({
      attendance: null,
      attendanceAt: null,
      attendanceBy: null,
      attendanceStaffId: null,
    })
  })

  it('takes over a student check-in when the desk marks 到课', async () => {
    const h = setup()
    const { coachToken, student, bookingId } = await lesson(h)
    h.clock.now = new Date('2026-10-26T01:40:00Z')
    const admin = await h.admin()
    const logged = () =>
      h.db.select().from(actionLog).where(eq(actionLog.action, 'booking.attendance')).all()
    expect((await h.call('POST', '/check-in', { code: CODE }, student)).status).toBe(200)
    expect(row(h, bookingId)).toMatchObject({ attendanceBy: 'student', attendanceStaffId: null })
    h.clock.now = new Date('2026-10-26T01:50:00Z')
    const mark = () =>
      h.call('PUT', `/admin/bookings/${bookingId}/attendance`, { attendance: 'attended' }, admin)
    expect((await mark()).status).toBe(204)
    // The desk's mark now, kept from when the student scanned.
    expect(row(h, bookingId)).toMatchObject({
      attendance: 'attended',
      attendanceAt: new Date('2026-10-26T01:40:00Z'),
      attendanceBy: 'staff',
      attendanceStaffId: expect.any(Number),
    })
    expect(logged()).toHaveLength(1)
    // A repeat writes and logs nothing more.
    expect((await mark()).status).toBe(204)
    expect(logged()).toHaveLength(1)
    // So the coach can no longer turn it into 缺席.
    h.clock.now = new Date('2026-10-26T02:05:00Z')
    const res = await h.call(
      'PUT',
      `/coach/lessons/${bookingId}/attendance`,
      { attendance: 'no_show' },
      coachToken,
    )
    expect(res.json.error.code).toBe('staff_marked')
    expect(row(h, bookingId)?.attendance).toBe('attended')
  })

  it('drops the whole mark when the venue cancels mid-lesson', async () => {
    const h = setup()
    const { bookingId } = await lesson(h)
    h.clock.now = new Date('2026-10-26T02:05:00Z')
    const admin = await h.admin()
    const mark = { attendance: 'attended' }
    const put = `/admin/bookings/${bookingId}/attendance`
    expect((await h.call('PUT', put, mark, admin)).status).toBe(204)
    const cancel = `/admin/bookings/${bookingId}/cancel`
    expect((await h.call('POST', cancel, { reason: '停电' }, admin)).status).toBe(200)
    expect(row(h, bookingId)).toMatchObject({
      status: 'cancelled',
      attendance: null,
      attendanceAt: null,
      attendanceBy: null,
      attendanceStaffId: null,
    })
  })

  it('still answers a repeated venue cancel once its kept answer was dropped', async () => {
    const h = setup()
    const { bookingId } = await lesson(h)
    const admin = await h.admin()
    const cancel = () =>
      h.call('POST', `/admin/bookings/${bookingId}/cancel`, { reason: '停电' }, admin, {
        'Idempotency-Key': 'once',
      })
    expect((await cancel()).status).toBe(200)
    // As a student erasing their account leaves the answers kept for staff.
    h.db.update(idempotencyKeys).set({ body: null, contentType: null }).run()
    const again = await cancel()
    expect([again.status, again.json]).toEqual([200, {}])
  })

  it('stops coach marks when the venue turns 教练点名 off', async () => {
    const h = setup()
    const { coachToken, bookingId } = await lesson(h)
    h.clock.now = new Date('2026-10-26T02:05:00Z')
    h.settings((s) => {
      s.attendance.coachMarks = false
    })
    const detail = await h.call('GET', `/coach/lessons/${bookingId}`, undefined, coachToken)
    expect(detail.json.canMarkAttendance).toBe(false)
    const res = await h.call(
      'PUT',
      `/coach/lessons/${bookingId}/attendance`,
      { attendance: 'attended' },
      coachToken,
    )
    expect(res.status).toBe(403)
    expect(res.json.error.code).toBe('coach_marks_off')
  })
})

describe('who may use the 签到 list', () => {
  it('lets 前台 mark attendance but not 财务', async () => {
    const h = setup()
    const { bookingId } = await lesson(h)
    h.clock.now = new Date('2026-10-26T01:40:00Z')
    const admin = await h.admin()
    for (const [username, roles] of [
      ['desk', ['front_desk']],
      ['money', ['finance']],
    ] as const) {
      const res = await h.call(
        'POST',
        '/admin/staff',
        { name: username, username, password: 'staff-pass-1', roles },
        admin,
      )
      expect(res.status).toBe(201)
    }
    const desk = await h.admin('desk', 'staff-pass-1')
    const money = await h.admin('money', 'staff-pass-1')
    expect((await h.call('GET', '/admin/front-desk', undefined, money)).status).toBe(403)
    const refused = await h.call(
      'PUT',
      `/admin/bookings/${bookingId}/attendance`,
      { attendance: 'attended' },
      money,
    )
    expect(refused.status).toBe(403)
    const marked = await h.call(
      'PUT',
      `/admin/bookings/${bookingId}/attendance`,
      { attendance: 'attended' },
      desk,
    )
    expect(marked.status).toBe(204)
    const list = (await h.call('GET', '/admin/front-desk', undefined, desk)).json
    expect(list[0].markedBy).toEqual({ kind: 'staff', name: 'desk' })
    expect((await h.call('PUT', '/admin/settings', {}, desk)).status).toBe(403)
    // The 签到码 dialog: what it prints and whether students can scan it, without the settings.
    const code = await h.call('GET', '/admin/check-in-code', undefined, desk)
    expect(code.json).toEqual({ venueName: expect.any(String), selfCheckIn: true })
    h.settings((s) => {
      s.attendance.selfCheckIn = false
    })
    expect((await h.call('GET', '/admin/check-in-code', undefined, desk)).json.selfCheckIn).toBe(
      false,
    )
    expect((await h.call('GET', '/admin/check-in-code', undefined, money)).status).toBe(403)
  })
})
