/** Money is always an integer number of fen. */
export type Fen = number

export interface Sale {
  startsAt: Date | null
  endsAt: Date | null
}

export interface PriceTag {
  price: Fen
  /** Set when a sale is running, for the struck-through price. */
  originalPrice: Fen | null
}

function saleRunning(sale: Sale, now: Date): boolean {
  if (!sale.startsAt || !sale.endsAt) return false
  return now >= sale.startsAt && now < sale.endsAt
}

/**
 * Lesson price: the price set for the coach's category if any, else the lesson type's, then any
 * percent-off sale.
 */
export function lessonPrice(
  lessonType: { price: Fen; salePercent: number | null } & Sale,
  categoryPrice: Fen | null,
  now: Date,
): PriceTag {
  const base = categoryPrice ?? lessonType.price
  if (lessonType.salePercent == null || !saleRunning(lessonType, now)) {
    return { price: base, originalPrice: null }
  }
  const price = Math.round((base * lessonType.salePercent) / 100)
  return price < base ? { price, originalPrice: base } : { price: base, originalPrice: null }
}

/** Package price, with a fixed sale price while the sale runs. */
export function packagePrice(
  product: { price: Fen; salePrice: Fen | null } & Sale,
  now: Date,
): PriceTag {
  if (
    product.salePrice == null ||
    !saleRunning(product, now) ||
    product.salePrice >= product.price
  ) {
    return { price: product.price, originalPrice: null }
  }
  return { price: product.salePrice, originalPrice: product.price }
}

/** ¥ amount for display: 12000 -> "120", 12050 -> "120.50". */
export function formatYuan(fen: Fen): string {
  const yuan = Math.floor(Math.abs(fen) / 100)
  const cents = Math.abs(fen) % 100
  const sign = fen < 0 ? '-' : ''
  return cents === 0 ? `${sign}${yuan}` : `${sign}${yuan}.${String(cents).padStart(2, '0')}`
}

/**
 * Money as staff read it, in the admin and its 操作记录: with thousands separators, and two
 * decimals unless whole, as ¥9,640, ¥9,640.10 and ¥-20. A part of a fen, as from an average, is
 * rounded.
 */
export function formatMoney(fen: Fen): string {
  // Half a fen rounds away from zero, as Intl did: -1234.5 is ¥-12.35.
  const rounded = Math.sign(fen) * Math.round(Math.abs(fen))
  const [whole = '', cents] = formatYuan(rounded).split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+$)/g, ',')
  return `¥${grouped}${cents ? `.${cents}` : ''}`
}

/**
 * Suggested refund for the unused part of a package: what was paid minus the paid lessons used,
 * each charged at the single-class price of the coach it was taken with (their category's price,
 * else the list price), never below zero.
 * Granted lessons are treated as used last, so lessons used come out of the paid ones first.
 */
export function suggestedPackageRefund(input: {
  pricePaid: Fen
  alreadyRefunded: Fen
  lessonsPurchased: number
  lessonsGranted: number
  lessonsRemaining: number
  /** Single-class price of each lesson taken from the package, oldest first. */
  usedLessonPrices: Fen[]
  /** Price for a used lesson with no booking behind it, such as an admin adjustment. */
  listPrice: Fen
}): Fen {
  const used = input.lessonsPurchased + input.lessonsGranted - input.lessonsRemaining
  const paidUsed = Math.min(input.lessonsPurchased, Math.max(0, used))
  let charged = 0
  for (let i = 0; i < paidUsed; i++) charged += input.usedLessonPrices[i] ?? input.listPrice
  return Math.max(0, input.pricePaid - input.alreadyRefunded - charged)
}
