import type { PackageDto } from '../../lib/shared'
import { api, errorMessage, refreshAfter, serverNow, showError } from '../../utils/api'
import { getCatalog } from '../../utils/data'
import { edgeWait } from '../../utils/edge'
import { fullDate, yuan } from '../../utils/format'
import { INVOICE_STATE, invoiceLink, openInvoice } from '../../utils/invoice'
import { packageTag, refundStatus } from '../../utils/labels'
import { navigateOnce } from '../../utils/nav'
import { ask } from '../../utils/tap'

interface PackageView {
  id: number
  name: string
  lessonTypeName: string
  remaining: number
  total: number
  percent: number
  expires: string
  status: string
  tone: 'primary' | 'warning' | 'default'
  active: boolean
  refund: string
  /** Bought at the front desk, so a refund is handed back there. */
  paidOffline: boolean
  /** A lesson booked with it is still to come. */
  inUse: boolean
  canRefund: boolean
  invoice: string
  invoiceLink: string
}

function view(p: PackageDto): PackageView {
  const tag = packageTag(p)
  return {
    id: p.id,
    name: p.name,
    lessonTypeName: p.lessonTypeName,
    remaining: p.lessonsRemaining,
    total: p.lessonsPurchased + p.lessonsGranted,
    percent: Math.min(
      100,
      Math.round((p.lessonsRemaining / Math.max(1, p.lessonsPurchased + p.lessonsGranted)) * 100),
    ),
    // Valid through the day before the instant it expires, as admin shows it.
    // A refunded one no longer runs out.
    expires:
      p.status === 'refunded'
        ? ''
        : `${fullDate(new Date(new Date(p.expiresAt).getTime() - 1))}${p.status === 'expired' ? '已过期' : '到期'}`,
    // A refunded one says where its money stands, as its refund row does.
    status: tag.text,
    tone:
      p.status === 'active'
        ? 'primary'
        : p.status === 'refund_requested' || !tag.settled
          ? 'warning'
          : 'default',
    active: p.status === 'active',
    refund: p.refund
      ? `退款 ${yuan(p.refund.amount)} · ${refundStatus(p.refund, p.paidOffline)}`
      : '',
    paidOffline: p.paidOffline,
    inUse: p.inUse,
    // Free packages (gifts) have nothing to refund.
    canRefund: p.status === 'active' && p.lessonsRemaining > 0 && p.pricePaid > 0,
    invoice:
      p.invoice?.state === 'requested' || p.invoice?.state === 'issued'
        ? `发票${INVOICE_STATE[p.invoice.state]}`
        : '',
    invoiceLink: invoiceLink(p.invoice),
  }
}

Page({
  data: {
    state: 'loading' as 'loading' | 'ready' | 'error',
    error: '',
    emptyIcon: { name: 'wallet', size: '112rpx' },
    errorIcon: { name: 'error-circle', size: '112rpx' },
    packages: [] as PackageView[],
    packagesEnabled: false,
    busy: 0,
  },

  raw: [] as PackageDto[],
  edgeTimer: 0 as number,
  hidden: false,

  onShow() {
    this.hidden = false
    this.load()
  },

  onHide() {
    this.hidden = true
    this.clearEdge()
  },

  onUnload() {
    this.hidden = true
    this.clearEdge()
  },

  /** Loads the list again just after a package in use runs out, so 使用中 and 申请退款 go. */
  scheduleEdge(packages: PackageDto[]) {
    this.clearEdge()
    if (this.hidden) return
    const wait = edgeWait(
      packages.filter((p) => p.status === 'active').map((p) => Date.parse(p.expiresAt)),
      serverNow(),
    )
    if (wait === null) return
    this.edgeTimer = setTimeout(() => {
      this.edgeTimer = 0
      if (!this.hidden && this.data.state === 'ready' && !this.data.busy) void this.load()
    }, wait) as unknown as number
  },

  clearEdge() {
    if (this.edgeTimer) clearTimeout(this.edgeTimer)
    this.edgeTimer = 0
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh())
  },

  async load() {
    try {
      const [packages, catalog] = await Promise.all([
        api<PackageDto[]>('GET', '/packages'),
        getCatalog(),
      ])
      this.raw = packages
      this.setData({
        state: 'ready',
        packages: packages.map(view),
        packagesEnabled: catalog.payment.packagesEnabled,
      })
      this.scheduleEdge(packages)
    } catch (e) {
      // A failed refresh keeps what is on screen.
      if (this.data.state === 'ready') showError(e)
      else this.setData({ state: 'error', error: errorMessage(e) })
    }
  },

  async requestRefund(e: WechatMiniprogram.TouchEvent) {
    const pkg = this.data.packages.find((p) => p.id === Number(e.currentTarget.dataset.id))
    if (!pkg || this.data.busy) return
    // Said before asking, rather than refused after the student confirms.
    if (pkg.inUse) {
      // Once for a double tap.
      void ask({
        title: '暂不能退款',
        content: '还有用这个课时包预约且未结束的课，请在课程结束或取消预约后再申请退款。',
        showCancel: false,
      })
      return
    }
    const answer = await ask({
      title: '申请退款',
      content: `剩余 ${pkg.remaining} 节。退款金额为实付金额扣除已上课时的单节价（按授课教练计算），由场馆审核后${pkg.paidOffline ? '到店退还' : '原路退回'}，申请后课时包将暂停使用。`,
      confirmText: '提交申请',
    })
    if (!answer?.confirm || this.data.busy) return
    this.setData({ busy: pkg.id })
    try {
      await api('POST', `/packages/${pkg.id}/refund-request`)
      wx.showToast({ title: '已提交', icon: 'success' })
      await this.load()
    } catch (err) {
      // Refused because the package changed meanwhile (a request open already, used up, paused or
      // refunded): show where it stands now, then why.
      if (refreshAfter(err)) await this.load()
      showError(err)
    } finally {
      this.setData({ busy: 0 })
    }
  },

  openInvoice(e: WechatMiniprogram.TouchEvent) {
    openInvoice(this.raw.find((p) => p.id === Number(e.currentTarget.dataset.id))?.invoice ?? null)
  },

  buy() {
    navigateOnce('/pages/packages/index')
  },

  retry() {
    this.setData({ state: 'loading' })
    this.load()
  },
})
