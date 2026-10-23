import { type CatalogDto, formatYuan, type PaymentParamsDto } from '../../lib/shared'
import { api, errorMessage, showError } from '../../utils/api'
import { getCatalog, hasAgreed, setAgreed } from '../../utils/data'
import { yuan } from '../../utils/format'
import { payOrder } from '../../utils/pay'

interface ProductView {
  id: number
  name: string
  description: string
  lessonCount: number
  validity: string
  scope: string
  price: string
  original: string
  amount: number
  unit: string
  highlighted: boolean
}

Page({
  data: {
    state: 'loading' as 'loading' | 'ready' | 'error',
    error: '',
    emptyIcon: { name: 'wallet', size: '112rpx' },
    errorIcon: { name: 'error-circle', size: '112rpx' },
    products: [] as ProductView[],
    buying: 0,
    hasAgreement: false,
  },

  highlight: 0,
  lessonTypeId: 0,
  catalog: null as CatalogDto | null,

  onLoad(query: Record<string, string | undefined>) {
    this.highlight = Number(query.id ?? 0)
    this.lessonTypeId = Number(query.lessonTypeId ?? 0)
    this.load()
  },

  async load() {
    try {
      const catalog = await getCatalog(true)
      this.catalog = catalog
      const typeNames = new Map(catalog.lessonTypes.map((t) => [t.id, t.name]))
      const coachNames = new Map(catalog.coaches.map((c) => [c.id, c.name]))
      const products = catalog.packageProducts
        .filter((p) => !this.lessonTypeId || p.lessonTypeId === this.lessonTypeId)
        .map((p) => {
          const coaches = p.coachIds.map((id) => coachNames.get(id)).filter(Boolean)
          return {
            id: p.id,
            name: p.name,
            description: p.description,
            lessonCount: p.lessonCount,
            validity: `购买后 ${p.validityDays} 天内有效`,
            scope: `${typeNames.get(p.lessonTypeId) ?? ''} · ${coaches.length ? `限${coaches.join('、')}` : '全部教练'}`,
            price: yuan(p.price.price),
            original: p.price.originalPrice == null ? '' : yuan(p.price.originalPrice),
            amount: p.price.price,
            unit: `¥${formatYuan(Math.round(p.price.price / p.lessonCount))}/节`,
            highlighted: p.id === this.highlight,
          }
        })
      this.setData({
        state: 'ready',
        products,
        hasAgreement: Boolean(catalog.policies.agreement),
      })
    } catch (e) {
      this.setData({ state: 'error', error: errorMessage(e) })
    }
  },

  async buy(e: WechatMiniprogram.TouchEvent) {
    const product = this.data.products.find((p) => p.id === Number(e.currentTarget.dataset.id))
    if (!product || this.data.buying) return
    const needsAgreement = this.data.hasAgreement && !hasAgreed()
    const { confirm } = await wx.showModal({
      title: product.name,
      content: `${product.lessonCount} 节课，${product.validity}，共 ${product.price}。${
        needsAgreement ? '支付即表示你同意《用户协议》。' : ''
      }`,
      confirmText: '去支付',
    })
    if (!confirm) return
    if (needsAgreement) setAgreed()
    this.setData({ buying: product.id })
    try {
      const res = await api<{ orderId: number; payment: PaymentParamsDto }>(
        'POST',
        '/packages/purchase',
        { productId: product.id },
      )
      const result = await payOrder(res.orderId, product.amount, res.payment)
      if (result === 'paid') {
        wx.redirectTo({
          url: '/pages/my-packages/index',
          success: () => wx.showToast({ title: '购买成功', icon: 'success' }),
        })
      } else if (result === 'pending') {
        wx.showModal({
          title: '支付结果确认中',
          content: '如已完成支付，课时包稍后会出现在“我的课时包”中。',
          showCancel: false,
        })
      }
    } catch (err) {
      showError(err)
    } finally {
      this.setData({ buying: 0 })
    }
  },

  openAgreement() {
    wx.navigateTo({ url: '/pages/policy/index?kind=agreement' })
  },

  retry() {
    this.setData({ state: 'loading' })
    this.load()
  },
})
