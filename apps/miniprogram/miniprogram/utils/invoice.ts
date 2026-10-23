import type { InvoiceState, OrderInvoiceDto } from '../lib/shared'
import { download, showError } from './api'
import { navigateOnce } from './nav'

export const INVOICE_STATE: Record<InvoiceState, string> = {
  available: '可开票',
  requested: '开票中',
  issued: '已开票',
  rejected: '未通过',
  refunding: '退款处理中',
  refunded: '已退款',
}

/** What tapping an order's invoice does: ask for one, open it, or nothing for now. */
export function invoiceAction(inv: OrderInvoiceDto | null): 'request' | 'view' | null {
  if (!inv) return null
  if (inv.state === 'available' || inv.state === 'rejected') return 'request'
  if (inv.state === 'issued') return 'view'
  return null
}

/** The link text for an order's invoice, or '' when there is nothing to do. */
export function invoiceLink(inv: OrderInvoiceDto | null): string {
  const action = invoiceAction(inv)
  if (action === 'view') return '查看发票'
  if (action === 'request') return inv?.state === 'rejected' ? '重新申请发票' : '开发票'
  return ''
}

let opening = false

/** Downloads the invoice PDF and shows it, with WeChat's menu to forward or save it. */
export async function openInvoicePdf(invoiceId: number): Promise<void> {
  if (opening) return
  opening = true
  wx.showLoading({ title: '正在打开', mask: true })
  try {
    const filePath = await download(`/invoices/${invoiceId}/pdf`)
    wx.hideLoading()
    await wx.openDocument({ filePath, fileType: 'pdf', showMenu: true })
  } catch (e) {
    wx.hideLoading()
    showError(e)
  } finally {
    opening = false
  }
}

/** Follows an order's invoice link. */
export function openInvoice(inv: OrderInvoiceDto | null): void {
  const action = invoiceAction(inv)
  if (!inv || !action) return
  if (action === 'view' && inv.invoiceId) void openInvoicePdf(inv.invoiceId)
  else navigateOnce(`/pages/invoice-request/index?orderId=${inv.orderId}`)
}
