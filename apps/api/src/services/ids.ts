import { createHash, randomBytes } from 'node:crypto'

// WeChat Pay allows 6-32 characters of [0-9a-zA-Z_-|*] for merchant order and refund numbers.
function tradeNumber(prefix: string, now: Date) {
  return `${prefix}${now.getTime()}${randomBytes(5).toString('hex')}`
}

export const newOutTradeNo = (now: Date) => tradeNumber('RS', now)
export const newOutRefundNo = (now: Date) => tradeNumber('RF', now)
export const newToken = () => randomBytes(32).toString('hex')

/**
 * What the sessions table keeps of a token: its SHA-256, so a copy of the database (a backup)
 * holds no token anyone could sign in with.
 */
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

// No 0/O, 1/I/L: a bind code is read off a screen and typed on a phone.
const BIND_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

/** An 8-character one-time code. 31^8 codes: guessing one in a day is out of reach. */
export function newBindCode(): string {
  const code = Array.from(randomBytes(16))
    .filter((b) => b < 248)
    .slice(0, 8)
    .map((b) => BIND_ALPHABET[b % 31])
    .join('')
  return code.length === 8 ? code : newBindCode()
}

/** A typed bind code with case, spaces and dashes evened out. */
export const normalizeBindCode = (code: string) => code.toUpperCase().replace(/[\s-]/g, '')
