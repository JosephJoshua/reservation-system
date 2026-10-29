import { type CatalogDto, formatYuan, type MeDto, type PaymentParamsDto } from '../../lib/shared'
import { ApiError, api, errorMessage, showError } from '../../utils/api'
import { agreePolicies, askForNotices, getCatalog, getMe } from '../../utils/data'
import { yuan } from '../../utils/format'
import { isTop } from '../../utils/nav'
import { payOrder } from '../../utils/pay'
import { ask } from '../../utils/tap'

// Whether the package reminder was asked for since the app was opened.
let askedThisVisit = false

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
    showAgreement: false,
    agreed: false,
  },

  highlight: 0,
  lessonTypeId: 0,
  templates: {} as MeDto['noticeTemplates'],
  prompting: false,
  catalog: null as CatalogDto | null,
  /** Set once the student has gone back from this page. */
  left: false,

  onLoad(query: Record<string, string | undefined>) {
    this.highlight = Number(query.id ?? 0)
    this.lessonTypeId = Number(query.lessonTypeId ?? 0)
    this.load()
  },

  async load() {
    try {
      const [catalog, me] = await Promise.all([getCatalog(true), getMe()])
      this.catalog = catalog
      this.templates = me.noticeTemplates
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
        showAgreement: !me.agreedPolicies,
      })
    } catch (e) {
      this.setData({ state: 'error', error: errorMessage(e) })
    }
  },

  async buy(e: WechatMiniprogram.TouchEvent) {
    const product = this.data.products.find((p) => p.id === Number(e.currentTarget.dataset.id))
    if (!product || this.data.buying) return
    if (this.data.showAgreement && !this.data.agreed) {
      wx.showToast({ title: '请先阅读并同意用户协议和隐私政策', icon: 'none' })
      return
    }
    // A second tap while the prompt is up would ask again.
    if (this.prompting) return
    this.prompting = true
    let answer: WechatMiniprogram.ShowModalSuccessCallbackResult | null
    try {
      // Asked inside the tap, before any await, or WeChat does not show the prompt. Once per
      // visit, so a student who cancels and tries again is not asked again.
      if (!askedThisVisit) {
        askedThisVisit = true
        await askForNotices(this.templates, ['package'])
      }
      answer = await ask({
        title: product.name,
        content: `${product.lessonCount} 节课，${product.validity}，共 ${product.price}。`,
        confirmText: '去支付',
      })
    } finally {
      this.prompting = false
    }
    if (!answer?.confirm || this.data.buying) return
    this.setData({ buying: product.id })
    try {
      if (this.data.showAgreement) {
        await agreePolicies()
        this.setData({ showAgreement: false })
      }
      const res = await api<{ orderId: number; payment: PaymentParamsDto | null }>(
        'POST',
        '/packages/purchase',
        // Refused if the price changed since the page loaded, rather than charging another one.
        { productId: product.id, expectedPrice: product.amount },
      )
      // Gone back while the order was made: no cashier over the page they went back to.
      const result = await payOrder(res.orderId, product.amount, res.payment, () => !this.left)
      if (this.left && result !== 'paid') return
      if (result === 'paid' && !isTop(this)) {
        wx.showToast({ title: '购买成功', icon: 'success' })
      } else if (result === 'paid') {
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
      if (this.left) return
      if (err instanceof ApiError && (err.code === 'price_changed' || err.code === 'not_found')) {
        await this.load()
        const now = this.data.products.find((p) => p.id === product.id)
        await wx.showModal({
          title: err.code === 'price_changed' && now ? '价格已变动' : err.message,
          content:
            err.code === 'price_changed' && now
              ? `现价 ${now.price}，请确认后再购买`
              : '请选择其他课时包',
          showCancel: false,
        })
        return
      }
      showError(err)
    } finally {
      this.setData({ buying: 0 })
    }
  },

  onUnload() {
    this.left = true
  },

  onAgree(e: WechatMiniprogram.CustomEvent<{ checked: boolean }>) {
    this.setData({ agreed: e.detail.checked })
  },

  onShareAppMessage() {
    return { title: '课时包', path: '/pages/packages/index' }
  },

  retry() {
    this.setData({ state: 'loading' })
    this.load()
  },
})
