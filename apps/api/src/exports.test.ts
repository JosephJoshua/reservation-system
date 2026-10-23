import { describe, expect, it } from 'vitest'
import { actionLog, packageProducts, students } from './db/schema'
import { type Harness, setup } from './test/harness'

async function csv(h: Harness, path: string, token: string) {
  const res = await h.app.request(`/api/admin/exports/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  // Keep the BOM, which text() would drop.
  const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await res.arrayBuffer())
  return { status: res.status, text, headers: res.headers }
}

const lines = (text: string) => text.replace(/^﻿/, '').trimEnd().split('\r\n')

/** A student, booked by the front desk for tomorrow 10:00 and paid ¥200.5 in cash. */
async function booked(h: Harness, name = '林小雨') {
  const { coach, lesson } = h.seed()
  const admin = await h.admin()
  const t = await h.student('a')
  await h.call('PUT', '/me', { name, phone: '13800001111' }, t)
  const slot = h.slot(coach.id)
  const res = await h.call(
    'POST',
    '/admin/bookings',
    {
      studentId: 1,
      slotId: slot.id,
      lessonTypeId: lesson.id,
      payWith: 'offline',
      amount: 20050,
      method: 'cash',
    },
    admin,
  )
  expect(res.status).toBe(201)
  return { admin, t, coach, lesson, slot }
}

describe('CSV exports', () => {
  it('writes bookings with a BOM, venue times and yuan, and logs the export', async () => {
    const h = setup()
    const { admin, slot } = await booked(h)
    const res = await csv(h, 'bookings?from=2026-10-23&to=2026-10-31', admin)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8')
    expect(res.headers.get('Content-Disposition')).toContain(
      `filename*=UTF-8''${encodeURIComponent('预约-2026-10-23-2026-10-31.csv')}`,
    )
    expect(res.text.startsWith('﻿')).toBe(true)
    const [header, row] = lines(res.text)
    expect(header?.split(',').slice(0, 10)).toEqual([
      '预约ID',
      '上课时间',
      '下课时间',
      '教练',
      '课程',
      '学员',
      '手机号',
      '状态',
      '支付',
      '金额（元）',
    ])
    const start = new Date(slot.startsAt.getTime() + 8 * 3_600_000).toISOString()
    expect(row?.split(',').slice(0, 12)).toEqual([
      '1',
      `${start.slice(0, 10)} ${start.slice(11, 16)}`,
      expect.any(String),
      '王教练',
      '一对一私教',
      '林小雨',
      '13800001111',
      '已预约',
      '线下（现金）',
      '200.50',
      '',
      '管理员',
    ])
    const entry = h.db.select().from(actionLog).all().at(-1)
    expect(entry).toMatchObject({
      action: 'data.export',
      summary: '导出预约（2026-10-23 至 2026-10-31），1 行',
      studentId: null,
    })
  })

  it('applies the page filters and names them in the log', async () => {
    const h = setup()
    const { admin, coach } = await booked(h)
    const cancelled = await csv(
      h,
      `bookings?from=2026-10-23&to=2026-10-31&status=cancelled&coachId=${coach.id}`,
      admin,
    )
    expect(lines(cancelled.text)).toHaveLength(1)
    const outside = await csv(h, 'bookings?from=2026-11-01&to=2026-11-30', admin)
    expect(lines(outside.text)).toHaveLength(1)
    expect(h.db.select().from(actionLog).all().at(-2)?.summary).toBe(
      '导出预约（2026-10-23 至 2026-10-31，状态：已取消，教练：王教练），0 行',
    )
    const search = await csv(h, 'students?from=2026-10-01&to=2026-10-31&q=1380000', admin)
    expect(lines(search.text)).toHaveLength(2)
    // The search text can be a name or phone, so the log only says a search was used.
    expect(h.db.select().from(actionLog).all().at(-1)?.summary).toBe(
      '导出学员（2026-10-01 至 2026-10-31，按搜索词筛选），1 行',
    )
  })

  it('quotes commas and quotes, and keeps spreadsheets from running typed formulas', async () => {
    const h = setup()
    const { admin } = await booked(h, '=HYPERLINK("x"),1')
    const res = await csv(h, 'students?from=2026-10-01&to=2026-10-31', admin)
    expect(lines(res.text)[1]).toContain(`"'=HYPERLINK(""x""),1"`)
  })

  it('shows a deleted student without their name or phone', async () => {
    const h = setup()
    const { admin } = await booked(h)
    h.db
      .update(students)
      .set({ name: '', phone: '', deletedAt: new Date('2026-10-23T03:00:00Z') })
      .run()
    const res = await csv(h, 'orders?from=2026-10-01&to=2026-10-31', admin)
    const row = lines(res.text)[1]?.split(',') ?? []
    expect(row.slice(4, 6)).toEqual(['已注销学员', ''])
    expect(res.text).not.toContain('林小雨')
    const people = await csv(h, 'students?from=2026-10-01&to=2026-10-31', admin)
    expect(lines(people.text)[1]?.split(',').slice(1, 3)).toEqual(['已注销学员', ''])
  })

  it('exports every kind with its header', async () => {
    const h = setup()
    const { admin, lesson } = await booked(h)
    const p = h.db
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
      { studentId: 1, productId: p.id, amount: 180000, method: 'alipay' },
      admin,
    )
    const firsts = {
      students: '学员ID',
      bookings: '预约ID',
      orders: '订单ID',
      refunds: '退款ID',
      packages: '课时包ID',
      invoices: '申请ID',
    }
    for (const [kind, first] of Object.entries(firsts)) {
      const res = await csv(h, `${kind}?from=2026-10-01&to=2026-10-31`, admin)
      expect(res.status).toBe(200)
      expect(lines(res.text)[0]?.split(',')[0]).toBe(first)
    }
    const pkgs = await csv(h, 'packages?from=2026-10-01&to=2026-10-31&status=active', admin)
    expect(lines(pkgs.text)[1]?.split(',').slice(7, 12)).toEqual([
      '10',
      '0',
      '10',
      '1800.00',
      '使用中',
    ])
    const orders = await csv(h, 'orders?from=2026-10-01&to=2026-10-31&status=paid', admin)
    expect(lines(orders.text)).toHaveLength(3)
  })

  it('refuses bad ranges, kinds and filters', async () => {
    const h = setup()
    const admin = await h.admin()
    const tries = [
      ['bookings?from=2026-10-31&to=2026-10-01', '结束日期不能早于开始日期'],
      ['bookings?from=2025-01-01&to=2026-10-31', '一次最多导出一年'],
      ['bookings?from=2026-02-30&to=2026-03-01', '请选择正确的日期'],
    ] as const
    for (const [path, message] of tries) {
      const res = await csv(h, path, admin)
      expect(res.status).toBe(400)
      expect(JSON.parse(res.text).error.message).toBe(message)
    }
    expect((await csv(h, 'secrets?from=2026-10-01&to=2026-10-31', admin)).status).toBe(404)
    expect((await csv(h, 'students?from=2026-10-01&to=2026-10-31&status=paid', admin)).status).toBe(
      400,
    )
    expect((await csv(h, 'bookings?from=2026-10-01&to=2026-10-31', '')).status).toBe(401)
    expect(h.db.select().from(actionLog).all()).toEqual([])
  })
})
