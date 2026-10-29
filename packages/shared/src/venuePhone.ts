/**
 * The venue phone as the admin types it, such as `010-6234 5678 转 8`, `(+86) 139 0000 0001`
 * or `010-62345678 / 13900000001（微信同号）`: one or two numbers, each with an optional
 * extension, and a note in brackets at the end.
 */

export const VENUE_PHONE_MESSAGE =
  '电话格式不对：请填写电话号码，可写分机号（如“转 8”），两个号码用“/”隔开'

/** Full-width letters, digits and signs as their half-width forms, as typed with a Chinese IME. */
function halfWidth(text: string) {
  return text
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ')
}

// A note at the end, such as （微信同号）: brackets holding something besides a number.
const NOTE = /\s*\([^()]*[^\d\s()+.-][^()]*\)\s*$/
const EXTENSION = /\s*(?:转|分机|#|ext\.?|x)\s*\d{1,6}$/i
const NUMBER = /^(?:\+|\(\+)?[\d\s().-]+$/

/** The numbers in `phone`, each without its extension, or null when it is not a phone. */
function numbers(phone: string): string[] | null {
  const text = halfWidth(phone).trim().replace(NOTE, '')
  const parts = text.split(/[/、,;]/).map((p) => p.trim())
  if (parts.length > 2) return null
  const out: string[] = []
  for (const part of parts) {
    const number = part.replace(EXTENSION, '').trim()
    if (!NUMBER.test(number) || (number.match(/\d/g)?.length ?? 0) < 5) return null
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
  return /^\(?\+/.test(first) ? `+${digits}` : digits
}
