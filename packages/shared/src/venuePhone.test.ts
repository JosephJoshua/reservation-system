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
      '＋８６ １３９０００００００１',
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
      '86 13900000001',
      '0086 139 0000 0001',
      '+86 10 6234 5678',
      '0086 10 6234 5678',
      '400-820-8820',
      '4008208820 转 2',
      '95588',
      '8620 1234',
      '+1 415 555 0100',
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
      // A mobile with digits after it, also after China's code written without the +.
      '139 0000 0001 8',
      '+86 139 0000 0001 2',
      '86 139000000012',
      '0086 139000000018',
      '0086 0139000000018',
      // A mobile missing a digit.
      '1390000000',
      '139-0000-000',
      '+86 1390000000',
      '86 1390000000',
      '0086 1390000000',
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

  it('dials China written as 86 or 0086 without the + as +86', () => {
    expect(dialablePhone('86 13900000001')).toBe('+8613900000001')
    expect(dialablePhone('0086 139 0000 0001')).toBe('+8613900000001')
    expect(dialablePhone('86 10 6234 5678')).toBe('+861062345678')
    expect(dialablePhone('86 (0)10 6234 5678')).toBe('+861062345678')
    // A local number that happens to start with 86 is left alone.
    expect(dialablePhone('8623 4567')).toBe('86234567')
  })

  it('leaves out an extension after a hyphen that follows a full landline number', () => {
    expect(venuePhoneValid('0571-88888888-8023')).toBe(true)
    expect(dialablePhone('0571-88888888-8023')).toBe('057188888888')
    expect(dialablePhone('0571-88888888-802')).toBe('057188888888')
    expect(dialablePhone('010-62345678-8')).toBe('01062345678')
    expect(dialablePhone('(0571) 8888-8888-802')).toBe('057188888888')
    // Hyphens inside a number are not an extension.
    expect(dialablePhone('010-6234-5678')).toBe('01062345678')
    expect(dialablePhone('138-0013-8000')).toBe('13800138000')
  })

  it('reads a short group after a full landline number, typed with a space, as its extension', () => {
    expect(dialablePhone('010 6234 5678 8')).toBe('01062345678')
    expect(dialablePhone('0571 8888 8888 802')).toBe('057188888888')
    expect(dialablePhone('(010) 62345678 12')).toBe('01062345678')
    expect(dialablePhone('010 6234 5678')).toBe('01062345678')
    expect(dialablePhone('0755 2345 6789')).toBe('075523456789')
    // 00 starts an international number, not an area code.
    expect(dialablePhone('0086 139 0000 0001')).toBe('+8613900000001')
  })

  it('leaves out an extension after a landline written with China’s code', () => {
    expect(dialablePhone('(+86) 0571-88888888-8023')).toBe('+8657188888888')
    expect(dialablePhone('+86 10-62345678-8023')).toBe('+861062345678')
    expect(dialablePhone('+86 10 6234 5678 8')).toBe('+861062345678')
    expect(dialablePhone('+86 571 8888 8888 8023')).toBe('+8657188888888')
    expect(dialablePhone('86 10 6234 5678-8')).toBe('+861062345678')
    expect(dialablePhone('0086 (0)755 1234 5678-8')).toBe('+8675512345678')
    expect(dialablePhone('+86 (0571) 8888 8888-8023')).toBe('+8657188888888')
    expect(dialablePhone('+86(0571)88888888-8')).toBe('+8657188888888')
    expect(dialablePhone('(+86) (0571) 8888 8888-8')).toBe('+8657188888888')
    expect(dialablePhone('+86 (010) 6234 5678 8')).toBe('+861062345678')
    expect(dialablePhone('86 (0571) 88888888-8')).toBe('+8657188888888')
    expect(dialablePhone('0086 (0571) 8888 8888-8')).toBe('+8657188888888')
    expect(dialablePhone('0086 (0571) 8888 8888 8023')).toBe('+8657188888888')
    expect(dialablePhone('0086 (010) 6234 5678-8')).toBe('+861062345678')
  })

  it('refuses a China number with digits left over that it cannot read as an extension', () => {
    for (const phone of [
      '(0086) 755 1234 5678 8',
      '(0086)755-12345678-8',
      '(0086) (0755) 1234 5678-8',
      '0086  755 1234 5678 8',
      '0086.755.1234.5678.8',
      '+86  10  6234  5678  8',
      '+86 (00) 571 8888 8888 8',
    ]) {
      expect(dialablePhone(phone), phone).toBeNull()
    }
    expect(dialablePhone('+86 (0139) 0000 0001')).toBe('+8613900000001')
    expect(dialablePhone('95105 888')).toBe('95105888')
    // Six-digit service lines, however they are spaced.
    for (const phone of ['118 114', '116-114', '962 288', '96 2288', '9558 81']) {
      expect(venuePhoneValid(phone), phone).toBe(true)
    }
  })

  it('leaves out an extension after a 400 or 800 number or a local one', () => {
    expect(dialablePhone('400-820-8820-3')).toBe('4008208820')
    expect(dialablePhone('400 820 8820 1')).toBe('4008208820')
    expect(dialablePhone('800-820-8820-12')).toBe('8008208820')
    expect(dialablePhone('400-820-8820')).toBe('4008208820')
    expect(dialablePhone('4008-123-456-8')).toBe('4008123456')
    expect(dialablePhone('4008 208 820 3')).toBe('4008208820')
    expect(dialablePhone('62345678-802')).toBe('62345678')
    expect(dialablePhone('6234 5678 8')).toBe('62345678')
    expect(dialablePhone('623 4567-8')).toBe('6234567')
    expect(venuePhoneValid('623456788')).toBe(false)
    expect(dialablePhone('400-8208-820')).toBe('4008208820')
    expect(dialablePhone('400 8208 820')).toBe('4008208820')
    expect(dialablePhone('400-6666-800')).toBe('4006666800')
    expect(dialablePhone('400-8208-820-3')).toBe('4008208820')
    for (const phone of [
      '755 1234 5678',
      '571 8888 8888',
      '852 2345 6789',
      '8001 2345 8',
      '95588-1',
      '95588.1',
      '10086.12',
      '(95588) 1',
      '(95588)-1',
      '955 88-1',
      '10086 1',
      '+86 400 6666 800 8',
      '0086 400-8208-820-3',
    ]) {
      expect(venuePhoneValid(phone), phone).toBe(false)
    }
  })

  it('refuses a domestic number longer than any mainland number', () => {
    for (const phone of ['0106234567888', '0571888888888', '021123456789', '40082088201']) {
      expect(venuePhoneValid(phone), phone).toBe(false)
    }
    expect(dialablePhone('057188888888')).toBe('057188888888')
    expect(dialablePhone('02112345678')).toBe('02112345678')
    expect(dialablePhone('0898 1234567')).toBe('08981234567')
  })

  it('takes 0086 with the trunk 0 after it, as +86 and 86', () => {
    expect(venuePhoneValid('0086 (0)755 1234 5678')).toBe(true)
    expect(dialablePhone('0086 (0)755 1234 5678')).toBe('+8675512345678')
    expect(dialablePhone('0086 0755 1234 5678')).toBe('+8675512345678')
    expect(venuePhoneValid('0086 1390000000')).toBe(false)
  })

  it('refuses digits after a mainland mobile instead of dialling them', () => {
    for (const phone of [
      '139-0000-0001-12',
      '139 0000 0001 2',
      '13900000001 12',
      '+86 139 0000 0001-8',
      '(+86) 139 0000 0001 8',
    ]) {
      expect(venuePhoneValid(phone), phone).toBe(false)
      expect(dialablePhone(phone), phone).toBeNull()
    }
    // With 转 or brackets, a mobile may still name an extension.
    expect(dialablePhone('13900000001 转 8')).toBe('13900000001')
    // Another country's number is not a mainland mobile.
    expect(venuePhoneValid('+1 415 555 0123 4')).toBe(true)
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
