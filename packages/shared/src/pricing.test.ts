import { describe, expect, it } from 'vitest'
import { formatYuan, lessonPrice, packagePrice, suggestedPackageRefund } from './pricing'

const now = new Date('2026-10-23T02:00:00Z')
const sale = {
  startsAt: new Date('2026-10-20T00:00:00Z'),
  endsAt: new Date('2026-10-30T00:00:00Z'),
}
const noSale = { startsAt: null, endsAt: null }

describe('lessonPrice', () => {
  it('uses the coach price over the lesson type price', () => {
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

describe('suggestedPackageRefund', () => {
  it('charges used lessons at the per-class price', () => {
    const input = {
      pricePaid: 180000,
      alreadyRefunded: 0,
      lessonsPurchased: 10,
      lessonsGranted: 0,
      lessonsRemaining: 7,
      perClassPrice: 20000,
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
        perClassPrice: 20000,
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
        perClassPrice: 20000,
      }),
    ).toBe(90000)
  })
})
