import { healthResponse, versionOf } from '@rs/shared'
import { describe, expect, it } from 'vitest'
import { setup } from './test/harness'

describe('GET /api/health', () => {
  it('reports ok', async () => {
    const res = await setup().call('GET', '/health')
    expect(res.status).toBe(200)
    expect(healthResponse.parse(res.json).ok).toBe(true)
  })

  it('returns 404 for unknown routes', async () => {
    const res = await setup().call('GET', '/nope')
    expect(res.status).toBe(404)
    expect(res.json.error.code).toBe('not_found')
  })
})

describe('validation messages', () => {
  it('names the field in Chinese instead of its code name', async () => {
    const h = setup()
    const admin = await h.admin()
    const empty = await h.call('POST', '/admin/coaches', { name: '  ' }, admin)
    expect(empty.status).toBe(400)
    expect(empty.json.error.message).toBe('请填写名称')
    const missing = await h.call('POST', '/admin/coaches', {}, admin)
    expect(missing.json.error.message).toBe('请填写名称')
    const unlabelled = await h.call('POST', '/admin/coaches', { name: '王', sort: 'x' }, admin)
    expect(unlabelled.json.error.message).toBe('排序格式不对')
    const internal = await h.call('POST', '/admin/coaches', { name: '王', active: 'x' }, admin)
    expect(internal.json.error.message).toBe('请求格式错误：active')

    const settings = (await h.call('GET', '/admin/settings', undefined, admin)).json
    settings.booking.advanceDays = 500
    const range = await h.call('PUT', '/admin/settings', settings, admin)
    expect(range.json.error.message).toBe('可提前预约天数超出允许范围')
  })
})

describe('edits from two tabs', () => {
  it('refuses a settings save made on top of a change the editor has not seen', async () => {
    const h = setup()
    const admin = await h.admin()
    const loaded = (await h.call('GET', '/admin/settings', undefined, admin)).json
    const ifMatch = { 'If-Match': versionOf(loaded) }

    const first = structuredClone(loaded)
    first.venue.name = '第一个标签页'
    expect((await h.call('PUT', '/admin/settings', first, admin, ifMatch)).status).toBe(200)

    const second = structuredClone(loaded)
    second.notice.text = '第二个标签页'
    const stale = await h.call('PUT', '/admin/settings', second, admin, ifMatch)
    expect(stale.status).toBe(409)
    expect(stale.json.error.code).toBe('edited_elsewhere')
    const now = (await h.call('GET', '/admin/settings', undefined, admin)).json
    expect(now.venue.name).toBe('第一个标签页')

    // A save on top of what is there now goes through.
    second.venue.name = now.venue.name
    const fresh = await h.call('PUT', '/admin/settings', second, admin, {
      'If-Match': versionOf(now),
    })
    expect(fresh.status).toBe(200)
  })

  it('refuses a banner save made on top of a change the editor has not seen', async () => {
    const h = setup()
    const admin = await h.admin()
    const body = { imageUrl: '/api/uploads/a.png', title: '双十一' }
    const created = (await h.call('POST', '/admin/banners', body, admin)).json
    const ifMatch = { 'If-Match': versionOf(created) }
    const path = `/admin/banners/${created.id}`
    const first = await h.call('PUT', path, { ...body, title: '双十二' }, admin, ifMatch)
    expect(first.status).toBe(200)
    const stale = await h.call('PUT', path, { ...body, sort: 3 }, admin, ifMatch)
    expect(stale.json.error.code).toBe('edited_elsewhere')
    const again = await h.call('PUT', path, { ...body, sort: 3 }, admin, {
      'If-Match': versionOf(first.json),
    })
    expect(again.status).toBe(200)
  })

  it('refuses stale catalog saves, versioned as the admin lists load them', async () => {
    const h = setup()
    const admin = await h.admin()
    const post = async (path: string, body: object) =>
      (await h.call('POST', path, body, admin)).json as { id: number }
    const lesson = { name: '一对一', durationMinutes: 60, price: 30000 }
    const lessonTypeId = (await post('/admin/lesson-types', lesson)).id
    const category = { name: '金牌', prices: [{ lessonTypeId, price: 40000 }] }
    const categoryId = (await post('/admin/coach-categories', category)).id
    const coach = { name: '王教练', categoryId, lessonTypeIds: [lessonTypeId] }
    const coachId = (await post('/admin/coaches', coach)).id
    const product = {
      name: '十次卡',
      lessonTypeId,
      lessonCount: 10,
      price: 280000,
      validityDays: 180,
    }
    const productId = (await post('/admin/package-products', product)).id

    const cases = [
      { list: '/admin/lesson-types', id: lessonTypeId, body: lesson, edit: { name: '一对一私教' } },
      { list: '/admin/coach-categories', id: categoryId, body: category, edit: { name: '银牌' } },
      { list: '/admin/coaches', id: coachId, body: coach, edit: { title: '国家二级' } },
      { list: '/admin/package-products', id: productId, body: product, edit: { sort: 2 } },
    ]
    for (const { list, id, body, edit } of cases) {
      const loaded = async () =>
        ((await h.call('GET', list, undefined, admin)).json as { id: number }[]).find(
          (r) => r.id === id,
        )
      // As the coach editor does: binding state is not part of the edit.
      const editable = async () => {
        const {
          bound: _b,
          bindCode: _c,
          bindCodeExpiresAt: _e,
          ...rest
        } = (await loaded()) as {
          bound?: unknown
          bindCode?: unknown
          bindCodeExpiresAt?: unknown
        }
        return list === '/admin/coaches' ? rest : await loaded()
      }
      const tab = { 'If-Match': versionOf(await editable()) }
      const first = await h.call('PUT', `${list}/${id}`, { ...body, ...edit }, admin, tab)
      expect(first.status, list).toBe(200)
      const stale = await h.call('PUT', `${list}/${id}`, { ...body, sort: 5 }, admin, tab)
      expect(stale.json?.error?.code, list).toBe('edited_elsewhere')
      const fresh = await h.call('PUT', `${list}/${id}`, { ...body, ...edit, sort: 5 }, admin, {
        'If-Match': versionOf(await editable()),
      })
      expect(fresh.status, list).toBe(200)
    }
  })

  it('does not count a bind code made meanwhile as a coach edit', async () => {
    const h = setup()
    const admin = await h.admin()
    const coach = (await h.call('POST', '/admin/coaches', { name: '李教练' }, admin)).json
    const { bound: _b, bindCode: _c, bindCodeExpiresAt: _e, ...editable } = coach
    await h.call('POST', `/admin/coaches/${coach.id}/bind-code`, undefined, admin)
    const save = await h.call('PUT', `/admin/coaches/${coach.id}`, { name: '李指导' }, admin, {
      'If-Match': versionOf(editable),
    })
    expect(save.status).toBe(200)
  })
})
