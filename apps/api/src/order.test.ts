import { versionOf } from '@rs/shared'
import { describe, expect, it } from 'vitest'
import { setup } from './test/harness'

const ids = (rows: { id: number }[]) => rows.map((r) => r.id)

describe('PUT /admin/order/:list', () => {
  it('saves the order the admin arranged, which the student lists follow', async () => {
    const h = setup()
    const admin = await h.admin()
    const add = async (title: string) =>
      (await h.call('POST', '/admin/banners', { imageUrl: '/api/uploads/a.png', title }, admin))
        .json.id as number
    const [a, b, c] = [await add('一'), await add('二'), await add('三')]

    const res = await h.call('PUT', '/admin/order/banners', { ids: [c, a, b] }, admin)
    expect(res.status).toBe(204)
    expect(ids((await h.call('GET', '/admin/banners', undefined, admin)).json)).toEqual([c, a, b])
    const home = (await h.call('GET', '/home')).json
    expect(home.banners.map((x: { title: string }) => x.title)).toEqual(['三', '一', '二'])

    // A new row goes to the end, not the top.
    const d = await add('四')
    expect(ids((await h.call('GET', '/admin/banners', undefined, admin)).json)).toEqual([
      c,
      a,
      b,
      d,
    ])
  })

  it('refuses an order made on a list that has changed since', async () => {
    const h = setup()
    const admin = await h.admin()
    const post = async (name: string) =>
      (
        await h.call(
          'POST',
          '/admin/lesson-types',
          { name, durationMinutes: 60, price: 100 },
          admin,
        )
      ).json.id as number
    const [a, b] = [await post('甲'), await post('乙')]
    const c = await post('丙')

    for (const order of [
      [b, a],
      [c, b, a, a],
      [c, b, a, 9999],
    ]) {
      const res = await h.call('PUT', '/admin/order/lesson-types', { ids: order }, admin)
      expect(res.status, JSON.stringify(order)).toBe(409)
      expect(res.json.error.code).toBe('list_changed')
    }
    const list = await h.call('GET', '/admin/lesson-types', undefined, admin)
    expect(ids(list.json)).toEqual([a, b, c])
  })

  it('works for every hand-ordered list, and only for those', async () => {
    const h = setup()
    const admin = await h.admin()
    const lessonTypeId = (
      await h.call(
        'POST',
        '/admin/lesson-types',
        { name: '一对一', durationMinutes: 60, price: 1 },
        admin,
      )
    ).json.id
    for (const [list, body] of [
      ['coaches', { name: '王' }],
      ['coach-categories', { name: '金牌' }],
      [
        'package-products',
        { name: '十次卡', lessonTypeId, lessonCount: 10, price: 100, validityDays: 30 },
      ],
    ] as const) {
      const one = (await h.call('POST', `/admin/${list}`, body, admin)).json.id
      const two = (await h.call('POST', `/admin/${list}`, body, admin)).json.id
      const res = await h.call('PUT', `/admin/order/${list}`, { ids: [two, one] }, admin)
      expect(res.status, list).toBe(204)
      expect(ids((await h.call('GET', `/admin/${list}`, undefined, admin)).json), list).toEqual([
        two,
        one,
      ])
    }
    for (const list of ['students', 'staff', 'constructor', '__proto__']) {
      const res = await h.call('PUT', `/admin/order/${list}`, { ids: [] }, admin)
      expect(res.status, list).toBe(404)
    }
  })

  it('leaves an editor opened before the reorder able to save', async () => {
    const h = setup()
    const admin = await h.admin()
    const body = { imageUrl: '/api/uploads/a.png', title: '一' }
    const first = (await h.call('POST', '/admin/banners', body, admin)).json
    const second = (await h.call('POST', '/admin/banners', body, admin)).json
    await h.call('PUT', '/admin/order/banners', { ids: [second.id, first.id] }, admin)
    const save = await h.call(
      'PUT',
      `/admin/banners/${first.id}`,
      { ...body, title: '改' },
      admin,
      {
        'If-Match': versionOf(first),
      },
    )
    expect(save.status).toBe(200)
    // The edit keeps the row where the reorder put it.
    expect(save.json.sort).toBe(1)
  })

  it('is for 管理员 only', async () => {
    const h = setup()
    const admin = await h.admin()
    await h.call(
      'POST',
      '/admin/staff',
      { name: '前台', username: 'desk', password: 'desk1234', roles: ['front_desk'] },
      admin,
    )
    const desk = await h.admin('desk', 'desk1234')
    const res = await h.call('PUT', '/admin/order/banners', { ids: [] }, desk)
    expect(res.status).toBe(403)
  })
})
