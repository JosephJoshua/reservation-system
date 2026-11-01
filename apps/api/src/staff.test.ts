import { type StaffRole, venueInstant } from '@rs/shared'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
  actionLog,
  bookings,
  coaches,
  coachLessonTypes,
  orders,
  packageLedger,
  packageProducts,
  packages,
  refunds,
  sessions,
} from './db/schema'
import { venueMoment, venueSpan } from './services/action-log'
import { hashToken } from './services/ids'
import { updateStaff } from './services/staff'
import { type Harness, setup } from './test/harness'

const PASSWORD = 'front-desk-1'

async function addStaff(
  h: Harness,
  admin: string,
  username = 'xiaoli',
  name = '小李',
  roles: StaffRole[] = ['admin'],
) {
  const res = await h.call(
    'POST',
    '/admin/staff',
    { name, username, password: PASSWORD, roles },
    admin,
  )
  expect(res.status).toBe(201)
  return res.json as { id: number; username: string }
}

function product(h: Harness, lessonTypeId: number) {
  return h.db
    .insert(packageProducts)
    .values({ name: '10 次课', lessonTypeId, lessonCount: 10, price: 180000, validityDays: 90 })
    .returning()
    .get()
}

async function sellPackage(h: Harness, admin: string, studentId: number, productId: number) {
  const res = await h.call(
    'POST',
    '/admin/packages/offline-sale',
    { studentId, productId, amount: 180000, method: 'cash' },
    admin,
  )
  expect(res.status).toBe(201)
  return res.json.packageId as number
}

const log = (h: Harness) => h.db.select().from(actionLog).all()

describe('staff logins', () => {
  it('logs in by username and password, and knows who is signed in', async () => {
    const h = setup()
    const admin = await h.admin()
    await addStaff(h, admin)
    const res = await h.call('POST', '/admin/login', { username: ' XiaoLi ', password: PASSWORD })
    expect(res.status).toBe(200)
    expect(res.json.staff).toMatchObject({ name: '小李', username: 'xiaoli' })
    const me = await h.call('GET', '/admin/me', undefined, res.json.token)
    expect(me.json).toMatchObject({ name: '小李', username: 'xiaoli', active: true })
    expect(me.json.passwordHash).toBeUndefined()
  })

  it('gives one message for a wrong password and an unknown name', async () => {
    const h = setup()
    const wrong = await h.call('POST', '/admin/login', { username: 'admin', password: 'nope' })
    const unknown = await h.call('POST', '/admin/login', { username: 'ghost', password: 'nope' })
    expect(wrong.status).toBe(401)
    expect(unknown.status).toBe(401)
    expect(unknown.json.error).toEqual(wrong.json.error)
  })

  it('never stores the password itself', async () => {
    const h = setup()
    const admin = await h.admin()
    await addStaff(h, admin)
    const list = await h.call('GET', '/admin/staff', undefined, admin)
    expect(JSON.stringify(list.json)).not.toContain('scrypt')
    const row = h.db.query.staff.findFirst({ where: (s, { eq }) => eq(s.username, 'xiaoli') })
    expect(row.sync()?.passwordHash).toMatch(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/)
  })

  it('refuses taken usernames, bad usernames and short passwords', async () => {
    const h = setup()
    const admin = await h.admin()
    await addStaff(h, admin)
    const taken = await h.call(
      'POST',
      '/admin/staff',
      { name: '另一个', username: 'XIAOLI', password: PASSWORD, roles: ['admin'] },
      admin,
    )
    expect(taken.json.error.code).toBe('username_taken')
    const bad = await h.call(
      'POST',
      '/admin/staff',
      { name: '某', username: '小李', password: PASSWORD, roles: ['admin'] },
      admin,
    )
    expect(bad.status).toBe(400)
    const short = await h.call(
      'POST',
      '/admin/staff',
      { name: '某', username: 'mou', password: '1234567', roles: ['admin'] },
      admin,
    )
    expect(short.json.error.message).toBe('密码需为 8 到 100 位')
    // Eight spaces, or a password padded with them, is refused.
    for (const spaced of ['        ', ' pass-word-1', 'pass-word-1 ']) {
      const res = await h.call(
        'POST',
        '/admin/staff',
        { name: '某', username: 'mou', password: spaced, roles: ['admin'] },
        admin,
      )
      expect(res.json.error.message).toBe('密码不能以空格开头或结尾')
    }
    const noRoles = await h.call(
      'POST',
      '/admin/staff',
      { name: '某', username: 'mou', password: PASSWORD, roles: [] },
      admin,
    )
    expect(noRoles.json.error.message).toBe('请选择角色')
  })

  it('locks out a deactivated login at once and keeps it in the list', async () => {
    const h = setup()
    const admin = await h.admin()
    const li = await addStaff(h, admin)
    const token = await h.admin('xiaoli', PASSWORD)
    expect((await h.call('GET', '/admin/me', undefined, token)).status).toBe(200)
    const off = await h.call('PATCH', `/admin/staff/${li.id}`, { active: false }, admin)
    expect(off.json.active).toBe(false)
    // Refused at once, saying why, so the app does not just ask for the password again.
    const refused = await h.call('GET', '/admin/me', undefined, token)
    expect([refused.status, refused.json.error.code]).toEqual([401, 'account_disabled'])
    // Login answers as for a wrong password, so it never confirms that a password was right.
    const again = await h.call('POST', '/admin/login', { username: 'xiaoli', password: PASSWORD })
    expect([again.status, again.json.error.code]).toEqual([401, 'bad_password'])
    const guess = await h.call('POST', '/admin/login', {
      username: 'xiaoli',
      password: 'wrong-pass',
    })
    expect([guess.status, guess.json.error.code]).toEqual([401, 'bad_password'])
    await h.call('PATCH', `/admin/staff/${li.id}`, { active: true }, admin)
    // Enabled again, the old session stays ended; a new login works.
    expect(h.db.select().from(sessions).where(eq(sessions.staffId, li.id)).all()).toHaveLength(0)
    expect((await h.call('GET', '/admin/me', undefined, token)).json.error.code).toBe(
      'unauthorized',
    )
    expect((await h.admin('xiaoli', PASSWORD)).length).toBeGreaterThan(10)
  })

  it('lets a deactivated login log out of the session it still holds', async () => {
    const h = setup()
    const admin = await h.admin()
    const li = await addStaff(h, admin)
    const token = await h.admin('xiaoli', PASSWORD)
    await h.call('PATCH', `/admin/staff/${li.id}`, { active: false }, admin)
    const out = await h.call('POST', '/admin/logout', undefined, token)
    expect(out.status).toBe(204)
    expect(h.db.select().from(sessions).where(eq(sessions.staffId, li.id)).all()).toHaveLength(0)
  })

  it('counts logins of a deactivated account as failures, right password or not', async () => {
    const h = setup()
    const admin = await h.admin()
    const li = await addStaff(h, admin)
    await h.call('PATCH', `/admin/staff/${li.id}`, { active: false }, admin)
    const codes: string[] = []
    for (let i = 0; i < 11; i++) {
      const res = await h.call('POST', '/admin/login', { username: 'xiaoli', password: PASSWORD })
      codes.push(res.json.error.code)
    }
    // The right password never clears the count, so the name still backs off.
    expect(codes.slice(0, 10)).toEqual(Array(10).fill('bad_password'))
    expect(codes[10]).toBe('too_many_attempts')
  })

  it('does not let staff deactivate themselves', async () => {
    const h = setup()
    const admin = await h.admin()
    const me = (await h.call('GET', '/admin/me', undefined, admin)).json
    const res = await h.call('PATCH', `/admin/staff/${me.id}`, { active: false }, admin)
    expect(res.json.error.code).toBe('cannot_deactivate_self')
    expect(log(h)).toHaveLength(0)
  })

  it('ends other sessions when a password is reset or changed', async () => {
    const h = setup()
    const admin = await h.admin()
    const li = await addStaff(h, admin)
    const phone = await h.admin('xiaoli', PASSWORD)
    const desk = await h.admin('xiaoli', PASSWORD)

    // Changing your own password keeps this session and ends the other one.
    const wrong = await h.call(
      'PUT',
      '/admin/me/password',
      { current: 'nope', password: 'new-pass-1' },
      desk,
    )
    expect(wrong.json.error.code).toBe('bad_password')
    const changed = await h.call(
      'PUT',
      '/admin/me/password',
      { current: PASSWORD, password: 'new-pass-1' },
      desk,
    )
    expect(changed.status).toBe(204)
    expect((await h.call('GET', '/admin/me', undefined, desk)).status).toBe(200)
    expect((await h.call('GET', '/admin/me', undefined, phone)).status).toBe(401)

    // Your own password cannot be reset without the current one.
    const own = await h.call(
      'PUT',
      `/admin/staff/${li.id}/password`,
      { password: 'x-pass-12' },
      desk,
    )
    expect(own.json.error.code).toBe('own_password')

    // A reset by someone else ends all of them.
    await h.call('PUT', `/admin/staff/${li.id}/password`, { password: 'reset-pass-1' }, admin)
    expect((await h.call('GET', '/admin/me', undefined, desk)).status).toBe(401)
    expect(
      (await h.call('POST', '/admin/login', { username: 'xiaoli', password: 'new-pass-1' })).status,
    ).toBe(401)
    expect((await h.admin('xiaoli', 'reset-pass-1')).length).toBeGreaterThan(10)
    expect((await h.call('GET', '/admin/me', undefined, admin)).status).toBe(200)
  })

  it('always keeps one active 管理员', async () => {
    const h = setup()
    const admin = await h.admin()
    const li = await addStaff(h, admin)
    await h.call('PATCH', `/admin/staff/${li.id}`, { active: false }, admin)
    // As if 小李 had deactivated the admin at the same moment.
    expect(() => updateStaff(h.deps, li.id, 1, { active: false })).toThrow(
      '至少要保留一个启用的管理员',
    )
    expect((await h.call('GET', '/admin/me', undefined, admin)).status).toBe(200)
  })

  it('limits guesses at the current password', async () => {
    const h = setup()
    const admin = await h.admin()
    for (let i = 0; i < 10; i++) {
      const res = await h.call(
        'PUT',
        '/admin/me/password',
        { current: `guess${i}`, password: 'new-pass-1' },
        admin,
      )
      expect(res.status).toBe(403)
    }
    const right = await h.call(
      'PUT',
      '/admin/me/password',
      { current: 'test-password', password: 'new-pass-1' },
      admin,
    )
    expect(right.status).toBe(429)
  })

  it('refuses a session from before staff logins', async () => {
    const h = setup()
    h.db
      .insert(sessions)
      .values({ tokenHash: hashToken('old'), role: 'admin', expiresAt: new Date('2030-01-01') })
      .run()
    expect((await h.call('GET', '/admin/settings', undefined, 'old')).status).toBe(401)
  })
})

describe('action log', () => {
  it('records who did each money action, newest first', async () => {
    const h = setup()
    const { lesson } = h.seed()
    const admin = await h.admin()
    await addStaff(h, admin)
    const li = await h.admin('xiaoli', PASSWORD)
    await h.student('a')
    const p = product(h, lesson.id)
    const packageId = await sellPackage(h, li, 1, p.id)
    await h.call('POST', `/admin/packages/${packageId}/grant`, { lessons: 2, note: '补课' }, admin)
    await h.call('POST', `/admin/packages/${packageId}/extend`, { days: 7 }, li)

    const entries = (await h.call('GET', '/admin/actions', undefined, admin)).json
    expect(
      entries.map((e: { action: string; staff: { name: string } }) => [e.action, e.staff.name]),
    ).toEqual([
      ['package.extend', '小李'],
      ['package.grant', '管理员'],
      ['package.sell', '小李'],
      ['staff.create', '管理员'],
    ])
    expect(entries[2]).toMatchObject({
      summary: '售出课时包「10 次课」，现金 ¥1,800',
      amount: 180000,
      student: { id: 1 },
      targetKind: 'package',
      targetId: packageId,
      createdAt: '2026-10-23T02:00:00.000Z',
    })
    expect(entries[1].summary).toBe('课时包「10 次课」赠送 2 节：补课')
  })

  it('waits for the desk to hand back an approved offline package refund', async () => {
    const h = setup()
    const { lesson } = h.seed()
    const admin = await h.admin()
    const t = await h.student('a')
    const packageId = await sellPackage(h, admin, 1, product(h, lesson.id).id)
    await h.call('POST', `/packages/${packageId}/refund-request`, undefined, t)
    const refund = h.db.select().from(refunds).get()
    for (let i = 0; i < 2; i++) {
      const approved = await h.call(
        'POST',
        `/admin/refunds/${refund?.id}/approve`,
        { amount: 150000 },
        admin,
      )
      expect(approved.json).toEqual({ status: 'pending', failure: null })
    }
    expect(h.db.select().from(refunds).get()?.status).toBe('pending')
    const tap = { 'Idempotency-Key': 'paid-back-tap' }
    await h.call('POST', `/admin/refunds/${refund?.id}/paid-back`, undefined, admin, tap)
    await h.call('POST', `/admin/refunds/${refund?.id}/paid-back`, undefined, admin, tap)
    expect(h.db.select().from(refunds).get()?.status).toBe('succeeded')
    expect(
      log(h)
        .map((e) => e.summary)
        .slice(-2),
    ).toEqual(['同意课时包「10 次课」退款 ¥1,500', '课时包「10 次课」线下退还 ¥1,500'])
    expect(log(h).filter((e) => e.action.startsWith('refund.'))).toHaveLength(2)
  })

  it('logs a repeated rejection once', async () => {
    const h = setup()
    const { lesson } = h.seed()
    const admin = await h.admin()
    const t = await h.student('a')
    const packageId = await sellPackage(h, admin, 1, product(h, lesson.id).id)
    await h.call('POST', `/packages/${packageId}/refund-request`, undefined, t)
    const refund = h.db.select().from(refunds).get()
    for (let i = 0; i < 2; i++) {
      const res = await h.call(
        'POST',
        `/admin/refunds/${refund?.id}/reject`,
        { note: '已上课' },
        admin,
      )
      expect(res.status).toBe(204)
    }
    expect(log(h).filter((e) => e.action === 'refund.reject')).toHaveLength(1)
    // One from a stale page with another reason is refused with the reason the student sees.
    const other = await h.call(
      'POST',
      `/admin/refunds/${refund?.id}/reject`,
      { note: '请到前台办理' },
      admin,
    )
    expect(other.status).toBe(409)
    expect(other.json.error).toMatchObject({
      code: 'refund_rejected',
      message: '该申请已拒绝：已上课',
    })
    expect(h.db.select().from(refunds).get()?.failure).toBe('已上课')
    // The student sees why.
    const [pkg] = (await h.call('GET', '/packages', undefined, t)).json
    expect(pkg.refund).toMatchObject({ status: 'rejected', rejectReason: '已上课' })
  })

  it('writes nothing when the change is refused', async () => {
    const h = setup()
    const admin = await h.admin()
    const res = await h.call('POST', '/admin/packages/99/grant', { lessons: 1, note: 'x' }, admin)
    expect(res.status).toBe(409)
    expect(log(h)).toHaveLength(0)
  })

  it('keeps student names and phones out of the stored text', async () => {
    const h = setup()
    const { lesson } = h.seed()
    const admin = await h.admin()
    const t = await h.student('a')
    await h.call('PUT', '/me', { name: '王小明', phone: '13800138000' }, t)
    await sellPackage(h, admin, 1, product(h, lesson.id).id)
    await h.call('PATCH', '/admin/students/1', { name: '王明', phone: '13900139000' }, admin)
    const stored = JSON.stringify(log(h))
    expect(stored).not.toMatch(/王小明|王明|138001|139001/)
    const [entry] = (await h.call('GET', '/admin/actions?actions=student.update', undefined, admin))
      .json
    expect(entry).toMatchObject({
      summary: '修改姓名，修改手机号',
      student: { name: '王明', phone: '13900139000' },
    })
  })

  it('records price changes only when a price changed', async () => {
    const h = setup()
    const { coach, lesson, trial } = h.seed()
    const admin = await h.admin()
    const body = { name: '一对一私教', durationMinutes: 60, price: 20000 }
    await h.call(
      'PUT',
      `/admin/lesson-types/${lesson.id}`,
      { ...body, description: '新说明' },
      admin,
    )
    expect(log(h)).toHaveLength(0)
    await h.call(
      'PUT',
      `/admin/lesson-types/${lesson.id}`,
      {
        ...body,
        price: 22000,
        salePercent: 90,
        saleStartsAt: venueInstant('2026-11-01', 0).toISOString(),
        saleEndsAt: venueInstant('2026-11-08', 0).toISOString(),
      },
      admin,
    )
    // A sale ending before it starts says so, not that the dates are missing.
    const backwards = await h.call(
      'PUT',
      `/admin/lesson-types/${lesson.id}`,
      {
        ...body,
        salePercent: 90,
        saleStartsAt: venueInstant('2026-11-08', 0).toISOString(),
        saleEndsAt: venueInstant('2026-11-01', 0).toISOString(),
      },
      admin,
    )
    expect(backwards.json.error.message).toBe('结束时间要晚于开始时间')
    const undated = await h.call(
      'PUT',
      `/admin/lesson-types/${lesson.id}`,
      { ...body, salePercent: 90 },
      admin,
    )
    expect(undated.json.error.message).toBe('折扣需要设置开始和结束时间')
    const category = await h.call(
      'POST',
      '/admin/coach-categories',
      { name: '高级', prices: [{ lessonTypeId: lesson.id, price: 25000 }] },
      admin,
    )
    const coachBody = { name: coach.name, lessonTypeIds: [lesson.id, trial.id] }
    await h.call(
      'PUT',
      `/admin/coaches/${coach.id}`,
      { ...coachBody, categoryId: category.json.id },
      admin,
    )
    // Same category, other fields: no price entry.
    await h.call(
      'PUT',
      `/admin/coaches/${coach.id}`,
      { ...coachBody, categoryId: category.json.id, title: '国家一级' },
      admin,
    )
    await h.call(
      'PUT',
      `/admin/coach-categories/${category.json.id}`,
      { name: '高级', prices: [{ lessonTypeId: trial.id, price: 5000 }] },
      admin,
    )
    await h.call('PUT', `/admin/coaches/${coach.id}`, { ...coachBody, categoryId: null }, admin)
    const summaries = log(h).map((e) => [e.action, e.summary])
    expect(summaries).toEqual([
      ['price.lesson_type', '一对一私教：¥200 改为 ¥220，90%（11月1日 00:00 至 11月8日 00:00）'],
      ['price.coach', '类别「高级」：一对一私教 ¥250'],
      ['price.coach', '王教练：无类别 改为 类别「高级」'],
      ['price.coach', '类别「高级」：一对一私教 改为按课程标价；体验课 ¥50'],
      ['price.coach', '王教练：类别「高级」 改为 无类别'],
    ])
  })

  it('names the settings sections that changed', async () => {
    const h = setup()
    const admin = await h.admin()
    const settings = (await h.call('GET', '/admin/settings', undefined, admin)).json
    await h.call('PUT', '/admin/settings', settings, admin)
    expect(log(h)).toHaveLength(0)
    settings.booking.cancelDeadlineHours = 12
    settings.notice.text = '国庆休息'
    await h.call('PUT', '/admin/settings', settings, admin)
    expect(log(h).map((e) => e.summary)).toEqual(['修改默认预约规则、公告'])
  })

  it('records venue cancels with what went back', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const admin = await h.admin()
    const t = await h.student('a')
    const slot = h.slot(coach.id)
    const booked = await h.call(
      'POST',
      '/bookings',
      { slotId: slot.id, lessonTypeId: lesson.id },
      t,
    )
    await h.fakePay(booked.json.orderId)
    await h.call(
      'POST',
      `/admin/bookings/${booked.json.bookingId}/cancel`,
      { reason: '教练生病' },
      admin,
    )
    const [entry] = log(h)
    expect(entry).toMatchObject({
      action: 'booking.cancel',
      summary: '10月25日 10:00 王教练 一对一私教，原因：教练生病，退款 ¥200',
      amount: 20000,
      studentId: 1,
    })
  })

  it('filters by staff, action and time, and pages with before', async () => {
    const h = setup()
    const { lesson } = h.seed()
    const admin = await h.admin()
    const li = await addStaff(h, admin)
    const liToken = await h.admin('xiaoli', PASSWORD)
    await h.student('a')
    const packageId = await sellPackage(h, admin, 1, product(h, lesson.id).id)
    for (let i = 0; i < 60; i++) {
      h.clock.now = new Date(h.clock.now.getTime() + 60_000)
      await h.call(
        'POST',
        `/admin/packages/${packageId}/grant`,
        { lessons: 1, note: `第${i}次` },
        liToken,
      )
    }
    const first = (await h.call('GET', `/admin/actions?staffId=${li.id}`, undefined, admin)).json
    expect(first).toHaveLength(50)
    expect(first[0].summary).toContain('第59次')
    const rest = (
      await h.call(
        'GET',
        `/admin/actions?staffId=${li.id}&before=${first[49].id}`,
        undefined,
        admin,
      )
    ).json
    expect(rest).toHaveLength(10)
    expect(rest[9].summary).toContain('第0次')
    const sales = (
      await h.call('GET', '/admin/actions?actions=package.sell,staff.create', undefined, admin)
    ).json
    expect(sales.map((e: { action: string }) => e.action)).toEqual(['package.sell', 'staff.create'])
    const from = new Date(Date.parse('2026-10-23T02:00:00Z') + 30 * 60_000).toISOString()
    const late = (
      await h.call('GET', `/admin/actions?from=${encodeURIComponent(from)}`, undefined, admin)
    ).json
    expect(late).toHaveLength(31)
    expect((await h.call('GET', '/admin/actions?actions=nope', undefined, admin)).status).toBe(400)
  })
})

describe('front-desk booking', () => {
  async function ready(h: Harness) {
    const seeded = h.seed()
    const admin = await h.admin()
    const student = await h.student('a')
    const slot = h.slot(seeded.coach.id)
    return { ...seeded, admin, student, slot }
  }

  it('books a trial for a student whose own unpaid trial hold has lapsed, closing it first', async () => {
    const h = setup()
    const { coach, trial, admin, student } = await ready(h)
    const held = await h.call(
      'POST',
      '/bookings',
      { slotId: h.slot(coach.id, '2026-10-26', 10).id, lessonTypeId: trial.id },
      student,
    )
    expect(held.json.status).toBe('pending_payment')
    const target = { studentId: 1, slotId: h.slot(coach.id, '2026-10-26', 12).id }
    const body = {
      ...target,
      lessonTypeId: trial.id,
      payWith: 'offline',
      amount: 5000,
      method: 'cash',
    }
    // While it can still be paid, it is the student's trial.
    expect((await h.call('POST', '/admin/bookings', body, admin)).json.error.code).toBe(
      'trial_used',
    )
    h.clock.now = new Date(h.clock.now.getTime() + 60 * 60_000)
    const quote = await h.call(
      'POST',
      '/admin/bookings/quote',
      { ...target, lessonTypeId: trial.id },
      admin,
    )
    expect(quote.status).toBe(200)
    const booked = await h.call('POST', '/admin/bookings', body, admin)
    expect([booked.status, booked.json.error]).toEqual([201, undefined])
    const old = h.db.select().from(bookings).where(eq(bookings.id, held.json.bookingId)).get()
    expect(old?.status).toBe('expired')
    expect(h.db.select().from(orders).where(eq(orders.id, held.json.orderId)).get()?.status).toBe(
      'closed',
    )
  })

  it('books from the student package and logs it', async () => {
    const h = setup()
    const { lesson, admin, student, slot } = await ready(h)
    const packageId = await sellPackage(h, admin, 1, product(h, lesson.id).id)
    const target = { studentId: 1, slotId: slot.id, lessonTypeId: lesson.id }
    const quote = await h.call('POST', '/admin/bookings/quote', target, admin)
    expect(quote.json).toMatchObject({
      price: { price: 20000 },
      package: { id: packageId, lessonsRemaining: 10 },
    })
    const res = await h.call('POST', '/admin/bookings', { ...target, payWith: 'package' }, admin)
    expect(res.status).toBe(201)
    const booking = h.db.select().from(bookings).get()
    expect(booking).toMatchObject({
      status: 'confirmed',
      paidWith: 'package',
      packageId,
      bookedByStaffId: 1,
    })
    expect(h.db.select().from(packages).get()?.lessonsRemaining).toBe(9)
    expect(
      h.db.select().from(packageLedger).where(eq(packageLedger.kind, 'use')).get(),
    ).toMatchObject({
      bookingId: booking?.id,
      actor: 'admin',
    })
    expect(log(h).at(-1)).toMatchObject({
      action: 'booking.create',
      summary: '10月25日 10:00 王教练 一对一私教，扣课时包「10 次课」1 节',
      studentId: 1,
    })
    // The student sees it like any other booking.
    const mine = (await h.call('GET', '/bookings', undefined, student)).json
    expect(mine[0]).toMatchObject({ id: booking?.id, status: 'confirmed' })
    // Shown as booked by the desk in the admin list.
    const listed = (await h.call('GET', '/admin/bookings', undefined, admin)).json
    expect(listed[0].bookedBy).toEqual({ id: 1, name: '管理员' })
  })

  it('records an offline payment, at a price the desk may change', async () => {
    const h = setup()
    const { lesson, admin, slot } = await ready(h)
    const res = await h.call(
      'POST',
      '/admin/bookings',
      {
        studentId: 1,
        slotId: slot.id,
        lessonTypeId: lesson.id,
        payWith: 'offline',
        amount: 18000,
        method: 'wechat',
        note: '老学员优惠',
      },
      admin,
    )
    expect(res.status).toBe(201)
    expect(h.db.select().from(bookings).get()).toMatchObject({ paidWith: 'order', price: 18000 })
    expect(h.db.select().from(orders).get()).toMatchObject({
      provider: 'offline',
      offlineMethod: 'wechat',
      status: 'paid',
      amount: 18000,
      kind: 'class',
      bookingId: res.json.bookingId,
      note: '老学员优惠',
    })
    expect(log(h).at(-1)).toMatchObject({
      summary: '10月25日 10:00 王教练 一对一私教，线下收款 ¥180（标价 ¥200）',
      amount: 18000,
    })

    // The money goes back at the desk, so the refund waits until staff say it was handed back.
    await h.call(
      'POST',
      `/admin/bookings/${res.json.bookingId}/cancel`,
      { reason: '场地维修' },
      admin,
    )
    expect(h.db.select().from(refunds).get()).toMatchObject({ amount: 18000, status: 'pending' })
    expect(log(h).at(-1)?.summary).toContain('待线下退还 ¥180')
  })

  it('leaves the refund for the desk to pay back when the student cancels', async () => {
    const h = setup()
    const { lesson, admin, student, slot } = await ready(h)
    const res = await h.call(
      'POST',
      '/admin/bookings',
      {
        studentId: 1,
        slotId: slot.id,
        lessonTypeId: lesson.id,
        payWith: 'offline',
        amount: 20000,
        method: 'cash',
      },
      admin,
    )
    await h.call('POST', `/bookings/${res.json.bookingId}/cancel`, {}, student)
    const refund = h.db.select().from(refunds).get()
    expect(refund).toMatchObject({ amount: 20000, status: 'pending' })
    const tap = { 'Idempotency-Key': 'paid-back-tap' }
    const paid = await h.call(
      'POST',
      `/admin/refunds/${refund?.id}/paid-back`,
      undefined,
      admin,
      tap,
    )
    expect(paid.status).toBe(204)
    expect(h.db.select().from(refunds).get()?.status).toBe('succeeded')
    expect(log(h).at(-1)).toMatchObject({
      action: 'refund.paid_back',
      summary: '订单「一对一私教」线下退还 ¥200',
      amount: 20000,
      studentId: 1,
    })
    // A repeat of the same tap is answered like the first and logged once.
    const entries = log(h).length
    const again = await h.call(
      'POST',
      `/admin/refunds/${refund?.id}/paid-back`,
      undefined,
      admin,
      tap,
    )
    expect(again.status).toBe(204)
    expect(log(h)).toHaveLength(entries)
    // Another tab's tap, or another staff member's, may mean the money went out twice.
    await h.call(
      'POST',
      '/admin/staff',
      { name: '财务', username: 'caiwu', password: 'finance-123', roles: ['finance'] },
      admin,
    )
    const logged = log(h).length
    for (const [token, key] of [
      [admin, 'other-tab'],
      [await h.admin('caiwu', 'finance-123'), 'paid-back-tap'],
    ] as const) {
      const other = await h.call(
        'POST',
        `/admin/refunds/${refund?.id}/paid-back`,
        undefined,
        token,
        {
          'Idempotency-Key': key,
        },
      )
      expect(other.status).toBe(409)
      expect(other.json.error).toEqual({
        code: 'refund_paid_back_elsewhere',
        message: '该退款已由其他人登记退还，请核对是否重复退还',
      })
    }
    expect(log(h)).toHaveLength(logged)
  })

  it('says a venue cancel returned the package lesson', async () => {
    const h = setup()
    const { lesson, admin, slot } = await ready(h)
    await sellPackage(h, admin, 1, product(h, lesson.id).id)
    const res = await h.call(
      'POST',
      '/admin/bookings',
      { studentId: 1, slotId: slot.id, lessonTypeId: lesson.id, payWith: 'package' },
      admin,
    )
    const cancel = `/admin/bookings/${res.json.bookingId}/cancel`
    const first = await h.call('POST', cancel, { reason: '停电' }, admin)
    expect(first.json).toEqual({
      refunded: null,
      offline: false,
      lessonReturned: true,
      refundFailed: false,
    })
    expect((await h.call('POST', cancel, { reason: '停电' }, admin)).status).toBe(200)
    expect(log(h).at(-1)?.summary).toBe(
      '10月25日 10:00 王教练 一对一私教，原因：停电，退回课时 1 节',
    )
    expect(log(h).filter((e) => e.action === 'booking.cancel')).toHaveLength(1)
  })

  it('books once when the desk repeats a submit with the same key', async () => {
    const h = setup()
    const { lesson, admin, slot } = await ready(h)
    const body = {
      studentId: 1,
      slotId: slot.id,
      lessonTypeId: lesson.id,
      payWith: 'offline',
      amount: 20000,
      method: 'cash',
    }
    const send = () =>
      h.app.request('/api/admin/bookings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${admin}`,
          'Idempotency-Key': 'book-1',
        },
        body: JSON.stringify(body),
      })
    const [a, b] = await Promise.all([send(), send()])
    expect([a.status, b.status]).toEqual([201, 201])
    expect(((await a.json()) as { bookingId: number }).bookingId).toBe(
      ((await b.json()) as { bookingId: number }).bookingId,
    )
    expect(h.db.select().from(bookings).all()).toHaveLength(1)
    expect(h.db.select().from(orders).all()).toHaveLength(1)
    expect(log(h).filter((e) => e.action === 'booking.create')).toHaveLength(1)
  })

  it('books a free lesson without an order', async () => {
    const h = setup()
    const { lesson, admin, slot } = await ready(h)
    const res = await h.call(
      'POST',
      '/admin/bookings',
      { studentId: 1, slotId: slot.id, lessonTypeId: lesson.id, payWith: 'offline', amount: 0 },
      admin,
    )
    expect(res.status).toBe(201)
    expect(h.db.select().from(orders).all()).toHaveLength(0)
    expect(log(h).at(-1)?.summary).toContain('免费')
  })

  it('needs a payment method when money was taken', async () => {
    const h = setup()
    const { lesson, admin, slot } = await ready(h)
    const res = await h.call(
      'POST',
      '/admin/bookings',
      { studentId: 1, slotId: slot.id, lessonTypeId: lesson.id, payWith: 'offline', amount: 100 },
      admin,
    )
    expect(res.json.error.message).toBe('请选择收款方式')
    expect(h.db.select().from(bookings).all()).toHaveLength(0)
  })

  it('needs a payment method to sell a package at the desk', async () => {
    const h = setup()
    const { lesson, admin } = await ready(h)
    const res = await h.call(
      'POST',
      '/admin/packages/offline-sale',
      { studentId: 1, productId: product(h, lesson.id).id, amount: 180000 },
      admin,
    )
    expect(res.status).toBe(400)
    expect(res.json.error.message).toBe('请选择收款方式')
    expect(h.db.select().from(orders).all()).toHaveLength(0)
  })

  it('ignores the advance window but not a started slot', async () => {
    const h = setup()
    const { coach, lesson, admin } = await ready(h)
    h.settings((s) => {
      s.booking.advanceDays = 3
      s.booking.minNoticeMinutes = 600
    })
    const far = h.slot(coach.id, '2026-11-20')
    const soon = h.slot(coach.id, '2026-10-23', 11) // 30 minutes from now
    const past = h.slot(coach.id, '2026-10-23', 9)
    const book = (slotId: number) =>
      h.call(
        'POST',
        '/admin/bookings',
        { studentId: 1, slotId, lessonTypeId: lesson.id, payWith: 'offline', amount: 0 },
        admin,
      )
    expect((await book(far.id)).status).toBe(201)
    expect((await book(soon.id)).status).toBe(201)
    expect((await book(past.id)).json.error.code).toBe('started')
  })

  it('refuses a student who deleted their account, and keeps their name out of the log', async () => {
    const h = setup()
    const { lesson, admin, student, slot } = await ready(h)
    const target = { studentId: 1, slotId: slot.id, lessonTypeId: lesson.id }
    const first = await h.call(
      'POST',
      '/admin/bookings',
      { ...target, payWith: 'offline', amount: 0 },
      admin,
    )
    expect(first.status).toBe(201)
    await h.call(
      'POST',
      `/admin/bookings/${first.json.bookingId}/cancel`,
      { reason: '改期' },
      admin,
    )
    expect((await h.call('DELETE', '/me', undefined, student)).status).toBe(204)
    const quote = await h.call('POST', '/admin/bookings/quote', target, admin)
    expect(quote.json.error.code).toBe('account_deleted')
    const res = await h.call(
      'POST',
      '/admin/bookings',
      { ...target, payWith: 'offline', amount: 0 },
      admin,
    )
    expect(res.json.error.code).toBe('account_deleted')
    const entries = (await h.call('GET', '/admin/actions', undefined, admin)).json
    expect(entries[0].student).toEqual({ id: 1, name: '已注销学员', phone: '' })
  })

  it('refuses taken, clashing and off-排班 times unless told, and missing packages', async () => {
    const h = setup()
    const { coach, lesson, trial, admin, student, slot } = await ready(h)
    const base = { studentId: 1, lessonTypeId: lesson.id, payWith: 'offline', amount: 0 }
    const code = async (body: object) =>
      (await h.call('POST', '/admin/bookings', { ...base, ...body }, admin)).json.error?.code

    // Outside the coach's 排班: refused, unless the desk says the coach agreed.
    const outside = {
      coachId: coach.id,
      startsAt: venueInstant('2026-10-26', 15 * 60).toISOString(),
    }
    expect(await code(outside)).toBe('time_unavailable')
    // Neither a slot id and a time together, nor half a time.
    expect(await code({ ...outside, slotId: slot.id })).toBe('invalid_body')
    expect(await code({ coachId: coach.id })).toBe('invalid_body')

    await h.call('POST', '/bookings', { slotId: slot.id, lessonTypeId: lesson.id }, student)
    await h.student('b')
    expect(await code({ slotId: slot.id, studentId: 2 })).toBe('slot_taken')

    // Same student, another coach at the same time.
    const otherCoach = h.db.insert(coaches).values({ name: '李教练' }).returning().get()
    h.db.insert(coachLessonTypes).values({ coachId: otherCoach.id, lessonTypeId: lesson.id }).run()
    const other = h.slot(otherCoach.id)
    expect(await code({ slotId: other.id })).toBe('student_clash')

    // Even outside 排班, never over another lesson of the coach.
    expect(await code({ slotId: slot.id, studentId: 2, anyTime: true })).toBe('coach_busy')
    expect(
      await code({
        coachId: coach.id,
        startsAt: venueInstant('2026-10-25', 10 * 60 + 30).toISOString(),
        studentId: 2,
        anyTime: true,
      }),
    ).toBe('coach_busy')
    // An off-step time is refused even then.
    expect(
      await code({
        coachId: coach.id,
        startsAt: venueInstant('2026-10-26', 15 * 60 + 3).toISOString(),
        anyTime: true,
      }),
    ).toBe('invalid_time')

    const later = h.slot(coach.id, '2026-10-28')
    expect(await code({ slotId: later.id, payWith: 'package' })).toBe('no_package')
    // A package kept to another coach says so, on the quote and on the refusal.
    const pkgId = await sellPackage(h, admin, 1, product(h, lesson.id).id)
    h.db
      .update(packages)
      .set({ coachIds: [otherCoach.id] })
      .where(eq(packages.id, pkgId))
      .run()
    const target = { studentId: 1, slotId: later.id, lessonTypeId: lesson.id }
    const quote = await h.call('POST', '/admin/bookings/quote', target, admin)
    expect(quote.json).toMatchObject({
      package: null,
      packageNote: expect.stringContaining('只能约李教练的课'),
    })
    const refused = await h.call(
      'POST',
      '/admin/bookings',
      { ...base, ...target, payWith: 'package' },
      admin,
    )
    expect(refused.json.error.message).toBe(quote.json.packageNote)
    expect(await code({ slotId: later.id, studentId: 99 })).toBe('not_found')

    h.settings((s) => {
      s.payment.trialLimitPerStudent = 1
    })
    expect(await code({ slotId: later.id, lessonTypeId: trial.id })).toBeUndefined()
    const next = h.slot(coach.id, '2026-10-29')
    expect(await code({ slotId: next.id, lessonTypeId: trial.id })).toBe('trial_used')

    expect(await code({ ...outside, anyTime: true })).toBeUndefined()
    expect(log(h).filter((e) => e.action === 'booking.create')).toHaveLength(2)
  })

  it('gives one slot to exactly one of the desk and a student', async () => {
    const h = setup()
    const { lesson, admin, slot } = await ready(h)
    const b = await h.student('b')
    const results = await Promise.all([
      h.call(
        'POST',
        '/admin/bookings',
        { studentId: 1, slotId: slot.id, lessonTypeId: lesson.id, payWith: 'offline', amount: 0 },
        admin,
      ),
      h.call('POST', '/bookings', { slotId: slot.id, lessonTypeId: lesson.id }, b),
      h.call(
        'POST',
        '/admin/bookings',
        { studentId: 1, slotId: slot.id, lessonTypeId: lesson.id, payWith: 'offline', amount: 0 },
        admin,
      ),
    ])
    expect(results.filter((r) => r.status === 201)).toHaveLength(1)
    expect(h.db.select().from(bookings).all()).toHaveLength(1)
  })
})

describe('dates in log summaries', () => {
  it('names the year only when it is not the current venue year', () => {
    const now = new Date('2026-10-29T04:00:00Z')
    expect(venueMoment(new Date('2026-01-01T03:00:00Z'), now)).toBe('1月1日 11:00')
    expect(venueMoment(new Date('2030-01-01T03:00:00Z'), now)).toBe('2030年1月1日 11:00')
    // 2026-12-31 20:00 UTC is already 2027 at the venue.
    expect(venueMoment(new Date('2026-12-31T20:00:00Z'), now)).toBe('2027年1月1日 04:00')
    expect(venueSpan(new Date('2030-01-01T01:00:00Z'), new Date('2030-01-01T02:00:00Z'), now)).toBe(
      '2030年1月1日 09:00-10:00',
    )
  })
})
