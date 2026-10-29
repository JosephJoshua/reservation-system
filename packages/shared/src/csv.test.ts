import { describe, expect, it } from 'vitest'
import { csvCell, toCsv } from './csv'

describe('csvCell', () => {
  it('keeps spreadsheets from running typed formulas', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    for (const s of ['+1', '-1+2', '@SUM(A1)', '\t=1', '\r=1', '\n=1']) {
      expect(csvCell(s).replace(/^"/, '').startsWith(`'`), JSON.stringify(s)).toBe(true)
    }
    // Negative amounts stay numbers.
    expect(csvCell('-80.00')).toBe('-80.00')
    expect(csvCell(-1)).toBe('-1')
  })

  it('keeps every digit of long numbers and leading zeros', () => {
    expect(csvCell('4200001234202610291234567890')).toBe('"=""4200001234202610291234567890"""')
    expect(csvCell('13800001111')).toBe('"=""13800001111"""')
    expect(csvCell('0755123')).toBe('"=""0755123"""')
    expect(csvCell('91310000MA1FL0000X')).toBe('91310000MA1FL0000X')
    expect(csvCell('200.50')).toBe('200.50')
    expect(csvCell('0')).toBe('0')
    expect(csvCell(12345678901)).toBe('12345678901')
  })

  it('quotes commas, quotes and line breaks', () => {
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('a\nb')).toBe('"a\nb"')
    expect(csvCell(null)).toBe('')
  })
})

describe('toCsv', () => {
  it('writes a BOM and CRLF lines', () => {
    expect(toCsv([['a', 1], []])).toBe('﻿a,1\r\n\r\n')
  })
})
