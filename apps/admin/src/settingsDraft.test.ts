import { describe, expect, it } from 'vitest'
import { staleAfterRefusal } from './settingsDraft'

describe('staleAfterRefusal', () => {
  const sent = { venue: { name: 'Lumi乒乓', phone: '010' }, payment: { timeoutMinutes: 10 } }

  it('lets the form be saved again only when the stored settings are what it sent', () => {
    // An earlier try of the same save went through: nothing to protect.
    const landed = { payment: { timeoutMinutes: 10 }, venue: { phone: '010', name: 'Lumi乒乓' } }
    expect(staleAfterRefusal(landed, sent)).toBe(false)
    // Another admin changed a field meanwhile, or the settings could not be read.
    const theirs = { venue: { name: 'Lumi乒乓', phone: '020' }, payment: { timeoutMinutes: 10 } }
    expect(staleAfterRefusal(theirs, sent)).toBe(true)
    expect(staleAfterRefusal(null, sent)).toBe(true)
  })
})
