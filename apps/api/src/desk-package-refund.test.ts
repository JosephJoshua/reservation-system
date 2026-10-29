import { versionOf } from '@rs/shared'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { actionLog, packageProducts, packages, refunds } from './db/schema'
import { monthlyReport } from './services/reports'
import { type Harness, setup } from './test/harness'

/** A desk student who bought ten lessons for ¥1500 in cash at the front desk. */
async function deskSale(h: Harness) {
  const { coach, lesson } = h.seed()
  const admin = await h.admin()
  const product = h.db
    .insert(packageProducts)
    .values({
      name: '十节课',
      lessonTypeId: lesson.id,
      lessonCount: 10,
      price: 150000,
      validityDays: 90,
    })
    .returning()
    .get()
  const student = await h.call(
    'POST',
    '/admin/students',
    { name: '前台学员', phone: '13900000009' },
    admin,
  )
  const sale = await h.call(
    'POST',
    '/admin/packages/offline-sale',
    { studentId: student.json.id, productId: product.id, amount: 150000, method: 'cash' },
    admin,
  )
  expect(sale.status).toBe(201)
  return {
    coach,
    lesson,
    admin,
    studentId: student.json.id as number,
    packageId: sale.json.packageId as number,
  }
}

async function shown(h: Harness, admin: string, studentId: number, packageId: number) {
  const detail = await h.call('GET', `/admin/students/${studentId}`, undefined, admin)
  return detail.json.packages.find((p: { id: number }) => p.id === packageId)
}

describe('refunding a package sold at the front desk', () => {
  it('ends the package, records the money handed back, and lets the student be deleted', async () => {
    const h = setup()
    const { admin, studentId, packageId } = await deskSale(h)
    expect((await h.call('DELETE', `/admin/students/${studentId}`, undefined, admin)).status).toBe(
      409,
    )
    const quote = await h.call('GET', `/admin/packages/${packageId}/desk-refund`, undefined, admin)
    expect(quote.json).toEqual({ suggested: 150000, max: 150000, lessonsRemaining: 10 })

    const pkg = await shown(h, admin, studentId, packageId)
    const send = (amount: number, key = 'r1') =>
      h.call('POST', `/admin/packages/${packageId}/desk-refund`, { amount }, admin, {
        'If-Match': versionOf(pkg),
        'Idempotency-Key': key,
      })
    const res = await send(150000)
    expect(res.status).toBe(200)
    // Repeats, with or without the same key, change nothing more.
    expect((await send(150000)).json).toEqual(res.json)
    expect((await send(150000, 'r2')).json).toEqual(res.json)

    expect(h.db.select().from(packages).get()).toMatchObject({
      status: 'refunded',
      lessonsRemaining: 0,
    })
    expect(h.db.select().from(refunds).all()).toMatchObject([
      { amount: 150000, status: 'succeeded', packageId, reason: '前台退课时包' },
    ])
    const logged = h.db.select().from(actionLog).where(eq(actionLog.action, 'package.refund')).all()
    expect(logged).toHaveLength(1)
    expect(logged[0]?.summary).toBe('课时包「十节课」前台退款 ¥1,500')
    // Counted as money back in the month, as other offline refunds are.
    const month = monthlyReport(h.deps, '2026-10')
    expect(month.revenue).toMatchObject({ refunded: 150000 })
    const csv = await (
      await h.app.request('/api/admin/exports/refunds?from=2026-10-01&to=2026-10-31', {
        headers: { Authorization: `Bearer ${admin}` },
      })
    ).text()
    expect(csv).toContain('前台退课时包')
    const [listed] = (await h.call('GET', '/admin/refunds', undefined, admin)).json
    expect(listed).toMatchObject({ package: { lessonsRemaining: 0 }, lessonsRefunded: 10 })
    expect(csv).toContain('线下（现金）')
    expect((await h.call('DELETE', `/admin/students/${studentId}`, undefined, admin)).status).toBe(
      204,
    )
  })

  it('suggests what was paid less the lessons taken, and refuses more than is left', async () => {
    const h = setup()
    const { admin, studentId, packageId, coach, lesson } = await deskSale(h)
    const slot = h.slot(coach.id, '2026-10-23', 14)
    const booked = await h.call(
      'POST',
      '/admin/bookings',
      { studentId, slotId: slot.id, lessonTypeId: lesson.id, payWith: 'package' },
      admin,
    )
    expect(booked.status).toBeLessThan(300)
    const busy = await h.call('GET', `/admin/packages/${packageId}/desk-refund`, undefined, admin)
    expect(busy.json.error.code).toBe('package_in_use')
    h.clock.now = new Date('2026-10-23T08:00:00Z') // after the lesson
    const quote = await h.call('GET', `/admin/packages/${packageId}/desk-refund`, undefined, admin)
    expect(quote.json.suggested).toBeLessThan(150000)
    expect(quote.json.lessonsRemaining).toBe(9)
    const pkg = await shown(h, admin, studentId, packageId)
    const over = await h.call(
      'POST',
      `/admin/packages/${packageId}/desk-refund`,
      { amount: 150001 },
      admin,
      { 'If-Match': versionOf(pkg) },
    )
    expect(over.json.error.code).toBe('refund_too_large')
  })

  it('needs the package as staff saw it, and the finance role', async () => {
    const h = setup()
    const { admin, studentId, packageId } = await deskSale(h)
    const pkg = await shown(h, admin, studentId, packageId)
    const bare = await h.call(
      'POST',
      `/admin/packages/${packageId}/desk-refund`,
      { amount: 100 },
      admin,
    )
    expect(bare.status).toBe(428)
    await h.call('POST', `/admin/packages/${packageId}/grant`, { lessons: 1, note: '补课' }, admin)
    const stale = await h.call(
      'POST',
      `/admin/packages/${packageId}/desk-refund`,
      { amount: 100 },
      admin,
      { 'If-Match': versionOf(pkg) },
    )
    expect(stale.json.error.code).toBe('edited_elsewhere')
    await h.call(
      'POST',
      '/admin/staff',
      { name: '前台', username: 'desk', password: 'password1', roles: ['front_desk'] },
      admin,
    )
    const desk = await h.admin('desk', 'password1')
    expect(
      (await h.call('GET', `/admin/packages/${packageId}/desk-refund`, undefined, desk)).status,
    ).toBe(403)
    expect(h.db.select().from(refunds).all()).toEqual([])
  })

  it('leaves a package bought in the mini program to the student’s request', async () => {
    const h = setup()
    const { lesson } = h.seed()
    const admin = await h.admin()
    const product = h.db
      .insert(packageProducts)
      .values({
        name: '十节课',
        lessonTypeId: lesson.id,
        lessonCount: 10,
        price: 150000,
        validityDays: 90,
      })
      .returning()
      .get()
    const t = await h.student('a')
    const bought = await h.call('POST', '/packages/purchase', { productId: product.id }, t)
    await h.fakePay(bought.json.orderId)
    const pkg = h.db.select().from(packages).get()
    const res = await h.call('GET', `/admin/packages/${pkg?.id}/desk-refund`, undefined, admin)
    expect(res.json.error.code).toBe('package_not_offline')
  })
})
