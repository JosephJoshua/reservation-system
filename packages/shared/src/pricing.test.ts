import { describe, expect, it } from 'vitest'
import {
  formatMoney,
  formatYuan,
  lessonPrice,
  packagePrice,
  suggestedPackageRefund,
} from './pricing'

const now = new Date('2026-10-23T02:00:00Z')
const sale = {
  startsAt: new Date('2026-10-20T00:00:00Z'),
  endsAt: new Date('2026-10-30T00:00:00Z'),
}
const noSale = { startsAt: null, endsAt: null }

describe('lessonPrice', () => {
  it('uses the category price over the lesson type price', () => {
    expect(lessonPrice({ price: 20000, salePercent: null, ...noSale }, 30000, now)).toEqual({
      price: 30000,
      originalPrice: null,
    })
  })

  it('applies a running percent sale to whichever base applies', () => {
    expect(lessonPrice({ price: 20000, salePercent: 85, ...sale }, 30000, now)).toEqual({
      price: 25500,
      originalPrice: 30000,
    })
  })

  it('ignores a sale outside its dates', () => {
    const later = new Date('2026-10-30T00:00:00Z')
    expect(lessonPrice({ price: 20000, salePercent: 85, ...sale }, null, later).originalPrice).toBe(
      null,
    )
  })
})

describe('packagePrice', () => {
  it('shows the sale price with the original', () => {
    expect(packagePrice({ price: 200000, salePrice: 180000, ...sale }, now)).toEqual({
      price: 180000,
      originalPrice: 200000,
    })
  })

  it('ignores a sale price that is not lower', () => {
    expect(packagePrice({ price: 200000, salePrice: 200000, ...sale }, now).originalPrice).toBe(
      null,
    )
  })
})

describe('formatYuan', () => {
  it('drops zero cents', () => {
    expect(formatYuan(12000)).toBe('120')
    expect(formatYuan(12050)).toBe('120.50')
    expect(formatYuan(1)).toBe('0.01')
  })
})

describe('formatMoney', () => {
  it('groups thousands and shows cents only when there are any, always two of them', () => {
    expect(formatMoney(280_000)).toBe('¥2,800')
    expect(formatMoney(964_010)).toBe('¥9,640.10')
    expect(formatMoney(123_456_789_00)).toBe('¥123,456,789')
    expect(formatMoney(99_900)).toBe('¥999')
    expect(formatMoney(5)).toBe('¥0.05')
    expect(formatMoney(0)).toBe('¥0')
    expect(formatMoney(-200_000)).toBe('¥-2,000')
    expect(formatMoney(123_456.6)).toBe('¥1,234.57')
    expect(formatMoney(-1234.5)).toBe('¥-12.35')
    expect(formatMoney(1234.5)).toBe('¥12.35')
  })
})

describe('suggestedPackageRefund', () => {
  it('charges used lessons at the list price when no booking says otherwise', () => {
    const input = {
      pricePaid: 180000,
      alreadyRefunded: 0,
      lessonsPurchased: 10,
      lessonsGranted: 0,
      lessonsRemaining: 7,
      usedLessonPrices: [],
      listPrice: 20000,
    }
    expect(suggestedPackageRefund(input)).toBe(120000)
    expect(suggestedPackageRefund({ ...input, lessonsRemaining: 0 })).toBe(0)
  })

  it('treats granted lessons as used last', () => {
    expect(
      suggestedPackageRefund({
        pricePaid: 180000,
        alreadyRefunded: 0,
        lessonsPurchased: 10,
        lessonsGranted: 2,
        lessonsRemaining: 12,
        usedLessonPrices: [],
        listPrice: 20000,
      }),
    ).toBe(180000)
    // 2 granted, 3 used: the 3 come out of the paid lessons, so 7 paid lessons are refunded.
    expect(
      suggestedPackageRefund({
        pricePaid: 150000,
        alreadyRefunded: 0,
        lessonsPurchased: 10,
        lessonsGranted: 2,
        lessonsRemaining: 9,
        usedLessonPrices: [],
        listPrice: 20000,
      }),
    ).toBe(90000)
  })

  it("charges each used lesson at its coach's category price", () => {
    // 3 lessons used: two with a ¥300 coach, one with a coach on the ¥200 list price.
    expect(
      suggestedPackageRefund({
        pricePaid: 250000,
        alreadyRefunded: 0,
        lessonsPurchased: 10,
        lessonsGranted: 0,
        lessonsRemaining: 7,
        usedLessonPrices: [30000, 20000, 30000],
        listPrice: 20000,
      }),
    ).toBe(170000)
    // Only paid lessons are charged: with 1 granted lesson, the 4th booking is the granted one.
    expect(
      suggestedPackageRefund({
        pricePaid: 250000,
        alreadyRefunded: 0,
        lessonsPurchased: 3,
        lessonsGranted: 1,
        lessonsRemaining: 0,
        usedLessonPrices: [30000, 30000, 30000, 30000],
        listPrice: 20000,
      }),
    ).toBe(160000)
  })
})
