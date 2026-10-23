import type { InvoiceOrderDto, StudentInvoicesDto } from '../../lib/shared'
import { api, errorMessage } from '../../utils/api'
import { fullDate, yuan } from '../../utils/format'
import { INVOICE_STATE, invoiceLink, openInvoice } from '../../utils/invoice'

const KIND = { class: '单次课', trial: '体验课', package: '课时包' } as const

interface OrderView {
  orderId: number
  title: string
  meta: string
  state: string
  tone: 'primary' | 'warning' | 'success' | 'default'
  note: string
  link: string
  dim: boolean
}

function view(o: InvoiceOrderDto): OrderView {
  const notes: Partial<Record<InvoiceOrderDto['state'], string>> = {
    requested: '场馆开具后会发送到你的邮箱',
    rejected: o.rejectReason ? `原因：${o.rejectReason}` : '',
    refunding: '退款完成后可按剩余金额申请',
    refunded: '已全额退款，不能开票',
  }
  return {
    orderId: o.orderId,
    title: o.description === KIND[o.kind] ? o.description : `${KIND[o.kind]} · ${o.description}`,
    meta: `${fullDate(o.paidAt)}支付 · 可开票 ${yuan(o.amount)}`,
    state: INVOICE_STATE[o.state],
    tone:
      o.state === 'issued'
        ? 'success'
        : o.state === 'requested'
          ? 'primary'
          : o.state === 'rejected'
            ? 'warning'
            : 'default',
    note: notes[o.state] ?? '',
    link: invoiceLink(o),
    dim: o.state === 'refunded',
  }
}

Page({
  data: {
    state: 'loading' as 'loading' | 'ready' | 'error',
    error: '',
    emptyIcon: { name: 'bill', size: '112rpx' },
    errorIcon: { name: 'error-circle', size: '112rpx' },
    orders: [] as OrderView[],
  },

  raw: [] as InvoiceOrderDto[],

  onShow() {
    this.load()
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh())
  },

  async load() {
    try {
      const { orders } = await api<StudentInvoicesDto>('GET', '/invoices')
      this.raw = orders
      this.setData({ state: 'ready', orders: orders.map(view) })
    } catch (e) {
      this.setData({ state: 'error', error: errorMessage(e) })
    }
  },

  open(e: WechatMiniprogram.TouchEvent) {
    openInvoice(this.raw.find((o) => o.orderId === Number(e.currentTarget.dataset.id)) ?? null)
  },

  retry() {
    this.setData({ state: 'loading' })
    this.load()
  },
})
