import type { PackageDto } from '../../lib/shared'
import { api, errorMessage, showError } from '../../utils/api'
import { getCatalog } from '../../utils/data'
import { fullDate, yuan } from '../../utils/format'
import { PACKAGE_STATUS, REFUND_STATUS } from '../../utils/labels'

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
  canRefund: boolean
}

function view(p: PackageDto): PackageView {
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
    expires: `${fullDate(p.expiresAt)}${p.status === 'expired' ? '已过期' : '到期'}`,
    status: PACKAGE_STATUS[p.status],
    tone:
      p.status === 'active' ? 'primary' : p.status === 'refund_requested' ? 'warning' : 'default',
    active: p.status === 'active',
    refund: p.refund ? `退款 ${yuan(p.refund.amount)} · ${REFUND_STATUS[p.refund.status]}` : '',
    // Free packages (gifts) have nothing to refund.
    canRefund: p.status === 'active' && p.lessonsRemaining > 0 && p.pricePaid > 0,
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

  onShow() {
    this.load()
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
      this.setData({
        state: 'ready',
        packages: packages.map(view),
        packagesEnabled: catalog.payment.packagesEnabled,
      })
    } catch (e) {
      this.setData({ state: 'error', error: errorMessage(e) })
    }
  },

  async requestRefund(e: WechatMiniprogram.TouchEvent) {
    const pkg = this.data.packages.find((p) => p.id === Number(e.currentTarget.dataset.id))
    if (!pkg || this.data.busy) return
    const { confirm } = await wx.showModal({
      title: '申请退款',
      content: `剩余 ${pkg.remaining} 节。退款金额为实付金额扣除已上课时的单节价（按授课教练计），由场馆审核后原路退回，申请后课时包将暂停使用。`,
      confirmText: '提交申请',
    })
    if (!confirm) return
    this.setData({ busy: pkg.id })
    try {
      await api('POST', `/packages/${pkg.id}/refund-request`)
      wx.showToast({ title: '已提交', icon: 'success' })
      await this.load()
    } catch (err) {
      showError(err)
    } finally {
      this.setData({ busy: 0 })
    }
  },

  buy() {
    wx.navigateTo({ url: '/pages/packages/index' })
  },

  retry() {
    this.setData({ state: 'loading' })
    this.load()
  },
})
