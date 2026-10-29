import { venueInstant } from '@rs/shared'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { immediate } from './db/client'
import { bookings, packageProducts, studentNotices, students } from './db/schema'
import { notifyStudents, queueStudentNotice } from './services/student-notices'
import { type Harness, setup } from './test/harness'
import type { NoticeKind, NoticeTemplate, NoticeValues, Notifier } from './wx-notify'

type Sent = { openid: string; kind: string; page: string; values: NoticeValues }

/** Records sends; every student kind has a template unless left out. */
function withNotifier(h: Harness, result: 'sent' | 'refused' | 'fail' = 'sent', missing = '') {
  const sent: Sent[] = []
  const notifier: Notifier = {
    template: (kind: NoticeKind): NoticeTemplate | undefined =>
      kind === missing ? undefined : { id: `tpl_${kind}`, fields: { thing1: 'lesson' } },
    async send(openid, template, page, values) {
      if (result === 'fail') throw new Error('offline')
      sent.push({ openid, kind: template.id.replace('tpl_student_', ''), page, values })
      return result
    },
  }
  h.deps.notifier = notifier
  return sent
}

async function book(h: Harness, token: string, slotId: number, lessonTypeId: number) {
  const res = await h.call('POST', '/bookings', { slotId, lessonTypeId }, token)
  expect(res.status).toBe(201)
  if (res.json.orderId) await h.fakePay(res.json.orderId)
  return res.json.bookingId as number
}

const notices = (h: Harness, bookingId: number) =>
  h.db
    .select()
    .from(studentNotices)
    .where(eq(studentNotices.bookingId, bookingId))
    .all()
    .map((n) => ({ kind: n.kind, result: n.result }))

describe('student notices', () => {
  it('confirms paid bookings once, not unpaid holds or other kinds', async () => {
    const h = setup()
    const sent = withNotifier(h, 'sent', 'student_feedback')
    const { coach, lesson } = h.seed()
    const student = await h.student('a')
    await h.call('PUT', '/me', { name: '小明' }, student)
    expect((await h.call('GET', '/me', undefined, student)).json.noticeTemplates).toEqual({
      booked: 'tpl_student_booked',
      cancelled: 'tpl_student_cancelled',
      reminder: 'tpl_student_reminder',
      moved: 'tpl_student_moved',
      package: 'tpl_student_package',
    })

    const hold = await h.call(
      'POST',
      '/bookings',
      { slotId: h.slot(coach.id, '2026-10-26', 9).id, lessonTypeId: lesson.id },
      student,
    )
    expect(hold.json.status).toBe('pending_payment')
    await notifyStudents(h.deps)
    expect(sent).toEqual([])

    const id = await book(h, student, h.slot(coach.id, '2026-10-26', 10).id, lesson.id)
    await notifyStudents(h.deps)
    await notifyStudents(h.deps)
    expect(sent).toEqual([
      {
        openid: 'dev_a',
        kind: 'booked',
        page: `pages/booking-detail/index?id=${id}`,
        values: {
          student: '小明',
          lesson: '一对一私教',
          time: '2026年10月26日 10:00~11:00',
          coach: '王教练',
          place: 'Lumi乒乓',
          status: '',
          reason: '',
          refund: '',
          note: '',
        },
      },
    ])
  })

  it('tells the student about venue cancellations with the refund, not their own', async () => {
    const h = setup()
    const sent = withNotifier(h)
    const { coach, lesson } = h.seed()
    const admin = await h.admin()
    const student = await h.student('a')
    const own = await book(h, student, h.slot(coach.id, '2026-10-26', 9).id, lesson.id)
    const venue = await book(h, student, h.slot(coach.id, '2026-10-26', 10).id, lesson.id)
    await notifyStudents(h.deps)
    expect(sent.map((s) => s.kind)).toEqual(['booked', 'booked'])

    expect((await h.call('POST', `/bookings/${own}/cancel`, undefined, student)).status).toBe(200)
    const cancel = await h.call(
      'POST',
      `/admin/bookings/${venue}/cancel`,
      { reason: '教练生病' },
      admin,
    )
    expect(cancel.status).toBe(204)
    await notifyStudents(h.deps)
    await notifyStudents(h.deps)
    expect(sent.slice(2)).toMatchObject([
      {
        kind: 'cancelled',
        page: `pages/booking-detail/index?id=${venue}`,
        values: {
          status: '已取消',
          reason: '教练生病',
          refund: '¥200 原路退回',
          time: '2026年10月26日 10:00~11:00',
        },
      },
    ])

    // A refund WeChat turned down is not reported as returned.
    const third = await book(h, student, h.slot(coach.id, '2026-10-27', 10).id, lesson.id)
    h.gateway.refundMode = 'fail'
    await h.call('POST', `/admin/bookings/${third}/cancel`, { reason: '场地维修' }, admin)
    await notifyStudents(h.deps)
    expect(sent.at(-1)?.values.refund).toBe('退款处理中')
  })

  it('says a front-desk payment is handed back at the venue', async () => {
    const h = setup()
    const sent = withNotifier(h)
    const { coach, lesson } = h.seed()
    const admin = await h.admin()
    const student = await h.student('a')
    const me = await h.call('GET', '/me', undefined, student)
    const booked = await h.call(
      'POST',
      '/admin/bookings',
      {
        studentId: me.json.id,
        slotId: h.slot(coach.id, '2026-10-26', 10).id,
        lessonTypeId: lesson.id,
        payWith: 'offline',
        amount: 18000,
        method: 'cash',
      },
      admin,
    )
    const id = booked.json.bookingId
    await h.call('POST', `/admin/bookings/${id}/cancel`, { reason: '教练生病' }, admin)
    await notifyStudents(h.deps)
    expect(sent.find((s) => s.kind === 'cancelled')?.values.refund).toBe('¥180 到店退还')
  })

  it('says the package lesson came back, and that an unpaid hold cost nothing', async () => {
    const h = setup()
    const sent = withNotifier(h)
    const { coach, lesson } = h.seed()
    const admin = await h.admin()
    const student = await h.student('a')
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
    const studentId = (await h.call('GET', '/me', undefined, student)).json.id
    await h.call(
      'POST',
      '/admin/packages/offline-sale',
      { studentId, productId: product.id, amount: 180000, method: 'cash' },
      admin,
    )
    const pkg = await h.call(
      'POST',
      '/bookings',
      {
        slotId: h.slot(coach.id, '2026-10-26', 10).id,
        lessonTypeId: lesson.id,
        payWith: 'package',
      },
      student,
    )
    expect(pkg.json.status).toBe('confirmed')
    const hold = await h.call(
      'POST',
      '/bookings',
      { slotId: h.slot(coach.id, '2026-10-26', 12).id, lessonTypeId: lesson.id, payWith: 'wechat' },
      student,
    )
    expect(hold.json.status).toBe('pending_payment')
    for (const id of [pkg.json.bookingId, hold.json.bookingId]) {
      await h.call('POST', `/admin/bookings/${id}/cancel`, { reason: '场地维修' }, admin)
    }
    await notifyStudents(h.deps)
    expect(sent.filter((s) => s.kind === 'cancelled').map((s) => s.values.refund)).toEqual([
      '课时已退回课时包',
      '未扣费',
    ])
  })

  it('reminds two hours before, once, unless the lesson was booked inside that window', async () => {
    const h = setup()
    const sent = withNotifier(h)
    const { coach, lesson } = h.seed()
    const student = await h.student('a')
    const id = await book(h, student, h.slot(coach.id, '2026-10-26', 10).id, lesson.id)
    await notifyStudents(h.deps)

    h.clock.now = venueInstant('2026-10-26', 7 * 60 + 59)
    await notifyStudents(h.deps)
    expect(sent.map((s) => s.kind)).toEqual(['booked'])
    h.clock.now = venueInstant('2026-10-26', 8 * 60)
    await notifyStudents(h.deps)
    await notifyStudents(h.deps)
    expect(sent.map((s) => s.kind)).toEqual(['booked', 'reminder'])
    expect(sent[1]?.values.time).toBe('2026年10月26日 10:00~11:00')

    // Booked at 8:30 for 9:00: the confirmation already carries the time.
    h.settings((s) => {
      s.booking.minNoticeMinutes = 30
    })
    h.clock.now = venueInstant('2026-10-26', 8 * 60 + 30)
    const late = await book(h, student, h.slot(coach.id, '2026-10-26', 9).id, lesson.id)
    expect(late).not.toBe(id)
    await notifyStudents(h.deps)
    h.clock.now = venueInstant('2026-10-26', 8 * 60 + 50)
    await notifyStudents(h.deps)
    expect(notices(h, late)).toEqual([{ kind: 'booked', result: 'sent' }])
  })

  it('retries every 5 minutes while WeChat is down and drops the message once the lesson starts', async () => {
    const h = setup()
    withNotifier(h, 'fail')
    const { coach, lesson } = h.seed()
    const id = await book(h, await h.student('a'), h.slot(coach.id, '2026-10-26', 10).id, lesson.id)
    const failures = () => h.logs.filter((l) => l.message === 'student notice failed').length
    await notifyStudents(h.deps)
    await notifyStudents(h.deps)
    expect(failures()).toBe(1)
    h.clock.now = new Date(h.clock.now.getTime() + 5 * 60_000)
    await notifyStudents(h.deps)
    expect(notices(h, id)).toEqual([{ kind: 'booked', result: null }])
    expect(failures()).toBe(2)
    h.clock.now = venueInstant('2026-10-26', 10 * 60)
    await notifyStudents(h.deps)
    expect(notices(h, id)).toEqual([{ kind: 'booked', result: 'skipped' }])
  })

  it('marks messages done without sending when there is no template or account', async () => {
    const h = setup()
    const sent = withNotifier(h, 'refused', 'student_booked')
    const { coach, lesson } = h.seed()
    const first = await book(
      h,
      await h.student('a'),
      h.slot(coach.id, '2026-10-26', 10).id,
      lesson.id,
    )
    await notifyStudents(h.deps)
    expect(notices(h, first)).toEqual([{ kind: 'booked', result: 'skipped' }])

    const second = await book(
      h,
      await h.student('b'),
      h.slot(coach.id, '2026-10-27', 10).id,
      lesson.id,
    )
    h.db.update(students).set({ openid: 'deleted:2:x' }).where(eq(students.openid, 'dev_b')).run()
    h.clock.now = venueInstant('2026-10-27', 8 * 60)
    await notifyStudents(h.deps)
    expect(notices(h, second)).toEqual([
      { kind: 'booked', result: 'skipped' },
      { kind: 'reminder', result: 'skipped' },
    ])
    expect(sent).toEqual([])
  })

  it('announces a moved lesson with both times and reminds again at the new time', async () => {
    const h = setup()
    const sent = withNotifier(h)
    const { coach, lesson } = h.seed()
    const student = await h.student('a')
    const id = await book(h, student, h.slot(coach.id, '2026-10-26', 10).id, lesson.id)
    h.clock.now = venueInstant('2026-10-26', 8 * 60)
    await notifyStudents(h.deps)
    expect(sent.map((s) => s.kind)).toEqual(['booked', 'reminder'])

    // What rescheduling will do: move the booking, then queue the message in one transaction.
    const old = h.db.select().from(bookings).where(eq(bookings.id, id)).get()
    if (!old) throw new Error('missing booking')
    const next = h.slot(coach.id, '2026-10-27', 10)
    immediate(h.db, (tx) => {
      tx.update(bookings)
        .set({ slotId: next.id, startsAt: next.startsAt, endsAt: next.endsAt })
        .where(eq(bookings.id, id))
        .run()
      queueStudentNotice(tx, h.deps.now(), {
        bookingId: id,
        kind: 'moved',
        was: { coachId: coach.id, startsAt: old.startsAt, endsAt: old.endsAt },
      })
    })
    await notifyStudents(h.deps)
    expect(sent[2]).toMatchObject({
      kind: 'moved',
      values: { oldTime: '2026年10月26日 10:00~11:00', time: '2026年10月27日 10:00~11:00' },
    })
    h.clock.now = venueInstant('2026-10-27', 8 * 60)
    await notifyStudents(h.deps)
    expect(sent.map((s) => s.kind)).toEqual(['booked', 'reminder', 'moved', 'reminder'])
  })
})
