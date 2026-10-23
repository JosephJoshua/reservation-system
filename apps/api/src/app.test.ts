import { healthResponse } from '@rs/shared'
import { describe, expect, it } from 'vitest'
import { createApp } from './app'
import { openDb } from './db/client'

describe('GET /api/health', () => {
  it('reports ok', async () => {
    const res = await createApp(openDb(':memory:')).request('/api/health')
    expect(res.status).toBe(200)
    expect(healthResponse.parse(await res.json()).ok).toBe(true)
  })

  it('returns 404 for unknown routes', async () => {
    const res = await createApp(openDb(':memory:')).request('/api/nope')
    expect(res.status).toBe(404)
  })
})
