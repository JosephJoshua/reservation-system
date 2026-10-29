import { describe, expect, it } from 'vitest'
import { dialablePhone, phoneToDial, venuePhoneValid } from './venuePhone'

describe('venuePhoneValid', () => {
  it('takes phones as people write them', () => {
    for (const phone of [
      '',
      '  ',
      '010-62345678',
      '13900000001',
      '+86 139 0000 0001',
      '(+86) 139 0000 0001',
      '(010) 6234 5678',
      '（0571）8888-6666',
      '０１０－６２３４ ５６７８',
      '＋８６ １３９００００００１',
      '010.6234.5678',
      '010-62345678 转 8',
      '0571-88886666转802',
      '010-62345678 分机 123',
      '010-62345678#8',
      '010-62345678 / 13900000001',
      '010-62345678、13900000001',
      '010-62345678，13900000001',
      '13900000001（微信同号）',
      '010-62345678 / 13900000001 (微信同号)',
      '13800138000(8)',
      '13800138000（转 802）',
      '+44 20 7946 0958',
      '123456789012345',
    ]) {
      expect(venuePhoneValid(phone), phone).toBe(true)
    }
  })

  it('refuses what is not a phone', () => {
    for (const phone of [
      '😀😀😀',
      '前台',
      '（微信同号）',
      'abc12345',
      '123',
      '010-6234转',
      '010+转5',
      '1-2-3-4',
      '010-62345678 / 13900000001 / 13900000002',
      '010-62345678 / 😀',
      // Too many digits for one number, as when two are typed together.
      '138001380001380013800138001380013800',
      '1234567890123456',
      '+86 1234567890123456',
      // Brackets with more digits than an extension has.
      '13800138000(1234567)',
    ]) {
      expect(venuePhoneValid(phone), phone).toBe(false)
    }
  })
})

describe('dialablePhone', () => {
  it('dials the first number only, without its extension or note', () => {
    expect(dialablePhone('010-6234 5678 转 8')).toBe('01062345678')
    expect(dialablePhone('(+86) 139 0000 0001')).toBe('+8613900000001')
    expect(dialablePhone('+86 139-0000-0001')).toBe('+8613900000001')
    expect(dialablePhone('０１０－６２３４５６７８ / 13900000001（微信同号）')).toBe('01062345678')
    expect(dialablePhone('(010) 6234.5678#8')).toBe('01062345678')
    expect(dialablePhone('+86 (0)10 6234 5678')).toBe('+861062345678')
    expect(dialablePhone('0755—12345678')).toBe('075512345678')
  })

  it('leaves out an extension in brackets rather than dialling it with the number', () => {
    expect(dialablePhone('13800138000(8)')).toBe('13800138000')
    expect(dialablePhone('13800138000（8）')).toBe('13800138000')
    expect(dialablePhone('010-62345678 (转 802)')).toBe('01062345678')
  })

  it('has nothing to dial when there is no phone', () => {
    expect(dialablePhone('')).toBe(null)
    expect(dialablePhone('前台')).toBe(null)
  })
})

describe('phoneToDial', () => {
  it('dials a phone it can read by its first number', () => {
    expect(phoneToDial('010-6234 5678 转 8')).toBe('01062345678')
  })

  it('dials an odd phone saved before the check as it is', () => {
    expect(phoneToDial(' 前台 010-62345678 ')).toBe('前台 010-62345678')
  })

  it('dials a bracketed extension phone by its number alone', () => {
    expect(phoneToDial('13800138000(8)')).toBe('13800138000')
  })

  it('has nothing to dial without a phone', () => {
    expect(phoneToDial('')).toBe(null)
    expect(phoneToDial('  ')).toBe(null)
  })
})
