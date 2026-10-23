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
