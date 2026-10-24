import { describe, expect, it } from 'vitest'
import { packageProducts } from './db/schema'
import { type Harness, setup } from './test/harness'

async function studentId(h: Harness, token: string) {
  return (await h.call('GET', '/me', undefined, token)).json.id as number
}

async function cashBooking(h: Harness, admin: string, studentId: number, slotId: number) {
  const res = await h.call(
    'POST',
    '/admin/bookings',
    { studentId, slotId, lessonTypeId: 1, payWith: 'offline', amount: 20000, method: 'cash' },
    admin,
  )
  expect(res.status).toBe(201)
  return res.json.bookingId as number
}

describe('front-desk payments seen by the student and the desk', () => {
  it('marks a cash booking and its refund as handed back at the desk, and counts it as owed', async () => {
    const h = setup()
    const { coach } = h.seed()
    const admin = await h.admin()
    const student = await h.student('a')
    const id = await cashBooking(h, admin, await studentId(h, student), h.slot(coach.id).id)

    const view = await h.call('GET', `/bookings/${id}`, undefined, student)
    expect(view.json).toMatchObject({ paidWith: 'order', price: 20000, paidOffline: true })

    // The student cancels in time: the desk owes the money back.
    const cancelled = await h.call('POST', `/bookings/${id}/cancel`, {}, student)
    expect(cancelled.json).toMatchObject({
      status: 'cancelled',
      paidOffline: true,
      refund: { amount: 20000, status: 'pending' },
    })
    expect((await h.call('GET', '/admin/summary', undefined, admin)).json.offlineRefundsOwed).toBe(
      1,
    )

    const [refund] = (await h.call('GET', '/admin/refunds?status=pending', undefined, admin)).json
    await h.call('POST', `/admin/refunds/${refund.id}/paid-back`, undefined, admin)
    expect((await h.call('GET', '/admin/summary', undefined, admin)).json.offlineRefundsOwed).toBe(
      0,
    )
  })

  it('does not count a WeChat refund on its way as owed by the desk', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const admin = await h.admin()
    const student = await h.student('a')
    h.gateway.refundMode = 'processing'
    const res = await h.call(
      'POST',
      '/bookings',
      { slotId: h.slot(coach.id).id, lessonTypeId: lesson.id },
      student,
    )
    await h.call('POST', `/dev/fake-pay/${res.json.orderId}`)
    const view = await h.call('GET', `/bookings/${res.json.bookingId}`, undefined, student)
    expect(view.json.paidOffline).toBe(false)
    await h.call(
      'POST',
      `/admin/bookings/${res.json.bookingId}/cancel`,
      { reason: '场地维修' },
      admin,
    )
    expect((await h.call('GET', '/admin/summary', undefined, admin)).json.offlineRefundsOwed).toBe(
      0,
    )
  })

  it('marks a package sold at the desk', async () => {
    const h = setup()
    const { lesson } = h.seed()
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
    await h.call(
      'POST',
      '/admin/packages/offline-sale',
      {
        studentId: await studentId(h, student),
        productId: product.id,
        amount: 180000,
        method: 'cash',
      },
      admin,
    )
    const [pkg] = (await h.call('GET', '/packages', undefined, student)).json
    expect(pkg).toMatchObject({ name: '10 次课', paidOffline: true })
  })
})

describe('a deleted student in staff lists', () => {
  it('shows as 已注销学员 in bookings, orders and refunds', async () => {
    const h = setup()
    const { coach } = h.seed()
    const admin = await h.admin()
    const student = await h.student('a')
    await h.call('PUT', '/me', { name: '小明', phone: '13800000000' }, student)
    const slot = h.slot(coach.id)
    const id = await cashBooking(h, admin, await studentId(h, student), slot.id)
    await h.call('POST', `/bookings/${id}/cancel`, {}, student)
    const [refund] = (await h.call('GET', '/admin/refunds', undefined, admin)).json
    await h.call('POST', `/admin/refunds/${refund.id}/paid-back`, undefined, admin)
    expect((await h.call('DELETE', '/me', undefined, student)).status).toBe(204)

    const gone = { name: '已注销学员', phone: '' }
    const bookings = await h.call('GET', '/admin/bookings?status=cancelled', undefined, admin)
    expect(bookings.json[0].student).toMatchObject(gone)
    const orders = await h.call('GET', '/admin/orders', undefined, admin)
    expect(orders.json[0].student).toMatchObject(gone)
    const refunds = await h.call('GET', '/admin/refunds', undefined, admin)
    expect(refunds.json[0].student).toMatchObject(gone)
  })

  it('shows as 已注销学员 on a past lesson in the schedule', async () => {
    const h = setup()
    const { coach } = h.seed()
    const admin = await h.admin()
    const student = await h.student('a')
    await h.call('PUT', '/me', { name: '小明' }, student)
    const slot = h.slot(coach.id)
    await cashBooking(h, admin, await studentId(h, student), slot.id)
    h.clock.now = new Date(slot.endsAt.getTime() + 60_000)
    expect((await h.call('DELETE', '/me', undefined, student)).status).toBe(204)
    // A new login: the first one lapsed while the clock moved on.
    const later = await h.admin()
    const range = `from=${slot.startsAt.toISOString()}&to=${slot.endsAt.toISOString()}`
    const schedule = await h.call('GET', `/admin/slots?${range}`, undefined, later)
    expect(schedule.json[0].booking.student).toMatchObject({ name: '已注销学员', phone: '' })
  })
})
