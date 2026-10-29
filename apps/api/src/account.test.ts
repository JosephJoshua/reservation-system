import { POLICY_VERSION } from '@rs/shared'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
  bookings,
  idempotencyKeys,
  orders,
  packageProducts,
  packages,
  sessions,
  students,
} from './db/schema'
import { type Harness, setup } from './test/harness'

async function pay(h: Harness, orderId: number) {
  return h.fakePay(orderId)
}

function product(h: Harness, lessonTypeId: number, lessonCount = 2) {
  return h.db
    .insert(packageProducts)
    .values({ name: '2 次课', lessonTypeId, lessonCount, price: 36000, validityDays: 30 })
    .returning()
    .get()
}

describe('policy consent', () => {
  it('is needed before saving contact details, booking or buying', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const slot = h.slot(coach.id)
    const p = product(h, lesson.id)
    const t = await h.student('a', { agreed: false })
    expect((await h.call('GET', '/me', undefined, t)).json.agreedPolicies).toBe(false)

    const blocked = [
      await h.call('PUT', '/me', { name: '张三', phone: '13800000000' }, t),
      await h.call('POST', '/bookings', { slotId: slot.id, lessonTypeId: lesson.id }, t),
      await h.call('POST', '/packages/purchase', { productId: p.id }, t),
    ]
    for (const res of blocked) {
      expect(res.status).toBe(403)
      expect(res.json.error.code).toBe('consent_required')
    }
    expect(h.db.select().from(bookings).all()).toHaveLength(0)
    expect(h.db.select().from(orders).all()).toHaveLength(0)

    expect((await h.call('POST', '/me/consent', { version: POLICY_VERSION }, t)).status).toBe(204)
    expect((await h.call('GET', '/me', undefined, t)).json.agreedPolicies).toBe(true)
    expect((await h.call('PUT', '/me', { name: '张三' }, t)).status).toBe(200)
    expect(
      (await h.call('POST', '/bookings', { slotId: slot.id, lessonTypeId: lesson.id }, t)).status,
    ).toBe(201)
    const row = h.db.select().from(students).get()
    expect(row?.policyVersion).toBe(POLICY_VERSION)
    expect(row?.policyAgreedAt).toEqual(h.deps.now())
  })

  it('refuses consent to a text older than the one in force', async () => {
    const h = setup()
    const t = await h.student('a', { agreed: false })
    const res = await h.call('POST', '/me/consent', { version: '2020-01-01' }, t)
    expect(res.json.error.code).toBe('policy_changed')
    expect((await h.call('GET', '/me', undefined, t)).json.agreedPolicies).toBe(false)
  })

  it('asks again after the policies change', async () => {
    const h = setup()
    const t = await h.student('a')
    h.db.update(students).set({ policyVersion: '2020-01-01' }).run()
    expect((await h.call('GET', '/me', undefined, t)).json.agreedPolicies).toBe(false)
    expect((await h.call('PUT', '/me', { name: '张三' }, t)).json.error.code).toBe(
      'consent_required',
    )
  })

  it('serves the policies without a login, filled in from settings', async () => {
    const h = setup()
    h.settings((s) => {
      s.venue.name = '飞羽乒乓球馆'
      s.legal.operator = '北京飞羽体育有限公司'
      s.legal.contact = 'service@example.com'
    })
    const res = await h.call('GET', '/policies')
    expect(res.status).toBe(200)
    expect(res.json.version).toBe(POLICY_VERSION)
    expect(res.json.privacy).toContain('北京飞羽体育有限公司（以下简称“我们”）')
    expect(res.json.privacy).toContain('联系方式：service@example.com')
    // No agreement written in settings, so the built-in one is used.
    expect(res.json.agreement).toContain('北京飞羽体育有限公司（以下简称“场馆”）')

    h.settings((s) => {
      s.policies.agreement = '场馆自己的协议'
    })
    const t = await h.student('a')
    const catalog = await h.call('GET', '/catalog', undefined, t)
    expect(catalog.json.policies).toMatchObject({
      agreement: '场馆自己的协议',
      version: POLICY_VERSION,
    })
    // Without an operator, the venue name and phone stand in.
    expect(catalog.json.policies.privacy).toContain('Lumi乒乓（以下简称“我们”）')
    expect(catalog.json.policies.privacy).toContain('联系方式：场馆前台')
  })
})

describe('account deletion', () => {
  async function deletion(h: Harness, t: string) {
    return (await h.call('GET', '/me/deletion', undefined, t)).json.blockers as string[]
  }

  it('clears personal data, keeps the records and starts afresh on the next login', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const t = await h.student('a')
    // Kept for repeats of the request, with their name and phone in it.
    const saved = await h.call('PUT', '/me', { name: '张三', phone: '13800000000' }, t, {
      'Idempotency-Key': 'k1',
    })
    expect(saved.status).toBe(200)
    const kept = () =>
      h.db
        .select()
        .from(idempotencyKeys)
        .all()
        .map((k) => k.body ?? '')
    expect(kept().some((b) => b.includes('13800000000'))).toBe(true)
    const admin = await h.admin()
    await h.call(
      'POST',
      '/admin/lesson-types',
      { name: '团课', durationMinutes: 60, price: 1 },
      admin,
      {
        'Idempotency-Key': 'k2',
      },
    )
    const booked = await h.call(
      'POST',
      '/bookings',
      { slotId: h.slot(coach.id, '2026-10-23', 14).id, lessonTypeId: lesson.id },
      t,
    )
    await pay(h, booked.json.orderId)
    h.db.update(bookings).set({ coachNote: '反手需要加强' }).run()
    h.clock.now = new Date('2026-10-23T08:00:00Z') // after the lesson

    expect(await deletion(h, t)).toEqual([])
    const key = { 'Idempotency-Key': 'delete-1' }
    expect((await h.call('DELETE', '/me', undefined, t, key)).status).toBe(204)
    // A repeat after a lost answer finds the session gone, which the mini program reads as done.
    expect((await h.call('DELETE', '/me', undefined, t, key)).status).toBe(401)
    // Logged outside the database, for redoing it after a restore.
    expect(h.logs).toContainEqual({ message: 'account erased', detail: { studentId: 1 } })

    const row = h.db.select().from(students).where(eq(students.id, 1)).get()
    expect(row).toMatchObject({ name: '', phone: '', policyVersion: null, deletedAt: h.deps.now() })
    expect(row?.openid).toMatch(/^deleted:1:[0-9a-f]{64}$/)
    expect(h.db.select().from(sessions).where(eq(sessions.studentId, 1)).all()).toHaveLength(0)
    // Their kept responses go too. Staff's that do not show the student stay as they were.
    expect(kept().some((b) => b.includes('13800000000'))).toBe(false)
    expect(h.db.select().from(idempotencyKeys).all()).toMatchObject([
      { studentId: null, status: 201, body: expect.stringContaining('团课') },
    ])
    // The lesson and its payment stay for the accounts, without the coach's note.
    expect(h.db.select().from(bookings).get()).toMatchObject({ studentId: 1, coachNote: '' })
    expect(h.db.select().from(orders).get()).toMatchObject({ studentId: 1, status: 'paid' })

    expect((await h.call('GET', '/me', undefined, t)).status).toBe(401)
    const again = await h.student('a', { agreed: false })
    const me = (await h.call('GET', '/me', undefined, again)).json
    expect(me).toMatchObject({ id: 2, name: '', phone: '', agreedPolicies: false })
    expect((await h.call('GET', '/bookings?scope=past', undefined, again)).json).toEqual([])

    const [listed] = (await h.call('GET', '/admin/students?q=张三', undefined, admin)).json
    expect(listed).toBeUndefined()
    const detail = (await h.call('GET', '/admin/students/1', undefined, admin)).json
    expect(detail).toMatchObject({ name: '', deletedAt: expect.any(String), wechatBound: false })
    const all = (await h.call('GET', '/admin/students', undefined, admin)).json
    expect(all.find((s: { id: number }) => s.id === 1)).toMatchObject({ wechatBound: false })
    expect(all.find((s: { id: number }) => s.id === 2)).toMatchObject({ wechatBound: true })
    expect(detail.bookings).toHaveLength(1)
    const patch = await h.call('PATCH', '/admin/students/1', { name: '李四' }, admin)
    expect(patch.json.error.code).toBe('account_deleted')
  })

  it('is refused while a lesson is coming up or unpaid', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const t = await h.student('a')
    const booked = await h.call(
      'POST',
      '/bookings',
      { slotId: h.slot(coach.id).id, lessonTypeId: lesson.id },
      t,
    )
    // Unpaid: both the hold and its open order block it.
    expect(await deletion(h, t)).toEqual(['还有未上的课程，请先取消', '有未完成的支付，请稍后再试'])
    await pay(h, booked.json.orderId)
    expect(await deletion(h, t)).toEqual(['还有未上的课程，请先取消'])
    const res = await h.call('DELETE', '/me', undefined, t)
    expect(res.status).toBe(409)
    expect(res.json.error).toEqual({ code: 'account_in_use', message: '还有未上的课程，请先取消' })
    expect(h.db.select().from(students).get()?.deletedAt).toBeNull()

    // Cancelling early refunds in full, and the refund settles at once here.
    await h.call('POST', `/bookings/${booked.json.bookingId}/cancel`, undefined, t)
    expect(await deletion(h, t)).toEqual([])
  })

  it('waits for a refund that is still open', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const t = await h.student('a')
    h.gateway.refundMode = 'processing'
    const booked = await h.call(
      'POST',
      '/bookings',
      { slotId: h.slot(coach.id).id, lessonTypeId: lesson.id },
      t,
    )
    await pay(h, booked.json.orderId)
    await h.call('POST', `/bookings/${booked.json.bookingId}/cancel`, undefined, t)
    expect(await deletion(h, t)).toEqual(['有退款正在处理，请完成后再注销'])
    h.gateway.refundMode = 'fail'
    expect((await h.call('DELETE', '/me', undefined, t)).json.error.code).toBe('account_in_use')
  })

  it('is refused while a package has lessons left or its refund is under review', async () => {
    const h = setup()
    const { lesson } = h.seed()
    const p = product(h, lesson.id)
    const t = await h.student('a')
    const bought = await h.call('POST', '/packages/purchase', { productId: p.id }, t)
    await pay(h, bought.json.orderId)
    expect(await deletion(h, t)).toEqual(['课时包还有剩余课时，请先用完或申请退款'])

    const pkgId = h.db.select().from(packages).get()?.id
    await h.call('POST', `/packages/${pkgId}/refund-request`, undefined, t)
    expect(await deletion(h, t)).toEqual(['有退款正在处理，请完成后再注销'])

    let admin = await h.admin()
    const [refund] = (await h.call('GET', '/admin/refunds', undefined, admin)).json
    await h.call('POST', `/admin/refunds/${refund.id}/reject`, { note: '不予退款' }, admin)
    expect(await deletion(h, t)).toEqual(['课时包还有剩余课时，请先用完或申请退款'])

    // An expired package with lessons left is no longer owed.
    h.clock.now = new Date('2027-01-01T00:00:00Z')
    const later = await h.student('a')
    expect(await deletion(h, later)).toEqual([])
    expect((await h.call('DELETE', '/me', undefined, later)).status).toBe(204)

    // The front desk cannot hand lessons to the deleted account.
    admin = await h.admin()
    const grant = await h.call(
      'POST',
      `/admin/packages/${pkgId}/grant`,
      { lessons: 1, note: '补课' },
      admin,
    )
    expect(grant.json.error.code).toBe('account_deleted')
    const extend = await h.call('POST', `/admin/packages/${pkgId}/extend`, { days: 30 }, admin)
    expect(extend.json.error.code).toBe('account_deleted')
    const sale = await h.call(
      'POST',
      '/admin/packages/offline-sale',
      { studentId: 1, productId: p.id, amount: 36000, method: 'cash' },
      admin,
    )
    expect(sale.json.error.code).toBe('account_deleted')
  })

  it('happens once on a double tap', async () => {
    const h = setup()
    const t = await h.student('a')
    const results = await Promise.all([
      h.call('DELETE', '/me', undefined, t),
      h.call('DELETE', '/me', undefined, t),
    ])
    expect(results.map((r) => r.status).sort()).toEqual([204, 401])
    expect(h.db.select().from(students).all()).toHaveLength(1)
  })

  it('beats a booking that was already past the login check', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const t = await h.student('a')
    // The account goes between the session check and the booking transaction.
    h.db.update(students).set({ deletedAt: h.deps.now() }).run()
    const res = await h.call(
      'POST',
      '/bookings',
      { slotId: h.slot(coach.id).id, lessonTypeId: lesson.id },
      t,
    )
    expect(res.status).toBe(401)
    expect(h.db.select().from(bookings).all()).toHaveLength(0)
  })
})
