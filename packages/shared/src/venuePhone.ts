/**
 * The venue phone as the admin types it, such as `010-6234 5678 转 8`, `(+86) 139 0000 0001`
 * or `010-62345678 / 13900000001（微信同号）`: one or two numbers, each with an optional
 * extension, and a note in brackets at the end.
 */

export const VENUE_PHONE_MESSAGE =
  '电话格式不对：请填写电话号码，可写分机号（如“转 8”），两个号码用“/”隔开'

/**
 * Full-width letters, digits and signs as their half-width forms, as typed with a Chinese IME,
 * and dashes as hyphens.
 */
function halfWidth(text: string) {
  return text
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ')
    .replace(/[–—−]/g, '-')
}

// A note at the end, such as （微信同号）: brackets holding something besides a number.
const NOTE = /\s*\([^()]*[^\d\s()+.-][^()]*\)\s*$/
// An extension at the end, as in 转 8 or #8, or in brackets, as in (8) or (转 8).
const EXTENSION =
  /\s*(?:(?:转|分机|#|ext\.?|x)\s*\d{1,6}|\(\s*(?:(?:转|分机|ext\.?|x)\s*)?\d{1,6}\s*\))$/i
// An extension after a hyphen or a space, as in 0571-88888888-802 or 010 6234 5678 8: only after
// an area code and a full local number, so 010-6234-5678 stays one number.
const DASH_EXTENSION = /^(\(?0[1-9]\d{1,2}\)?[\s.-]?\d{3,4}[\s.-]?\d{4})(?:\s*-\s*|\s+)\d{1,6}$/
// A mainland mobile with digits after it, as in 139-0000-0001-12: a typo more likely than an
// extension, which a mobile seldom has, so refused rather than dialled with the extra digits.
const MOBILE_AND_MORE = /^1[3-9]\d{9}\d/
const NUMBER = /^(?:\+|\(\+)?[\d\s().-]+$/

/**
 * Whether `number`, without its extension, has as many digits as a phone number can: 5 for a
 * short service number, up to 15 as E.164 allows, and 11 for a mainland mobile. China's +86, and the trunk 0 some write after
 * it, are not counted.
 */
function digitsFit(number: string) {
  const digits = number.replace(/\D/g, '')
  const international = /^\(?\+/.test(number)
  const counted = international ? digits.replace(/^860?/, '') : digits
  if (!international || digits.startsWith('86')) {
    // The number as dialled within China, and, when written after China's code (+86, or 86 or
    // 0086 without the +), as it reads after it.
    const national: [string, boolean][] = [[counted, international]]
    const bare = /^(?:00)?86(0?1\d{9,})$/.exec(digits)
    if (!international && bare?.[1]) national.push([bare[1].replace(/^0/, ''), true])
    for (const [n, afterCode] of national) {
      if (MOBILE_AND_MORE.test(n)) return false
      // A mobile missing a digit. After the country code, Beijing's landlines read 10 xxxx xxxx.
      if (n.length === 10 && n.startsWith('1') && !(afterCode && n.startsWith('10'))) return false
    }
  }
  return counted.length >= 5 && counted.length <= 15
}

/** The numbers in `phone`, each without its extension, or null when it is not a phone. */
function numbers(phone: string): string[] | null {
  const text = halfWidth(phone).trim().replace(NOTE, '')
  const parts = text.split(/[/、,;]/).map((p) => p.trim())
  if (parts.length > 2) return null
  const out: string[] = []
  for (const part of parts) {
    const bare = part.replace(EXTENSION, '').trim()
    const number = bare.match(DASH_EXTENSION)?.[1] ?? bare
    if (!NUMBER.test(number) || !digitsFit(number)) return null
    out.push(number)
  }
  return out
}

/** Whether `phone` reads as a venue phone. Empty is allowed: the venue may not list one. */
export function venuePhoneValid(phone: string) {
  return phone.trim() === '' || numbers(phone) !== null
}

/**
 * The first number of `phone` to dial, as digits with a leading + for an international one, or
 * null when there is none. The extension and any note are left for the caller to read.
 */
export function dialablePhone(phone: string): string | null {
  const first = numbers(phone)?.[0]
  if (!first) return null
  const digits = first.replace(/\D/g, '')
  if (!/^\(?\+/.test(first)) {
    // China's code written without the +, as 86 or 0086, is dialled as +86: as plain digits it
    // would not connect. No mainland number of that length starts with 86.
    const china = /^(?:00)?86(0?[1-9]\d{8,10})$/.exec(digits)?.[1]
    return china ? `+86${china.replace(/^0/, '')}` : digits
  }
  // The trunk 0 some write after the country code, as in +86 (0)10 6234 5678, is not dialled.
  return `+${digits.replace(/^860/, '86')}`
}

/**
 * What the mini program dials for the venue phone: the first number, or the phone as saved when
 * it can't be read, such as one saved before phones were checked; the phone app makes what it
 * can of it. Null when there is no phone.
 */
export function phoneToDial(phone: string): string | null {
  return dialablePhone(phone) ?? (phone.trim() || null)
}
