import { describe, expect, it } from 'vitest'
import {
  defaultSettings,
  storedVenueSettings,
  type VenueSettings,
  venuePhoneValid,
  venueSettings,
} from './settings'

describe('venuePhoneValid', () => {
  it('takes phones as people write them', () => {
    for (const phone of [
      '',
      '  ',
      '010-62345678',
      '13900000001',
      '+86 139 0000 0001',
      '(010) 6234 5678',
      '（0571）8888-6666',
      '010-62345678 转 8',
      '0571-88886666转802',
    ]) {
      expect(venuePhoneValid(phone), phone).toBe(true)
    }
  })

  it('refuses what is not a phone', () => {
    for (const phone of ['😀😀😀', '前台', 'abc12345', '123', '010-6234转', '010+转5', '1-2-3-4']) {
      expect(venuePhoneValid(phone), phone).toBe(false)
    }
  })

  it('is checked on save but not when stored settings are read back', () => {
    const settings: VenueSettings = JSON.parse(JSON.stringify(defaultSettings))
    settings.venue.phone = '😀😀😀'
    expect(venueSettings.safeParse(settings).success).toBe(false)
    expect(storedVenueSettings.safeParse(settings).success).toBe(true)
  })
})
