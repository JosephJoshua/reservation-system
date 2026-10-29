import {
  and,
  type Column,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  not,
  or,
  type SQL,
  sql,
} from 'drizzle-orm'
import type { Context } from 'hono'
import { z } from 'zod'
import { bookings, invoices, orders, refunds, slots, students } from '../db/schema'

/**
 * Filters shared by the admin's lists and their exports, so a CSV holds the rows the list
 * showed. Each list also says how many rows match in all, for its page numbers.
 */

/** `limit` and `offset` of a page of an admin list. */
export const pageParams = {
  limit: z.coerce.number().int().min(1).max(500).default(500),
  offset: z.coerce.number().int().min(0).default(0),
}

/** How many rows match the filters in all, for the admin's page numbers. */
export function setTotal(c: Context, total: number) {
  c.header('X-Total-Count', String(total))
}

export const countAll = sql<number>`count(*)`.mapWith(Number)

/** Search text: a name or phone it contains, or a 学员编号. */
export const searchParam = z.string().trim().max(30).optional()

/** The column contains the text, with % and _ taken as they are. */
export function contains(column: Column, text: string): SQL {
  return sql`${column} like ${`%${text.replace(/[\\%_]/g, '\\$&')}%`} escape '\\'`
}

/** Students whose name or phone contains the text, or whose 学员编号 it is. */
export function studentSearch(text: string | undefined): SQL | undefined {
  if (!text) return undefined
  return or(
    contains(students.name, text),
    contains(students.phone, text),
    // A short number is also a 学员编号, which the student can show on their 我的 page.
    /^\d{1,6}$/.test(text) ? eq(students.id, Number(text)) : undefined,
  )
}

/** Rows whose student matches the search, for a list that does not join students. */
export function ofStudents(column: Column, text: string | undefined): SQL | undefined {
  const search = studentSearch(text)
  return search
    ? inArray(column, sql`(select ${students.id} from ${students} where ${search})`)
    : undefined
}

export const bookingStatusParam = z.enum([
  'pending_payment',
  'confirmed',
  'completed',
  'cancelled',
  'expired',
])

export const bookingPayParam = z.enum(['package', 'wechat', 'offline'])
export const sourceParam = z.enum(['staff', 'student'])
export const orderKindParam = z.enum(['class', 'trial', 'package'])
export const providerParam = z.enum(['wechat', 'offline'])
export const titleKindParam = z.enum(['personal', 'company'])

/** A filter that is on with `1`. */
export const flag = z
  .enum(['1'])
  .optional()
  .transform((v) => v === '1')

export interface BookingFilters {
  from?: Date
  to?: Date
  studentId?: number
  coachId?: number
  lessonTypeId?: number
  status?: z.infer<typeof bookingStatusParam>
  /** Only bookings with no attendance marked. */
  unmarked?: boolean
  q?: string
  /** 课时包, 微信支付 or paid at the desk. */
  pay?: z.infer<typeof bookingPayParam>
  /** 代约 by staff, or booked by the student. */
  source?: 'staff' | 'student'
}

const offlineOrder = sql`(select 1 from ${orders} where ${orders.bookingId} = ${bookings.id} and ${orders.provider} = 'offline')`

/** Bookings that match, for a query that joins `slots` for the coach. */
export function bookingWhere(q: BookingFilters, now: Date): SQL | undefined {
  // A confirmed booking that has ended shows as completed, so the two filters split on endsAt.
  const status =
    q.status === 'confirmed'
      ? and(eq(bookings.status, 'confirmed'), gt(bookings.endsAt, now))
      : q.status === 'completed'
        ? and(eq(bookings.status, 'confirmed'), lte(bookings.endsAt, now))
        : q.status
          ? eq(bookings.status, q.status)
          : undefined
  const pay =
    q.pay === 'package'
      ? eq(bookings.paidWith, 'package')
      : q.pay === 'offline'
        ? exists(offlineOrder)
        : q.pay === 'wechat'
          ? and(eq(bookings.paidWith, 'order'), not(exists(offlineOrder)))
          : undefined
  return and(
    q.from ? gte(bookings.startsAt, q.from) : undefined,
    q.to ? lt(bookings.startsAt, q.to) : undefined,
    q.studentId ? eq(bookings.studentId, q.studentId) : undefined,
    q.coachId ? eq(slots.coachId, q.coachId) : undefined,
    q.lessonTypeId ? eq(bookings.lessonTypeId, q.lessonTypeId) : undefined,
    q.unmarked ? isNull(bookings.attendance) : undefined,
    q.source === 'staff'
      ? isNotNull(bookings.bookedByStaffId)
      : q.source === 'student'
        ? isNull(bookings.bookedByStaffId)
        : undefined,
    ofStudents(bookings.studentId, q.q),
    status,
    pay,
  )
}

export interface OrderFilters {
  from?: Date
  to?: Date
  status?: 'pending' | 'paid' | 'closed'
  studentId?: number
  kind?: 'class' | 'trial' | 'package'
  provider?: 'wechat' | 'offline'
  q?: string
  /** Only payments flagged for staff and not yet marked handled. */
  anomaly?: boolean
}

/** Orders that match, by when they were placed. */
export function orderWhere(q: OrderFilters): SQL | undefined {
  return and(
    q.from ? gte(orders.createdAt, q.from) : undefined,
    q.to ? lt(orders.createdAt, q.to) : undefined,
    q.status ? eq(orders.status, q.status) : undefined,
    q.studentId ? eq(orders.studentId, q.studentId) : undefined,
    q.kind ? eq(orders.kind, q.kind) : undefined,
    q.provider ? eq(orders.provider, q.provider) : undefined,
    q.anomaly ? openAnomaly : undefined,
    ofStudents(orders.studentId, q.q),
  )
}

/** A payment flagged for staff that no one has marked handled yet. */
export const openAnomaly = and(isNotNull(orders.anomaly), isNull(orders.anomalyHandledAt))

export interface RefundFilters {
  from?: Date
  to?: Date
  status?: (typeof refunds.$inferSelect)['status']
  provider?: 'wechat' | 'offline'
  q?: string
  /** Only refunds WeChat Pay reported as ABNORMAL. */
  abnormal?: boolean
}

/** Refunds that match, by when they were asked for, for a query that joins `orders`. */
export function refundWhere(q: RefundFilters): SQL | undefined {
  return and(
    q.from ? gte(refunds.createdAt, q.from) : undefined,
    q.to ? lt(refunds.createdAt, q.to) : undefined,
    q.status ? eq(refunds.status, q.status) : undefined,
    q.provider ? eq(orders.provider, q.provider) : undefined,
    q.abnormal ? eq(refunds.abnormal, true) : undefined,
    ofStudents(orders.studentId, q.q),
  )
}

export interface InvoiceFilters {
  from?: Date
  to?: Date
  status?: (typeof invoices.$inferSelect)['status']
  studentId?: number
  titleKind?: 'personal' | 'company'
  q?: string
}

/** Invoice requests that match, by when they were made. */
export function invoiceWhere(q: InvoiceFilters): SQL | undefined {
  return and(
    q.from ? gte(invoices.createdAt, q.from) : undefined,
    q.to ? lt(invoices.createdAt, q.to) : undefined,
    q.status ? eq(invoices.status, q.status) : undefined,
    q.studentId ? eq(invoices.studentId, q.studentId) : undefined,
    q.titleKind ? eq(invoices.titleKind, q.titleKind) : undefined,
    ofStudents(invoices.studentId, q.q),
  )
}
