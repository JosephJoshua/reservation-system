import { existsSync, readdirSync } from 'node:fs'
import { POLICY_VERSION } from '@rs/shared'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { actionLog, invoices, packageProducts, packages, students } from './db/schema'
import { invoicesDir } from './services/invoices'
import { type Harness, setup } from './test/harness'

const PDF = new TextEncoder().encode('%PDF-1.7\n% test invoice\n')
const person = { kind: 'personal', name: '林小雨', taxNumber: '', email: 'lin@example.com' }
const company = {
  kind: 'company',
  name: '某某科技有限公司',
  taxNumber: '91110108MA01ABCD2X',
  email: 'finance@example.com',
}

function product(h: Harness, lessonTypeId: number) {
  return h.db
    .insert(packageProducts)
    .values({ name: '10 次课', lessonTypeId, lessonCount: 10, price: 180000, validityDays: 90 })
    .returning()
    .get()
}

/** A student who paid ¥1800 for a package through WeChat Pay. */
async function paidPackage(h: Harness, name = 'a') {
  const { lesson, coach } = h.seed()
  const t = await h.student(name)
  const p = product(h, lesson.id)
  const res = await h.call('POST', '/packages/purchase', { productId: p.id }, t)
  await h.call('POST', `/dev/fake-pay/${res.json.orderId}`)
  return { t, lesson, coach, orderId: res.json.orderId as number }
}

async function upload(
  h: Harness,
  id: number,
  token: string,
  bytes: Uint8Array = PDF,
  key?: string,
) {
  const form = new FormData()
  form.append('file', new File([bytes], 'invoice.pdf', { type: 'application/pdf' }))
  const res = await h.app.request(`/api/admin/invoices/${id}/issue`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, ...(key ? { 'Idempotency-Key': key } : {}) },
    body: form,
  })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}

const entries = (h: Harness) => h.db.select().from(actionLog).all()

describe('invoice requests', () => {
  it('requests an invoice, remembers the title and shows the state on the package', async () => {
    const h = setup()
    const { t, orderId } = await paidPackage(h)
    const before = (await h.call('GET', '/invoices', undefined, t)).json
    expect(before).toEqual({
      orders: [
        expect.objectContaining({
          orderId,
          state: 'available',
          amount: 180000,
          description: '10 次课',
          kind: 'package',
        }),
      ],
      lastTitle: null,
    })
    const res = await h.call(
      'POST',
      '/invoices',
      { orderId, ...company, taxNumber: ' 91110108ma01abcd2x ' },
      t,
    )
    expect(res.status).toBe(201)
    expect(res.json.order).toMatchObject({ state: 'requested', invoiceId: res.json.id })
    const after = (await h.call('GET', '/invoices', undefined, t)).json
    expect(after.lastTitle).toEqual(company)
    const pkg = (await h.call('GET', '/packages', undefined, t)).json[0]
    expect(pkg.invoice).toMatchObject({ orderId, state: 'requested', amount: 180000 })
  })

  it('answers a repeated request with the same invoice and refuses a second one', async () => {
    const h = setup()
    const { t, orderId } = await paidPackage(h)
    const [a, b] = await Promise.all([
      h.call('POST', '/invoices', { orderId, ...person }, t),
      h.call('POST', '/invoices', { orderId, ...person }, t),
    ])
    expect([a.status, b.status]).toEqual([201, 201])
    expect(a.json.id).toBe(b.json.id)
    const other = await h.call('POST', '/invoices', { orderId, ...company }, t)
    expect(other.json.error.code).toBe('invoice_exists')
    expect(h.db.select().from(invoices).all()).toHaveLength(1)
  })

  it('checks the title, the tax number and the email', async () => {
    const h = setup()
    const { t, orderId } = await paidPackage(h)
    const tries = [
      [{ ...person, name: ' ' }, '请填写抬头'],
      [{ ...company, taxNumber: '' }, '请填写正确的税号'],
      [{ ...company, taxNumber: '9111010' }, '请填写正确的税号'],
      [{ ...person, email: 'lin@' }, '请填写正确的邮箱'],
      [{ ...person, name: '名'.repeat(51) }, '抬头不能超过 50 个字'],
    ] as const
    for (const [title, message] of tries) {
      const res = await h.call('POST', '/invoices', { orderId, ...title }, t)
      expect(res.status).toBe(400)
      expect(res.json.error.message).toBe(message)
    }
    // A person's title never keeps a tax number typed before switching.
    await h.call('POST', '/invoices', { orderId, ...person, taxNumber: 'X1' }, t)
    expect(h.db.select().from(invoices).get()?.taxNumber).toBe('')
  })

  it('needs the current policy agreed, since the request collects new data', async () => {
    const h = setup()
    const { t, orderId } = await paidPackage(h)
    h.db.update(students).set({ policyVersion: '2026-10-23' }).run()
    const res = await h.call('POST', '/invoices', { orderId, ...person }, t)
    expect(res.json.error.code).toBe('consent_required')
    await h.call('POST', '/me/consent', { version: POLICY_VERSION }, t)
    expect((await h.call('POST', '/invoices', { orderId, ...person }, t)).status).toBe(201)
  })

  it('refuses unpaid orders, other students orders and orders being refunded', async () => {
    const h = setup()
    const { t, orderId, lesson } = await paidPackage(h)
    const other = await h.student('b')
    expect((await h.call('POST', '/invoices', { orderId, ...person }, other)).json.error.code).toBe(
      'not_found',
    )
    const unpaid = await h.call(
      'POST',
      '/packages/purchase',
      { productId: product(h, lesson.id).id },
      other,
    )
    const res = await h.call(
      'POST',
      '/invoices',
      { orderId: unpaid.json.orderId, ...person },
      other,
    )
    expect(res.json.error.code).toBe('not_invoiceable')
    const pkg = (await h.call('GET', '/packages', undefined, t)).json[0]
    await h.call('POST', `/packages/${pkg.id}/refund-request`, undefined, t)
    const refunding = await h.call('POST', '/invoices', { orderId, ...person }, t)
    expect(refunding.json.error).toMatchObject({
      code: 'refund_open',
      message: '该订单有退款在处理，完成后再申请',
    })
  })

  it('invoices what is left after a partial refund, and refuses a fully refunded order', async () => {
    const h = setup()
    const { t, orderId } = await paidPackage(h)
    const admin = await h.admin()
    const pkg = (await h.call('GET', '/packages', undefined, t)).json[0]
    await h.call('POST', `/packages/${pkg.id}/refund-request`, undefined, t)
    const refundId = (await h.call('GET', '/admin/refunds', undefined, admin)).json[0].id
    await h.call('POST', `/admin/refunds/${refundId}/approve`, { amount: 150000 }, admin)
    const list = (await h.call('GET', '/invoices', undefined, t)).json
    expect(list.orders[0]).toMatchObject({ state: 'available', amount: 30000 })
    const res = await h.call('POST', '/invoices', { orderId, ...person }, t)
    expect(h.db.select().from(invoices).where(eq(invoices.id, res.json.id)).get()?.amount).toBe(
      30000,
    )

    const h2 = setup()
    const second = await paidPackage(h2)
    const admin2 = await h2.admin()
    const pkg2 = (await h2.call('GET', '/packages', undefined, second.t)).json[0]
    await h2.call('POST', `/packages/${pkg2.id}/refund-request`, undefined, second.t)
    const refund2 = (await h2.call('GET', '/admin/refunds', undefined, admin2)).json[0].id
    await h2.call('POST', `/admin/refunds/${refund2}/approve`, { amount: 180000 }, admin2)
    const refused = await h2.call(
      'POST',
      '/invoices',
      { orderId: second.orderId, ...person },
      second.t,
    )
    expect(refused.json.error).toMatchObject({
      code: 'order_refunded',
      message: '已退款的订单不能开票',
    })
  })
})

describe('invoice queue', () => {
  it('issues with a PDF the student can open, and logs it without personal data', async () => {
    const h = setup()
    const { t, orderId } = await paidPackage(h)
    const admin = await h.admin()
    const id = (await h.call('POST', '/invoices', { orderId, ...person }, t)).json.id
    const queue = (await h.call('GET', '/admin/invoices?status=requested', undefined, admin)).json
    expect(queue).toEqual([
      expect.objectContaining({
        id,
        status: 'requested',
        title: person,
        amount: 180000,
        hasPdf: false,
        refundFlag: false,
        order: expect.objectContaining({ id: orderId, amount: 180000, refunded: 0 }),
        student: { id: 1, name: '', phone: '' },
      }),
    ])
    const notPdf = await upload(h, id, admin, new TextEncoder().encode('<html>'))
    expect(notPdf.json.error.message).toBe('请上传 PDF 格式的发票')
    expect(existsSync(invoicesDir(h.deps)) ? readdirSync(invoicesDir(h.deps)) : []).toEqual([])

    const issued = await upload(h, id, admin)
    expect(issued.status).toBe(200)
    expect(issued.json).toMatchObject({ status: 'issued', hasPdf: true })
    const pdf = await h.app.request(`/api/invoices/${id}/pdf`, {
      headers: { Authorization: `Bearer ${t}` },
    })
    expect(pdf.status).toBe(200)
    expect(pdf.headers.get('Content-Type')).toBe('application/pdf')
    expect(new Uint8Array(await pdf.arrayBuffer())).toEqual(PDF)
    const other = await h.student('b')
    const stranger = await h.app.request(`/api/invoices/${id}/pdf`, {
      headers: { Authorization: `Bearer ${other}` },
    })
    expect(stranger.status).toBe(404)
    // The file is never reachable through the public uploads path.
    const file = h.db.select().from(invoices).get()?.pdfFile ?? ''
    expect((await h.app.request(`/api/uploads/${file}`)).status).toBe(404)
    expect((await h.app.request(`/api/uploads/invoices/${file}`)).status).toBe(404)

    expect(entries(h).at(-1)).toMatchObject({
      action: 'invoice.issue',
      summary: '订单「10 次课」开票 ¥1800',
      amount: 180000,
      studentId: 1,
    })
    const pkg = (await h.call('GET', '/packages', undefined, t)).json[0]
    expect(pkg.invoice.state).toBe('issued')
  })

  it('replaces a wrong upload and removes the old file', async () => {
    const h = setup()
    const { t, orderId } = await paidPackage(h)
    const admin = await h.admin()
    const id = (await h.call('POST', '/invoices', { orderId, ...person }, t)).json.id
    await upload(h, id, admin)
    const first = h.db.select().from(invoices).get()?.pdfFile
    await upload(h, id, admin, new TextEncoder().encode('%PDF-1.7\n% fixed\n'))
    const second = h.db.select().from(invoices).get()?.pdfFile
    expect(second).not.toBe(first)
    expect(readdirSync(invoicesDir(h.deps))).toEqual([second])
    expect(entries(h).at(-1)?.summary).toBe('重新上传订单「10 次课」的发票')
  })

  it('answers a repeated upload with the same key once, though each form has its own boundary', async () => {
    const h = setup()
    const { t, orderId } = await paidPackage(h)
    const admin = await h.admin()
    const id = (await h.call('POST', '/invoices', { orderId, ...person }, t)).json.id
    const first = await upload(h, id, admin, PDF, 'k1')
    const again = await upload(h, id, admin, PDF, 'k1')
    expect(again).toEqual(first)
    expect(entries(h).filter((e) => e.action === 'invoice.issue')).toHaveLength(1)
    const other = await upload(h, id, admin, new TextEncoder().encode('%PDF-1.7\n% b\n'), 'k1')
    expect(other.status).toBe(409)
  })

  it('rejects with a reason the student sees, and takes a new request afterwards', async () => {
    const h = setup()
    const { t, orderId } = await paidPackage(h)
    const admin = await h.admin()
    const id = (await h.call('POST', '/invoices', { orderId, ...company }, t)).json.id
    for (let i = 0; i < 2; i++) {
      const res = await h.call(
        'POST',
        `/admin/invoices/${id}/reject`,
        { reason: '税号有误' },
        admin,
      )
      expect(res.json.status).toBe('rejected')
    }
    expect(entries(h).filter((e) => e.action === 'invoice.reject')).toHaveLength(1)
    const list = (await h.call('GET', '/invoices', undefined, t)).json
    expect(list.orders[0]).toMatchObject({ state: 'rejected', rejectReason: '税号有误' })
    expect((await upload(h, id, admin)).json.error.code).toBe('invoice_handled')
    const again = await h.call('POST', '/invoices', { orderId, ...person }, t)
    expect(again.status).toBe(201)
    expect(again.json.id).not.toBe(id)
  })

  it('flags a refund after the invoice until staff mark it handled', async () => {
    const h = setup()
    const { lesson } = h.seed()
    const admin = await h.admin()
    const t = await h.student('a')
    const slot = h.slot(1)
    const booked = await h.call(
      'POST',
      '/bookings',
      { slotId: slot.id, lessonTypeId: lesson.id, payWith: 'wechat' },
      t,
    )
    await h.call('POST', `/dev/fake-pay/${booked.json.orderId}`)
    const id = (await h.call('POST', '/invoices', { orderId: booked.json.orderId, ...person }, t))
      .json.id
    await upload(h, id, admin)
    await h.call('POST', `/bookings/${booked.json.bookingId}/cancel`, {}, t)

    const flagged = (await h.call('GET', '/admin/invoices?flagged=1', undefined, admin)).json
    expect(flagged).toEqual([expect.objectContaining({ id, refundFlag: true })])
    expect(flagged[0].order.refunded).toBe(20000)
    const refundsList = (await h.call('GET', '/admin/refunds', undefined, admin)).json
    expect(refundsList[0].invoiceStatus).toBe('issued')

    for (let i = 0; i < 2; i++) {
      await h.call('POST', `/admin/invoices/${id}/refund-seen`, undefined, admin)
    }
    expect((await h.call('GET', '/admin/invoices?flagged=1', undefined, admin)).json).toEqual([])
    expect(entries(h).filter((e) => e.action === 'invoice.refund_seen')).toHaveLength(1)
    // The student still sees the invoice they were given.
    const list = (await h.call('GET', '/invoices', undefined, t)).json
    expect(list.orders[0].state).toBe('issued')
  })

  it('flags a refund that comes after a seen one was rejected', async () => {
    const h = setup()
    const { t, orderId } = await paidPackage(h)
    const admin = await h.admin()
    const id = (await h.call('POST', '/invoices', { orderId, ...person }, t)).json.id
    await upload(h, id, admin)
    const pkg = (await h.call('GET', '/packages', undefined, t)).json[0]
    const flaggedNow = async () =>
      (await h.call('GET', '/admin/invoices?flagged=1', undefined, admin)).json.length
    await h.call('POST', `/packages/${pkg.id}/refund-request`, undefined, t)
    expect(await flaggedNow()).toBe(1)
    await h.call('POST', `/admin/invoices/${id}/refund-seen`, undefined, admin)
    const refund = (await h.call('GET', '/admin/refunds', undefined, admin)).json[0]
    await h.call('POST', `/admin/refunds/${refund.id}/reject`, { note: '不符合' }, admin)
    expect(await flaggedNow()).toBe(0)
    await h.call('POST', `/packages/${pkg.id}/refund-request`, undefined, t)
    expect(await flaggedNow()).toBe(1)
  })

  it('shows what is left to invoice once an order with a rejected request is refunded', async () => {
    const h = setup()
    const { t, orderId } = await paidPackage(h)
    const admin = await h.admin()
    const id = (await h.call('POST', '/invoices', { orderId, ...person }, t)).json.id
    await h.call('POST', `/admin/invoices/${id}/reject`, { reason: '请改用单位抬头' }, admin)
    const pkg = (await h.call('GET', '/packages', undefined, t)).json[0]
    await h.call('POST', `/packages/${pkg.id}/refund-request`, undefined, t)
    const refund = (await h.call('GET', '/admin/refunds', undefined, admin)).json[0]
    await h.call('POST', `/admin/refunds/${refund.id}/approve`, { amount: 180000 }, admin)
    const order = (await h.call('GET', '/invoices', undefined, t)).json.orders[0]
    expect(order).toMatchObject({ state: expect.stringMatching(/^refund(ing|ed)$/), amount: 0 })
  })

  it('will not issue for an order that was fully refunded after the request', async () => {
    const h = setup()
    const { lesson } = h.seed()
    const admin = await h.admin()
    const t = await h.student('a')
    const slot = h.slot(1)
    const booked = await h.call(
      'POST',
      '/bookings',
      { slotId: slot.id, lessonTypeId: lesson.id, payWith: 'wechat' },
      t,
    )
    await h.call('POST', `/dev/fake-pay/${booked.json.orderId}`)
    const id = (await h.call('POST', '/invoices', { orderId: booked.json.orderId, ...person }, t))
      .json.id
    await h.call(
      'POST',
      `/admin/bookings/${booked.json.bookingId}/cancel`,
      { reason: '停电' },
      admin,
    )
    const queue = (await h.call('GET', '/admin/invoices?status=requested', undefined, admin)).json
    expect(queue[0]).toMatchObject({ refundFlag: true, order: { refunded: 20000 } })
    const res = await upload(h, id, admin)
    expect(res.json.error.code).toBe('order_refunded')
    expect(readdirSync(invoicesDir(h.deps))).toEqual([])
  })
})

describe('invoices and account deletion', () => {
  it('waits for a pending request, then clears the email, personal titles and their files', async () => {
    const h = setup()
    const { t, orderId, lesson } = await paidPackage(h)
    const admin = await h.admin()
    const id = (await h.call('POST', '/invoices', { orderId, ...person }, t)).json.id
    const blocked = (await h.call('GET', '/me/deletion', undefined, t)).json
    expect(blocked.blockers).toContain('发票申请正在处理，请完成后再注销')
    await upload(h, id, admin)

    // A second, company invoice on another order keeps its title.
    const offline = await h.call(
      'POST',
      '/admin/packages/offline-sale',
      { studentId: 1, productId: product(h, lesson.id).id, amount: 1000, method: 'cash' },
      admin,
    )
    const orderIds = (await h.call('GET', '/invoices', undefined, t)).json.orders.map(
      (o: { orderId: number }) => o.orderId,
    )
    const companyOrder = orderIds.find((o: number) => o !== orderId)
    const companyId = (await h.call('POST', '/invoices', { orderId: companyOrder, ...company }, t))
      .json.id
    await upload(h, companyId, admin)
    expect(offline.status).toBe(201)

    // Use up both packages so nothing blocks the deletion.
    h.db.update(packages).set({ lessonsRemaining: 0 }).run()
    const personalFile = h.db.select().from(invoices).where(eq(invoices.id, id)).get()?.pdfFile
    expect((await h.call('DELETE', '/me', undefined, t)).status).toBe(204)

    const rows = h.db.select().from(invoices).all()
    expect(rows.map((r) => [r.titleKind, r.title, r.email, r.pdfFile !== null])).toEqual([
      ['personal', '', '', false],
      ['company', '某某科技有限公司', '', true],
    ])
    expect(existsSync(`${invoicesDir(h.deps)}/${personalFile}`)).toBe(false)
    expect(h.db.select().from(students).get()?.invoiceTitle).toBeNull()
    const queue = (await h.call('GET', '/admin/invoices', undefined, admin)).json
    expect(queue.map((q: { student: { name: string } }) => q.student.name)).toEqual([
      '已注销学员',
      '已注销学员',
    ])
  })
})
