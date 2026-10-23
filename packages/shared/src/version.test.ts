import { describe, expect, it } from 'vitest'
import { versionOf } from './version'

describe('versionOf', () => {
  it('matches after the record goes through JSON, as a client receives it', () => {
    const row = { id: 1, title: '双十一', startsAt: new Date('2026-11-11T00:00:00Z'), linkId: null }
    expect(versionOf(JSON.parse(JSON.stringify(row)))).toBe(versionOf(row))
  })

  it('changes when any field changes', () => {
    const a = { id: 1, title: '双十一', sort: 0 }
    expect(versionOf({ ...a, sort: 1 })).not.toBe(versionOf(a))
    expect(versionOf({ ...a, title: '双十二' })).not.toBe(versionOf(a))
  })
})
