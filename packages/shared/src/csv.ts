// CSV for spreadsheets: the server's exports and the admin's 月报 download.

export type CsvCell = string | number | null

/**
 * One CSV field. Text a spreadsheet would run as a formula (a student can type a name such as
 * =HYPERLINK(...)) gets a leading quote; a plain number such as -80.00 is left as it is. Long
 * digit strings (phone numbers, 微信支付单号, 税号) and ones with a leading zero are written as
 * ="..." so Excel keeps every digit instead of showing 1.38E+10.
 */
export function csvCell(v: CsvCell) {
  if (v === null) return ''
  let s = String(v)
  if (typeof v === 'string') {
    if (/^(\d{11,}|0\d+)$/.test(s)) return `"=""${s}"""`
    if (/^[=+\-@\t\r\n]/.test(s) && !/^-\d+(\.\d+)?$/.test(s)) s = `'${s}`
  }
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** A UTF-8 CSV with a BOM, so Excel shows the Chinese text correctly. */
export function toCsv(rows: CsvCell[][]) {
  return `﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`
}
