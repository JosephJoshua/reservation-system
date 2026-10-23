import { randomBytes } from 'node:crypto'

// WeChat Pay allows 6-32 characters of [0-9a-zA-Z_-|*] for merchant order and refund numbers.
function tradeNumber(prefix: string, now: Date) {
  return `${prefix}${now.getTime()}${randomBytes(5).toString('hex')}`
}

export const newOutTradeNo = (now: Date) => tradeNumber('RS', now)
export const newOutRefundNo = (now: Date) => tradeNumber('RF', now)
export const newToken = () => randomBytes(32).toString('hex')
