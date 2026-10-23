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

/** Lesson price: the coach's own price if set, else the lesson type's, then any percent-off sale. */
export function lessonPrice(
  lessonType: { price: Fen; salePercent: number | null } & Sale,
  coachPrice: Fen | null,
  now: Date,
): PriceTag {
  const base = coachPrice ?? lessonType.price
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
 * Suggested refund for the unused part of a package: what was paid minus the lessons used at the
 * per-class price, never below zero. Granted lessons are treated as used last.
 */
export function suggestedPackageRefund(input: {
  pricePaid: Fen
  alreadyRefunded: Fen
  lessonsPurchased: number
  lessonsRemaining: number
  perClassPrice: Fen
}): Fen {
  const used = Math.max(0, input.lessonsPurchased - input.lessonsRemaining)
  const left = input.pricePaid - input.alreadyRefunded - used * input.perClassPrice
  return Math.max(0, Math.min(left, input.pricePaid - input.alreadyRefunded))
}
