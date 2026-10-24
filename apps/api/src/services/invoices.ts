import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type AdminInvoiceDto,
  type InvoiceOrderDto,
  type InvoiceState,
  type InvoiceStatus,
  type InvoiceTitle,
  invoiceTitleError,
  normalizeInvoiceTitle,
  type OrderInvoiceDto,
  type StudentInvoicesDto,
} from '@rs/shared'
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm'
import { immediate, type Q } from '../db/client'
import { invoices, orders, refunds, students } from '../db/schema'
import type { Deps } from '../deps'
import { ApiError, isUniqueViolation, notFound } from '../errors'
import { accountDeleted } from './account'

type OrderRow = typeof orders.$inferSelect
type InvoiceRow = typeof invoices.$inferSelect

// Refunds that are still on their way, including a package refund waiting for review and a
// failed one the venue still owes.
const OPEN_REFUNDS = ['requested', 'pending', 'processing', 'failed'] as const
const MAX_PDF_BYTES = 10 * 1024 * 1024

/**
 * Closes a request still waiting on an order that is now fully refunded: there is nothing left
 * to invoice, and an open request would hold up the student's account deletion. Run in the
 * transaction that settles a refund.
 */
export function closeRefundedRequests(tx: Q, orderId: number) {
  const order = tx
    .select({ amount: orders.amount })
    .from(orders)
    .where(eq(orders.id, orderId))
    .get()
  if (!order) return
  const refunded =
    tx
      .select({ total: sql<number | null>`sum(${refunds.amount})` })
      .from(refunds)
      .where(and(eq(refunds.orderId, orderId), eq(refunds.status, 'succeeded')))
      .get()?.total ?? 0
  if (order.amount - Number(refunded) > 0) return
  tx.update(invoices)
    .set({ status: 'rejected', rejectReason: '订单已全额退款' })
    .where(and(eq(invoices.orderId, orderId), eq(invoices.status, 'requested')))
    .run()
}

export const invoicesDir = (deps: Pick<Deps, 'uploadsDir'>) => join(deps.uploadsDir, 'invoices')

/** Refund totals per order: what went back, and whether more is still on its way. */
function refundTotals(tx: Q, orderIds: number[]) {
  const totals = new Map<number, { refunded: number; open: boolean }>()
  if (orderIds.length === 0) return totals
  const rows = tx
    .select({ orderId: refunds.orderId, amount: refunds.amount, status: refunds.status })
    .from(refunds)
    .where(inArray(refunds.orderId, orderIds))
    .all()
  for (const r of rows) {
    const t = totals.get(r.orderId) ?? { refunded: 0, open: false }
    if (r.status === 'succeeded') t.refunded += r.amount
    if ((OPEN_REFUNDS as readonly string[]).includes(r.status)) t.open = true
    totals.set(r.orderId, t)
  }
  return totals
}

/** The latest invoice request on each order. */
function latestInvoices(tx: Q, orderIds: number[]) {
  const map = new Map<number, InvoiceRow>()
  if (orderIds.length === 0) return map
  const rows = tx
    .select()
    .from(invoices)
    .where(inArray(invoices.orderId, orderIds))
    .orderBy(invoices.id)
    .all()
  for (const row of rows) map.set(row.orderId, row)
  return map
}

/**
 * Where each order stands for invoicing. Orders that were never paid, or paid nothing, have no
 * entry. A live request wins over refunds made later: the staff see those as a flag instead.
 */
export function orderInvoices(tx: Q, rows: OrderRow[]): Map<number, OrderInvoiceDto> {
  const paid = rows.filter((o) => o.status === 'paid' && o.amount > 0)
  const ids = paid.map((o) => o.id)
  const totals = refundTotals(tx, ids)
  const latest = latestInvoices(tx, ids)
  return new Map(
    paid.map((o) => {
      const t = totals.get(o.id) ?? { refunded: 0, open: false }
      const inv = latest.get(o.id)
      const amount = o.amount - t.refunded
      let state: InvoiceState
      if (inv?.status === 'requested' || inv?.status === 'issued') state = inv.status
      else if (t.open) state = 'refunding'
      else if (amount <= 0) state = 'refunded'
      else state = inv?.status === 'rejected' ? 'rejected' : 'available'
      return [
        o.id,
        {
          orderId: o.id,
          state,
          invoiceId: inv?.id ?? null,
          // A live invoice is for what it was issued for; otherwise what is left to invoice.
          amount: inv && (state === 'requested' || state === 'issued') ? inv.amount : amount,
          rejectReason: inv?.status === 'rejected' ? inv.rejectReason : null,
        },
      ]
    }),
  )
}

export function studentInvoices(tx: Q, studentId: number): StudentInvoicesDto {
  const rows = tx
    .select()
    .from(orders)
    .where(and(eq(orders.studentId, studentId), eq(orders.status, 'paid')))
    .orderBy(desc(orders.paidAt), desc(orders.id))
    .all()
  const states = orderInvoices(tx, rows)
  const student = tx
    .select({ invoiceTitle: students.invoiceTitle })
    .from(students)
    .where(eq(students.id, studentId))
    .get()
  return {
    orders: rows.flatMap((o): InvoiceOrderDto[] => {
      const s = states.get(o.id)
      return s
        ? [
            {
              ...s,
              description: o.description,
              kind: o.kind,
              paidAt: (o.paidAt ?? o.createdAt).toISOString(),
            },
          ]
        : []
    }),
    lastTitle: student?.invoiceTitle ?? null,
  }
}

/**
 * Asks for an invoice on one of the student's paid orders, and remembers the title for next
 * time. Repeating the same request returns the one already made.
 */
export function requestInvoice(
  deps: Deps,
  studentId: number,
  orderId: number,
  input: InvoiceTitle,
): number {
  const title = normalizeInvoiceTitle(input)
  const error = invoiceTitleError(title)
  if (error) throw new ApiError(400, 'invalid_body', error)
  const now = deps.now()
  return immediate(deps.db, (tx) => {
    const student = tx.select().from(students).where(eq(students.id, studentId)).get()
    if (!student) throw notFound('用户')
    if (student.deletedAt) throw accountDeleted()
    const order = tx.select().from(orders).where(eq(orders.id, orderId)).get()
    if (!order || order.studentId !== studentId) throw notFound('订单')
    const state = orderInvoices(tx, [order]).get(order.id)
    if (!state) throw new ApiError(409, 'not_invoiceable', '该订单没有可开票的金额')
    if (state.state === 'requested' || state.state === 'issued') {
      const live = tx
        .select()
        .from(invoices)
        .where(eq(invoices.id, state.invoiceId ?? 0))
        .get()
      const same =
        live?.status === 'requested' &&
        live.titleKind === title.kind &&
        live.title === title.name &&
        live.taxNumber === title.taxNumber &&
        live.email === title.email
      if (live && same) return live.id
      throw new ApiError(409, 'invoice_exists', '该订单已申请发票')
    }
    if (state.state === 'refunding') {
      throw new ApiError(409, 'refund_open', '该订单有退款在处理，完成后再申请')
    }
    if (state.state === 'refunded') {
      throw new ApiError(409, 'order_refunded', '已退款的订单不能开票')
    }
    tx.update(students).set({ invoiceTitle: title }).where(eq(students.id, studentId)).run()
    try {
      return tx
        .insert(invoices)
        .values({
          studentId,
          orderId,
          status: 'requested',
          titleKind: title.kind,
          title: title.name,
          taxNumber: title.taxNumber,
          email: title.email,
          amount: state.amount,
          refundSeenId: lastRefundId(tx, orderId),
          createdAt: now,
        })
        .returning({ id: invoices.id })
        .get().id
    } catch (e) {
      if (isUniqueViolation(e)) throw new ApiError(409, 'invoice_exists', '该订单已申请发票')
      throw e
    }
  })
}

/**
 * The newest refund on an order, rejected ones included. An invoice remembers it when issued or
 * when staff mark a refund handled, so only refunds after that flag it. Ids only grow, so a
 * refund rejected after it was seen cannot hide a later one, as a count would.
 */
function lastRefundId(tx: Q, orderId: number) {
  return (
    tx
      .select({ id: sql<number | null>`max(${refunds.id})` })
      .from(refunds)
      .where(eq(refunds.orderId, orderId))
      .get()?.id ?? 0
  )
}

/** Invoices whose order had a refund, not rejected, that staff have not marked handled. */
export function flaggedIds(tx: Q, rows: InvoiceRow[]) {
  const live = rows.filter((r) => r.status !== 'rejected')
  if (live.length === 0) return new Set<number>()
  const newest = new Map(
    tx
      .select({ orderId: refunds.orderId, id: sql<number>`max(${refunds.id})` })
      .from(refunds)
      .where(
        and(
          inArray(
            refunds.orderId,
            live.map((r) => r.orderId),
          ),
          ne(refunds.status, 'rejected'),
        ),
      )
      .groupBy(refunds.orderId)
      .all()
      .map((r) => [r.orderId, Number(r.id)]),
  )
  return new Set(live.filter((r) => (newest.get(r.orderId) ?? 0) > r.refundSeenId).map((r) => r.id))
}

export function adminInvoices(
  tx: Q,
  q: {
    status?: InvoiceStatus
    flagged?: boolean
    studentId?: number
    limit?: number
    offset?: number
  },
): AdminInvoiceDto[] {
  const rows = tx
    .select()
    .from(invoices)
    .where(
      and(
        q.status ? eq(invoices.status, q.status) : undefined,
        q.studentId ? eq(invoices.studentId, q.studentId) : undefined,
      ),
    )
    // The queue is worked oldest first; finished ones read newest first.
    .orderBy(q.status === 'requested' ? invoices.id : desc(invoices.id))
    .all()
  const flagged = flaggedIds(tx, rows)
  // Flagged ones show however old; either list is cut to a page.
  const offset = q.offset ?? 0
  const shown = (q.flagged ? rows.filter((r) => flagged.has(r.id)) : rows).slice(
    offset,
    offset + Math.min(q.limit ?? 500, 500),
  )
  return invoiceViews(tx, shown, flagged)
}

function invoiceViews(tx: Q, rows: InvoiceRow[], flagged: Set<number>): AdminInvoiceDto[] {
  const orderIds = [...new Set(rows.map((r) => r.orderId))]
  const orderRows = new Map(
    orderIds.length
      ? tx
          .select()
          .from(orders)
          .where(inArray(orders.id, orderIds))
          .all()
          .map((o) => [o.id, o])
      : [],
  )
  const totals = refundTotals(tx, orderIds)
  const studentIds = [...new Set(rows.map((r) => r.studentId))]
  const people = new Map(
    studentIds.length
      ? tx
          .select()
          .from(students)
          .where(inArray(students.id, studentIds))
          .all()
          .map((s) => [
            s.id,
            s.deletedAt
              ? { id: s.id, name: '已注销学员', phone: '' }
              : { id: s.id, name: s.name, phone: s.phone },
          ])
      : [],
  )
  return rows.map((r) => {
    const o = orderRows.get(r.orderId)
    return {
      id: r.id,
      status: r.status,
      title: { kind: r.titleKind, name: r.title, taxNumber: r.taxNumber, email: r.email },
      amount: r.amount,
      createdAt: r.createdAt.toISOString(),
      issuedAt: r.issuedAt?.toISOString() ?? null,
      rejectReason: r.rejectReason,
      hasPdf: r.pdfFile !== null,
      order: {
        id: r.orderId,
        description: o?.description ?? '',
        kind: o?.kind ?? 'class',
        amount: o?.amount ?? 0,
        provider: o?.provider ?? 'wechat',
        paidAt: o?.paidAt?.toISOString() ?? null,
        refunded: totals.get(r.orderId)?.refunded ?? 0,
      },
      refundFlag: flagged.has(r.id),
      student: people.get(r.studentId) ?? { id: r.studentId, name: '', phone: '' },
    }
  })
}

export function adminInvoice(tx: Q, id: number): AdminInvoiceDto {
  const row = tx.select().from(invoices).where(eq(invoices.id, id)).get()
  if (!row) throw notFound('发票申请')
  return invoiceViews(tx, [row], flaggedIds(tx, [row]))[0] as AdminInvoiceDto
}

/** Whether the bytes are a PDF file, by its header rather than what the browser claimed. */
export function isPdf(bytes: Uint8Array) {
  return bytes.length > 5 && Buffer.from(bytes.subarray(0, 5)).toString('latin1') === '%PDF-'
}

/**
 * Records that staff issued the invoice and stores its PDF. Uploading again replaces the file,
 * for a wrong upload. Returns whether it was a replacement.
 */
export function issueInvoice(deps: Deps, staffId: number, id: number, pdf: Uint8Array) {
  if (pdf.length > MAX_PDF_BYTES) throw new ApiError(400, 'too_large', '文件不能超过 10MB')
  if (!isPdf(pdf)) throw new ApiError(400, 'bad_type', '请上传 PDF 格式的发票')
  const dir = invoicesDir(deps)
  const file = `${id}-${randomBytes(12).toString('hex')}.pdf`
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, file), pdf)
  const now = deps.now()
  let old: string | null = null
  try {
    const replaced = immediate(deps.db, (tx) => {
      const row = tx.select().from(invoices).where(eq(invoices.id, id)).get()
      if (!row) throw notFound('发票申请')
      if (row.status === 'rejected') {
        throw new ApiError(409, 'invoice_handled', '该申请已拒绝')
      }
      const student = tx.select().from(students).where(eq(students.id, row.studentId)).get()
      if (student?.deletedAt && row.titleKind === 'personal') throw accountDeleted()
      const order = tx.select().from(orders).where(eq(orders.id, row.orderId)).get()
      const t = refundTotals(tx, [row.orderId]).get(row.orderId) ?? { refunded: 0, open: false }
      const amount = (order?.amount ?? 0) - t.refunded
      if (row.status === 'requested') {
        if (t.open) throw new ApiError(409, 'refund_open', '该订单有退款在处理，完成后再开票')
        if (amount <= 0) throw new ApiError(409, 'order_refunded', '订单已全额退款，请拒绝该申请')
      }
      old = row.pdfFile
      tx.update(invoices)
        .set({
          status: 'issued',
          pdfFile: file,
          // A first issue is for what is left after refunds; a replacement keeps the amount.
          amount: row.status === 'requested' ? amount : row.amount,
          // Refunds so far are in that amount; only later ones flag the invoice.
          refundSeenId:
            row.status === 'requested' ? lastRefundId(tx, row.orderId) : row.refundSeenId,
          issuedAt: row.issuedAt ?? now,
          handledByStaffId: staffId,
        })
        .where(eq(invoices.id, id))
        .run()
      return row.status === 'issued'
    })
    if (old) rmSync(join(dir, old), { force: true })
    return replaced
  } catch (e) {
    rmSync(join(dir, file), { force: true })
    throw e
  }
}

/** Rejects a request with a reason the student sees. Returns false for a repeat. */
export function rejectInvoice(deps: Deps, staffId: number, id: number, reason: string) {
  return immediate(deps.db, (tx) => {
    const row = tx.select().from(invoices).where(eq(invoices.id, id)).get()
    if (!row) throw notFound('发票申请')
    if (row.status === 'rejected' && row.rejectReason === reason) return false
    if (row.status !== 'requested') throw new ApiError(409, 'invoice_handled', '该申请已处理')
    tx.update(invoices)
      .set({ status: 'rejected', rejectReason: reason, handledByStaffId: staffId })
      .where(eq(invoices.id, id))
      .run()
    return true
  })
}

/** Clears the refund flag once staff have dealt with it, say by voiding the invoice. */
export function markRefundSeen(deps: Deps, id: number) {
  return immediate(deps.db, (tx) => {
    const row = tx.select().from(invoices).where(eq(invoices.id, id)).get()
    if (!row) throw notFound('发票申请')
    if (!flaggedIds(tx, [row]).has(id)) return false
    tx.update(invoices)
      .set({ refundSeenId: lastRefundId(tx, row.orderId) })
      .where(eq(invoices.id, id))
      .run()
    return true
  })
}

/** The PDF of an issued invoice, for its student or (without one) for staff. */
export function invoicePdf(deps: Deps, id: number, studentId?: number) {
  const row = deps.db.select().from(invoices).where(eq(invoices.id, id)).get()
  if (!row || (studentId !== undefined && row.studentId !== studentId)) throw notFound('发票')
  if (row.status !== 'issued' || !row.pdfFile) throw notFound('发票')
  try {
    return readFileSync(join(invoicesDir(deps), row.pdfFile))
  } catch {
    throw notFound('发票文件')
  }
}

/** What the action log calls the invoice's order, without personal data. */
export function invoiceLabel(tx: Q, id: number) {
  const row = tx
    .select({ studentId: invoices.studentId, description: orders.description })
    .from(invoices)
    .innerJoin(orders, eq(orders.id, invoices.orderId))
    .where(eq(invoices.id, id))
    .get()
  return { what: `订单「${row?.description ?? ''}」`, studentId: row?.studentId ?? null }
}
