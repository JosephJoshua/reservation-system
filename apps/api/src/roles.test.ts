import { can, type StaffPermission, type StaffRole } from '@rs/shared'
import { describe, expect, it } from 'vitest'
import { actionLog, packageProducts } from './db/schema'
import { PERMISSION_CHECK } from './services/auth'
import { updateStaff } from './services/staff'
import { type Harness, setup } from './test/harness'

const PASSWORD = 'staff-pass-1'

async function login(h: Harness, admin: string, username: string, roles: StaffRole[]) {
  const res = await h.call(
    'POST',
    '/admin/staff',
    { name: username, username, password: PASSWORD, roles },
    admin,
  )
  expect(res.status).toBe(201)
  return { id: res.json.id as number, token: await h.admin(username, PASSWORD) }
}

/** Every admin route with the permission its `need` middleware asks for. */
function adminRoutes(h: Harness) {
  const routes = h.app.routes.filter(
    (r) => r.path.startsWith('/api/admin/') && r.method !== 'ALL' && r.path !== '/api/admin/login',
  )
  const byRoute = new Map<string, StaffPermission | null>()
  for (const r of routes) {
    const key = `${r.method} ${r.path}`
    const permission = (r.handler as { [PERMISSION_CHECK]?: StaffPermission })[PERMISSION_CHECK]
    if (permission) byRoute.set(key, permission)
    else if (!byRoute.has(key)) byRoute.set(key, null)
  }
  return byRoute
}

describe('staff roles', () => {
  it('checks a permission on every admin route', () => {
    const h = setup()
    const routes = adminRoutes(h)
    expect(routes.size).toBeGreaterThan(60)
    const unchecked = [...routes].filter(([, p]) => p === null).map(([k]) => k)
    expect(unchecked).toEqual([])
  })

  it('turns away each role from the routes it may not use, and only those', async () => {
    const h = setup()
    const admin = await h.admin()
    const tokens = {
      admin,
      front_desk: (await login(h, admin, 'desk', ['front_desk'])).token,
      finance: (await login(h, admin, 'money', ['finance'])).token,
    }
    for (const [key, permission] of adminRoutes(h)) {
      // Logging out would end the session the rest of the loop uses.
      if (key === 'POST /api/admin/logout') continue
      const [method = '', path = ''] = key.split(' ')
      const url = path
        .replace('/api', '')
        .replace(':date', '2026-10-25')
        .replace(':kind', 'bookings')
        .replace(/:\w+/g, '999999')
      for (const [role, token] of Object.entries(tokens)) {
        const res = await h.call(method, url, undefined, token)
        const allowed = can([role as StaffRole], permission as StaffPermission)
        expect({ key, role, forbidden: res.status === 403 }).toEqual({
          key,
          role,
          forbidden: !allowed,
        })
      }
    }
  })

  it('gives 前台 the desk and 财务 the money', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const ten = h.slot(coach.id, '2026-10-25', 10)
    const noon = h.slot(coach.id, '2026-10-25', 12)
    const admin = await h.admin()
    const desk = (await login(h, admin, 'desk', ['front_desk'])).token
    const money = (await login(h, admin, 'money', ['finance'])).token
    const both = (await login(h, admin, 'both', ['front_desk', 'finance'])).token
    await h.student('小明')
    const student = (await h.call('GET', '/admin/students', undefined, admin)).json[0]

    const book = (token: string, slotId: number) =>
      h.call(
        'POST',
        '/admin/bookings',
        {
          studentId: student.id,
          slotId,
          lessonTypeId: lesson.id,
          payWith: 'offline',
          amount: 20000,
          method: 'cash',
        },
        token,
      )
    expect((await book(money, ten.id)).status).toBe(403)
    expect((await book(desk, ten.id)).status).toBe(201)

    expect((await h.call('GET', '/admin/orders', undefined, desk)).status).toBe(403)
    expect((await h.call('GET', '/admin/orders', undefined, money)).status).toBe(200)
    expect((await h.call('GET', '/admin/exports/bookings', undefined, desk)).status).toBe(403)
    expect((await h.call('GET', '/admin/settings', undefined, both)).status).toBe(403)
    expect((await h.call('GET', '/admin/staff', undefined, both)).status).toBe(403)
    expect((await h.call('GET', '/admin/orders', undefined, both)).status).toBe(200)
    expect((await book(both, noon.id)).status).toBe(201)

    // The home page leaves money out for the desk.
    const deskSummary = (await h.call('GET', '/admin/summary', undefined, desk)).json
    expect(deskSummary.revenue).toBeNull()
    expect(deskSummary.refundRequests).toBeNull()
    expect(deskSummary.sessions).toBeDefined()
    const moneySummary = (await h.call('GET', '/admin/summary', undefined, money)).json
    expect(moneySummary.revenue).toMatchObject({ today: expect.any(Number) })
    expect(moneySummary.refundRequests).toBe(0)

    const me = (await h.call('GET', '/admin/me', undefined, both)).json
    expect(me.roles).toEqual(['front_desk', 'finance'])

    // The desk can fix a phone number but not make a tester.
    const path = `/admin/students/${student.id}`
    expect((await h.call('PATCH', path, { phone: '13800000000' }, desk)).status).toBe(204)
    expect((await h.call('PATCH', path, { tester: true }, desk)).status).toBe(403)
    expect((await h.call('PATCH', path, { tester: true }, admin)).status).toBe(204)
  })

  it('shows coach bind codes to 管理员 only', async () => {
    const h = setup()
    const { coach } = h.seed()
    const admin = await h.admin()
    const desk = (await login(h, admin, 'desk', ['front_desk', 'finance'])).token
    const code = (await h.call('POST', `/admin/coaches/${coach.id}/bind-code`, undefined, admin))
      .json.code
    expect(code).toBeTruthy()
    const seen = async (token: string) =>
      (await h.call('GET', '/admin/coaches', undefined, token)).json[0].bindCode
    expect(await seen(admin)).toBe(code)
    expect(await seen(desk)).toBeNull()
  })

  it('makes 前台 charge the listed price, while 管理员 may change it', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const admin = await h.admin()
    const desk = (await login(h, admin, 'desk', ['front_desk'])).token
    await h.student('小明')
    const student = (await h.call('GET', '/admin/students', undefined, admin)).json[0]
    const product = (onSale: boolean, salePrice: number | null = null) =>
      h.db
        .insert(packageProducts)
        .values({
          name: '10 次课',
          lessonTypeId: lesson.id,
          lessonCount: 10,
          price: 180000,
          validityDays: 90,
          onSale,
          salePrice,
          saleStartsAt: salePrice ? new Date('2026-10-01T00:00:00Z') : null,
          saleEndsAt: salePrice ? new Date('2026-11-01T00:00:00Z') : null,
        })
        .returning()
        .get()
    const sell = (token: string, productId: number, amount: number) =>
      h.call(
        'POST',
        '/admin/packages/offline-sale',
        { studentId: student.id, productId, amount, method: 'cash' },
        token,
      )

    const listed = product(true)
    const free = await sell(desk, listed.id, 0)
    expect(free.json.error).toMatchObject({
      code: 'listed_price_only',
      message: '请按标价 ¥1800 收款，改价请联系管理员',
    })
    expect((await sell(desk, listed.id, 180000)).status).toBe(201)
    expect((await sell(admin, listed.id, 150000)).status).toBe(201)
    // A running sale is the listed price.
    const onSale = product(true, 160000)
    expect((await sell(desk, onSale.id, 180000)).json.error.code).toBe('listed_price_only')
    expect((await sell(desk, onSale.id, 160000)).status).toBe(201)
    const off = product(false)
    expect((await sell(desk, off.id, 180000)).json.error.code).toBe('product_off_sale')
    expect((await sell(admin, off.id, 180000)).status).toBe(201)

    const book = (token: string, slotId: number, amount?: number) =>
      h.call(
        'POST',
        '/admin/bookings',
        {
          studentId: student.id,
          slotId,
          lessonTypeId: lesson.id,
          payWith: 'offline',
          amount,
          method: 'cash',
        },
        token,
      )
    const ten = h.slot(coach.id, '2026-10-25', 10)
    const noon = h.slot(coach.id, '2026-10-25', 12)
    expect((await book(desk, ten.id, 0)).json.error.code).toBe('listed_price_only')
    expect((await book(desk, ten.id, 20000)).status).toBe(201)
    expect((await book(admin, noon.id, 0)).status).toBe(201)
  })

  it('applies a role change at once and logs it', async () => {
    const h = setup()
    const admin = await h.admin()
    const li = await login(h, admin, 'xiaoli', ['admin'])
    expect((await h.call('GET', '/admin/staff', undefined, li.token)).status).toBe(200)

    const res = await h.call(
      'PATCH',
      `/admin/staff/${li.id}`,
      { roles: ['finance', 'front_desk', 'finance'] },
      admin,
    )
    // Kept in the fixed order, without repeats.
    expect(res.json.roles).toEqual(['front_desk', 'finance'])
    expect((await h.call('GET', '/admin/staff', undefined, li.token)).status).toBe(403)

    const entry = h.db.select().from(actionLog).all().at(-1)
    expect(entry).toMatchObject({
      action: 'staff.roles',
      summary: 'xiaoli（xiaoli）角色由 管理员 改为 前台、财务',
    })

    // The same roles again change nothing and log nothing.
    const before = h.db.select().from(actionLog).all().length
    await h.call('PATCH', `/admin/staff/${li.id}`, { roles: ['front_desk', 'finance'] }, admin)
    expect(h.db.select().from(actionLog).all()).toHaveLength(before)
  })

  it('needs a role, and refuses unknown ones', async () => {
    const h = setup()
    const admin = await h.admin()
    for (const roles of [[], ['owner'], undefined]) {
      const res = await h.call(
        'POST',
        '/admin/staff',
        { name: '某', username: 'mou', password: PASSWORD, roles },
        admin,
      )
      expect(res.status).toBe(400)
    }
  })

  it('does not let staff change their own roles', async () => {
    const h = setup()
    const admin = await h.admin()
    const me = (await h.call('GET', '/admin/me', undefined, admin)).json
    expect(me.roles).toEqual(['admin'])
    const res = await h.call('PATCH', `/admin/staff/${me.id}`, { roles: ['finance'] }, admin)
    expect(res.json.error.code).toBe('own_roles')
  })

  it('always keeps one active 管理员', async () => {
    const h = setup()
    const admin = await h.admin()
    const li = await login(h, admin, 'xiaoli', ['admin'])
    // A desk login being active does not count.
    await login(h, admin, 'desk', ['front_desk'])
    await h.call('PATCH', `/admin/staff/${li.id}`, { roles: ['finance'] }, admin)
    // As if 小李 had demoted the first admin at the same moment.
    expect(() => updateStaff(h.deps, li.id, 1, { roles: ['front_desk'] })).toThrow(
      '至少要保留一个启用的管理员',
    )
    expect(() => updateStaff(h.deps, li.id, 1, { active: false })).toThrow(
      '至少要保留一个启用的管理员',
    )
    const me = (await h.call('GET', '/admin/me', undefined, admin)).json
    expect(me).toMatchObject({ roles: ['admin'], active: true })
  })
})
