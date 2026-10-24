import {
  invoiceStatusLabels,
  invoiceTitleKindLabels,
  offlineMethodLabels,
  orderKindLabels,
  venueInstant,
  venueParts,
} from '@rs/shared'
import { and, asc, eq, gt, gte, inArray, like, lt, lte, or, type SQL } from 'drizzle-orm'
import type { Q } from '../db/client'
import {
  bookings,
  coaches,
  invoices,
  lessonTypes,
  orders,
  packages,
  refunds,
  slots,
  staff,
  students,
} from '../db/schema'
import { ApiError } from '../errors'
import { countsForPay, payRateLookup } from './coach-pay'
import { flaggedIds } from './invoices'
import { getSettings } from './settings'
import { grantedLessons, packageStatus } from './views'

export const exportKinds = {
  students: '学员',
  bookings: '预约',
  orders: '订单',
  refunds: '退款',
  packages: '课时包余额',
  invoices: '发票',
} as const

export type ExportKind = keyof typeof exportKinds

export interface ExportQuery {
  /** Venue dates, both included. */
  from: string
  to: string
  status?: string
  coachId?: number
  q?: string
  /** Invoices only: those with a refund after them that staff have not marked handled. */
  flagged?: boolean
}

type Cell = string | number | null
type Table = { header: string[]; rows: Cell[][] }

// The most rows one file holds; a longer range is refused rather than cut short.
const MAX_ROWS = 50_000
const MAX_DAYS = 366

const bookingStatusText = {
  pending_payment: '待支付',
  confirmed: '已预约',
  completed: '已完成',
  cancelled: '已取消',
  expired: '已超时',
} as const
const orderStatusText = { pending: '待支付', paid: '已支付', closed: '已关闭' } as const
const refundStatusText = {
  requested: '待审核',
  pending: '退款中',
  processing: '退款中',
  succeeded: '已退款',
  failed: '退款失败',
  rejected: '已拒绝',
} as const
const packageStatusText = {
  active: '使用中',
  expired: '已过期',
  used_up: '已用完',
  refund_requested: '退款审核中',
  refunded: '已退款',
} as const

const DELETED = '已注销学员'

/** Venue time as 2026-10-24 18:00, or empty. */
function venueTime(d: Date | null) {
  if (!d) return ''
  const p = venueParts(d)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hours)}:${pad(p.minutes)}`
}

/** Fen as yuan with two decimals, so spreadsheets read it as a number. */
function yuanCell(fen: number | null) {
  if (fen === null) return ''
  const sign = fen < 0 ? '-' : ''
  const abs = Math.abs(fen)
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

/** A coach's pay for one lesson, or 未设置 when the coach's category has no rate for it. */
function payCell(rate: number | null) {
  return rate === null ? '未设置' : yuanCell(rate)
}

function cell(v: Cell) {
  let s = v === null ? '' : String(v)
  // A student can type a name such as =HYPERLINK(...); spreadsheets must not run it.
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** A UTF-8 CSV with a BOM, so Excel shows the Chinese text correctly. */
export function toCsv(t: Table) {
  return `﻿${[t.header, ...t.rows].map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`
}

function range(q: ExportQuery) {
  let from: Date
  let to: Date
  try {
    from = venueInstant(q.from, 0)
    to = venueInstant(q.to, 24 * 60)
  } catch {
    throw new ApiError(400, 'invalid_query', '请选择正确的日期')
  }
  if (to <= from) throw new ApiError(400, 'invalid_query', '结束日期不能早于开始日期')
  if (to.getTime() - from.getTime() > MAX_DAYS * 86_400_000) {
    throw new ApiError(400, 'invalid_query', '一次最多导出一年')
  }
  return { from, to }
}

function person(s: { name: string; phone: string; deletedAt: Date | null } | undefined) {
  if (!s) return ['', '']
  return s.deletedAt ? [DELETED, ''] : [s.name, s.phone]
}

function studentsById(tx: Q, ids: number[]) {
  const unique = [...new Set(ids)]
  const map = new Map<number, { name: string; phone: string; deletedAt: Date | null }>()
  // In chunks, to stay under SQLite's limit on bound parameters.
  for (let i = 0; i < unique.length; i += 500) {
    for (const s of tx
      .select({
        id: students.id,
        name: students.name,
        phone: students.phone,
        deletedAt: students.deletedAt,
      })
      .from(students)
      .where(inArray(students.id, unique.slice(i, i + 500)))
      .all()) {
      map.set(s.id, s)
    }
  }
  return map
}

function checkSize(n: number) {
  if (n > MAX_ROWS) throw new ApiError(400, 'too_many_rows', '数据太多，请缩短日期范围')
}

function studentsTable(tx: Q, q: ExportQuery, now: Date): Table {
  const { from, to } = range(q)
  const pattern = q.q ? `%${q.q.replace(/[%_]/g, '')}%` : null
  const rows = tx
    .select()
    .from(students)
    .where(
      and(
        gte(students.createdAt, from),
        lt(students.createdAt, to),
        pattern ? or(like(students.name, pattern), like(students.phone, pattern)) : undefined,
      ),
    )
    .orderBy(asc(students.id))
    .limit(MAX_ROWS + 1)
    .all()
  checkSize(rows.length)
  const ids = rows.map((r) => r.id)
  const remaining = new Map<number, number>()
  for (let i = 0; i < ids.length; i += 500) {
    for (const p of tx
      .select({
        studentId: packages.studentId,
        lessonsRemaining: packages.lessonsRemaining,
        status: packages.status,
        expiresAt: packages.expiresAt,
      })
      .from(packages)
      .where(inArray(packages.studentId, ids.slice(i, i + 500)))
      .all()) {
      if (p.status === 'active' && p.expiresAt > now) {
        remaining.set(p.studentId, (remaining.get(p.studentId) ?? 0) + p.lessonsRemaining)
      }
    }
  }
  return {
    header: ['学员ID', '姓名', '手机号', '注册时间', '状态', '测试学员', '剩余课时'],
    rows: rows.map((s) => [
      s.id,
      ...person(s),
      venueTime(s.createdAt),
      s.deletedAt ? '已注销' : '正常',
      s.tester ? '是' : '否',
      remaining.get(s.id) ?? 0,
    ]),
  }
}

function bookingsTable(tx: Q, q: ExportQuery, now: Date): Table {
  const { from, to } = range(q)
  const status: SQL | undefined =
    q.status === 'confirmed'
      ? and(eq(bookings.status, 'confirmed'), gt(bookings.endsAt, now))
      : q.status === 'completed'
        ? and(eq(bookings.status, 'confirmed'), lte(bookings.endsAt, now))
        : q.status
          ? eq(bookings.status, q.status as (typeof bookings.$inferSelect)['status'])
          : undefined
  const rows = tx
    .select({
      b: bookings,
      coachId: slots.coachId,
      coach: coaches.name,
      lesson: lessonTypes.name,
      packageName: packages.name,
      bookedBy: staff.name,
      orderProvider: orders.provider,
      offlineMethod: orders.offlineMethod,
    })
    .from(bookings)
    .innerJoin(slots, eq(slots.id, bookings.slotId))
    .innerJoin(coaches, eq(coaches.id, slots.coachId))
    .innerJoin(lessonTypes, eq(lessonTypes.id, bookings.lessonTypeId))
    .leftJoin(packages, eq(packages.id, bookings.packageId))
    .leftJoin(staff, eq(staff.id, bookings.bookedByStaffId))
    .leftJoin(orders, eq(orders.bookingId, bookings.id))
    .where(
      and(
        gte(bookings.startsAt, from),
        lt(bookings.startsAt, to),
        q.coachId ? eq(slots.coachId, q.coachId) : undefined,
        status,
      ),
    )
    .orderBy(asc(bookings.startsAt), asc(bookings.id))
    .limit(MAX_ROWS + 1)
    .all()
  checkSize(rows.length)
  const people = studentsById(
    tx,
    rows.map((r) => r.b.studentId),
  )
  const payRules = getSettings(tx).pay
  const rateOf = payRateLookup(tx)
  return {
    header: [
      '预约ID',
      '上课时间',
      '下课时间',
      '教练',
      '课程',
      '学员',
      '手机号',
      '状态',
      '支付',
      '金额（元）',
      '课时包',
      '代约员工',
      '签到',
      '取消时间',
      '取消方',
      '取消原因',
      '课时费（元）',
    ],
    rows: rows.map(({ b, ...r }) => {
      const shown = b.status === 'confirmed' && b.endsAt <= now ? 'completed' : b.status
      const pay =
        b.paidWith === 'package'
          ? '课时包'
          : r.orderProvider === 'offline'
            ? `线下${r.offlineMethod ? `（${offlineMethodLabels[r.offlineMethod]}）` : ''}`
            : b.price === 0
              ? '免费'
              : '微信支付'
      return [
        b.id,
        venueTime(b.startsAt),
        venueTime(b.endsAt),
        r.coach,
        r.lesson,
        ...person(people.get(b.studentId)),
        bookingStatusText[shown],
        pay,
        yuanCell(b.price),
        r.packageName ?? '',
        r.bookedBy ?? '',
        b.attendance === 'attended' ? '已到课' : b.attendance === 'no_show' ? '缺席' : '',
        venueTime(b.cancelledAt),
        b.cancelledBy === 'venue' ? '场馆' : b.cancelledBy === 'student' ? '学员' : '',
        b.cancelReason ?? '',
        countsForPay(b, payRules, now) ? payCell(rateOf(r.coachId, b.lessonTypeId)) : '',
      ]
    }),
  }
}

function refundedByOrder(tx: Q, orderIds: number[]) {
  const map = new Map<number, number>()
  for (let i = 0; i < orderIds.length; i += 500) {
    for (const r of tx
      .select({ orderId: refunds.orderId, amount: refunds.amount })
      .from(refunds)
      .where(
        and(inArray(refunds.orderId, orderIds.slice(i, i + 500)), eq(refunds.status, 'succeeded')),
      )
      .all()) {
      map.set(r.orderId, (map.get(r.orderId) ?? 0) + r.amount)
    }
  }
  return map
}

function channel(o: { provider: 'wechat' | 'offline'; offlineMethod: string | null }) {
  if (o.provider === 'wechat') return '微信支付'
  const method = o.offlineMethod as keyof typeof offlineMethodLabels | null
  return method ? `线下（${offlineMethodLabels[method]}）` : '线下'
}

function ordersTable(tx: Q, q: ExportQuery): Table {
  const { from, to } = range(q)
  const rows = tx
    .select()
    .from(orders)
    .where(
      and(
        gte(orders.createdAt, from),
        lt(orders.createdAt, to),
        q.status ? eq(orders.status, q.status as 'pending' | 'paid' | 'closed') : undefined,
      ),
    )
    .orderBy(asc(orders.createdAt), asc(orders.id))
    .limit(MAX_ROWS + 1)
    .all()
  checkSize(rows.length)
  const people = studentsById(
    tx,
    rows.map((r) => r.studentId),
  )
  const refunded = refundedByOrder(
    tx,
    rows.map((r) => r.id),
  )
  return {
    header: [
      '订单ID',
      '商户订单号',
      '下单时间',
      '支付时间',
      '学员',
      '手机号',
      '类型',
      '内容',
      '金额（元）',
      '已退款（元）',
      '支付渠道',
      '微信支付单号',
      '状态',
      '备注',
    ],
    rows: rows.map((o) => [
      o.id,
      o.outTradeNo,
      venueTime(o.createdAt),
      venueTime(o.paidAt),
      ...person(people.get(o.studentId)),
      orderKindLabels[o.kind],
      o.description,
      yuanCell(o.amount),
      yuanCell(refunded.get(o.id) ?? 0),
      channel(o),
      o.transactionId ?? '',
      orderStatusText[o.status],
      o.note,
    ]),
  }
}

function refundsTable(tx: Q, q: ExportQuery): Table {
  const { from, to } = range(q)
  const rows = tx
    .select({ r: refunds, o: orders })
    .from(refunds)
    .innerJoin(orders, eq(orders.id, refunds.orderId))
    .where(
      and(
        gte(refunds.createdAt, from),
        lt(refunds.createdAt, to),
        q.status
          ? eq(refunds.status, q.status as (typeof refunds.$inferSelect)['status'])
          : undefined,
      ),
    )
    .orderBy(asc(refunds.createdAt), asc(refunds.id))
    .limit(MAX_ROWS + 1)
    .all()
  checkSize(rows.length)
  const people = studentsById(
    tx,
    rows.map((r) => r.o.studentId),
  )
  return {
    header: [
      '退款ID',
      '申请时间',
      '更新时间',
      '学员',
      '手机号',
      '订单ID',
      '订单内容',
      '订单金额（元）',
      '退款金额（元）',
      '原因',
      '渠道',
      '状态',
      '备注',
    ],
    rows: rows.map(({ r, o }) => [
      r.id,
      venueTime(r.createdAt),
      venueTime(r.updatedAt),
      ...person(people.get(o.studentId)),
      o.id,
      o.description,
      yuanCell(o.amount),
      yuanCell(r.amount),
      r.reason,
      channel(o),
      o.provider === 'offline' && r.status === 'pending'
        ? '待线下退还'
        : refundStatusText[r.status],
      r.failure ?? '',
    ]),
  }
}

function packagesTable(tx: Q, q: ExportQuery, now: Date): Table {
  const { from, to } = range(q)
  const rows = tx
    .select({ p: packages, lesson: lessonTypes.name })
    .from(packages)
    .innerJoin(lessonTypes, eq(lessonTypes.id, packages.lessonTypeId))
    .where(and(gte(packages.createdAt, from), lt(packages.createdAt, to)))
    .orderBy(asc(packages.createdAt), asc(packages.id))
    .all()
    // The status depends on the time and the lessons left, so it is filtered here, before the
    // size check: a few refund requests in a busy year still export.
    .filter(({ p }) => !q.status || packageStatus(p, now) === q.status)
  checkSize(rows.length)
  const people = studentsById(
    tx,
    rows.map((r) => r.p.studentId),
  )
  const granted = new Map<number, number>()
  const ids = rows.map((r) => r.p.id)
  for (let i = 0; i < ids.length; i += 500) {
    for (const [k, v] of grantedLessons(tx, ids.slice(i, i + 500))) granted.set(k, v)
  }
  return {
    header: [
      '课时包ID',
      '学员',
      '手机号',
      '名称',
      '课程',
      '购买时间',
      '到期时间',
      '购买课时',
      '赠送课时',
      '剩余课时',
      '实付（元）',
      '状态',
    ],
    rows: rows.map(({ p, lesson }) => [
      p.id,
      ...person(people.get(p.studentId)),
      p.name,
      lesson,
      venueTime(p.createdAt),
      venueTime(p.expiresAt),
      p.lessonsPurchased,
      granted.get(p.id) ?? 0,
      p.lessonsRemaining,
      yuanCell(p.pricePaid),
      packageStatusText[packageStatus(p, now)],
    ]),
  }
}

function invoicesTable(tx: Q, q: ExportQuery): Table {
  const { from, to } = range(q)
  const all = tx
    .select({ i: invoices, o: orders })
    .from(invoices)
    .innerJoin(orders, eq(orders.id, invoices.orderId))
    .where(
      and(
        gte(invoices.createdAt, from),
        lt(invoices.createdAt, to),
        q.status
          ? eq(invoices.status, q.status as (typeof invoices.$inferSelect)['status'])
          : undefined,
      ),
    )
    .orderBy(asc(invoices.createdAt), asc(invoices.id))
    .all()
  const flagged = flaggedIds(
    tx,
    all.map((r) => r.i),
  )
  const rows = q.flagged ? all.filter((r) => flagged.has(r.i.id)) : all
  checkSize(rows.length)
  const people = studentsById(
    tx,
    rows.map((r) => r.i.studentId),
  )
  return {
    header: [
      '申请ID',
      '申请时间',
      '开票时间',
      '学员',
      '手机号',
      '订单ID',
      '订单内容',
      '开票金额（元）',
      '抬头类型',
      '抬头',
      '税号',
      '邮箱',
      '状态',
      '拒绝原因',
      '开票后有退款',
    ],
    rows: rows.map(({ i, o }) => [
      i.id,
      venueTime(i.createdAt),
      venueTime(i.issuedAt),
      ...person(people.get(i.studentId)),
      o.id,
      o.description,
      yuanCell(i.amount),
      invoiceTitleKindLabels[i.titleKind],
      i.title,
      i.taxNumber,
      i.email,
      invoiceStatusLabels[i.status],
      i.rejectReason ?? '',
      flagged.has(i.id) ? '是' : '',
    ]),
  }
}

/** Builds one export as CSV text, with its row count for the action log. */
export function buildExport(tx: Q, kind: ExportKind, q: ExportQuery, now: Date) {
  const table =
    kind === 'students'
      ? studentsTable(tx, q, now)
      : kind === 'bookings'
        ? bookingsTable(tx, q, now)
        : kind === 'orders'
          ? ordersTable(tx, q)
          : kind === 'refunds'
            ? refundsTable(tx, q)
            : kind === 'packages'
              ? packagesTable(tx, q, now)
              : invoicesTable(tx, q)
  return { csv: toCsv(table), rows: table.rows.length }
}

/** The filters an export used, in words for the action log. Never the search text itself. */
export function describeExport(tx: Q, kind: ExportKind, q: ExportQuery) {
  const statusText: Record<ExportKind, Record<string, string>> = {
    students: {},
    bookings: bookingStatusText,
    orders: orderStatusText,
    refunds: refundStatusText,
    packages: packageStatusText,
    invoices: invoiceStatusLabels,
  }
  const parts = [`${q.from} 至 ${q.to}`]
  if (q.status) parts.push(`状态：${statusText[kind][q.status] ?? q.status}`)
  if (q.coachId) {
    const coach = tx
      .select({ name: coaches.name })
      .from(coaches)
      .where(eq(coaches.id, q.coachId))
      .get()
    parts.push(`教练：${coach?.name ?? q.coachId}`)
  }
  if (q.q) parts.push('按搜索词筛选')
  if (q.flagged) parts.push('开票后有退款')
  return `导出${exportKinds[kind]}（${parts.join('，')}）`
}
