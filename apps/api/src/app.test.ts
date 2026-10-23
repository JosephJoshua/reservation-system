import { healthResponse } from '@rs/shared'
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
