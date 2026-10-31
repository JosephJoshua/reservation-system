import {
  type InvoiceOrderDto,
  type InvoiceTitleKind,
  invoiceTitleError,
  invoiceTitleKindLabels,
  normalizeInvoiceTitle,
  orderTitle,
  type StudentInvoicesDto,
} from '../../lib/shared'
import { api, errorMessage, showError } from '../../utils/api'
import { agreementFor, agreePolicies, askToAgree, getMe, needsAgreement } from '../../utils/data'
import { yuan } from '../../utils/format'
import { isTop } from '../../utils/nav'

const KINDS: InvoiceTitleKind[] = ['personal', 'company']

Page({
  data: {
    state: 'loading' as 'loading' | 'ready' | 'error',
    error: '',
    errorIcon: { name: 'error-circle', size: '112rpx' },
    item: '',
    amount: '',
    kind: 'personal' as InvoiceTitleKind,
    kindLabel: invoiceTitleKindLabels.personal,
    name: '',
    taxNumber: '',
    email: '',
    showAgreement: false,
    agreed: false,
    saving: false,
  },

  orderId: 0,
  picking: false,
  meName: '',
  /** The version of the policies the agreement row offers. */
  policyVersion: '',
  // What was typed for the other kind, so switching back and forth keeps it.
  typed: {} as Partial<Record<InvoiceTitleKind, { name: string; taxNumber: string }>>,

  onLoad(query: Record<string, string | undefined>) {
    this.orderId = Number(query.orderId)
    this.load()
  },

  async load() {
    try {
      const [{ orders, lastTitle }, me] = await Promise.all([
        api<StudentInvoicesDto>('GET', '/invoices'),
        getMe(),
      ])
      const order = orders.find((o: InvoiceOrderDto) => o.orderId === this.orderId)
      if (!order || (order.state !== 'available' && order.state !== 'rejected')) {
        this.setData({ state: 'error', error: '这笔订单暂时不能申请发票' })
        return
      }
      const version = await agreementFor(me)
      this.policyVersion = version ?? ''
      const kind = lastTitle?.kind ?? 'personal'
      this.meName = me.name
      this.setData({
        state: 'ready',
        item: orderTitle(order.kind, order.description),
        amount: yuan(order.amount),
        kind,
        kindLabel: invoiceTitleKindLabels[kind],
        // A personal invoice is usually in the student's own name.
        name: lastTitle?.name ?? me.name,
        taxNumber: lastTitle?.taxNumber ?? '',
        email: lastTitle?.email ?? '',
        showAgreement: version !== null,
      })
    } catch (e) {
      this.setData({ state: 'error', error: errorMessage(e) })
    }
  },

  async pickKind() {
    // A double tap would open a second sheet over the first.
    if (this.picking) return
    this.picking = true
    const res = await wx
      .showActionSheet({ itemList: KINDS.map((k) => invoiceTitleKindLabels[k]) })
      .catch(() => null)
      .finally(() => {
        this.picking = false
      })
    const kind = res ? KINDS[res.tapIndex] : undefined
    if (!kind || kind === this.data.kind) return
    this.typed[this.data.kind] = { name: this.data.name, taxNumber: this.data.taxNumber }
    const back = this.typed[kind]
    this.setData({
      kind,
      kindLabel: invoiceTitleKindLabels[kind],
      name: back?.name ?? (kind === 'personal' ? this.meName : ''),
      taxNumber: back?.taxNumber ?? '',
    })
  },

  onName(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ name: e.detail.value })
  },

  onTaxNumber(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ taxNumber: e.detail.value })
  },

  onEmail(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ email: e.detail.value })
  },

  onAgree(e: WechatMiniprogram.CustomEvent<{ checked: boolean }>) {
    this.setData({ agreed: e.detail.checked })
  },

  async submit() {
    if (this.data.saving) return
    const title = normalizeInvoiceTitle({
      kind: this.data.kind,
      name: this.data.name,
      taxNumber: this.data.taxNumber,
      email: this.data.email,
    })
    const error = invoiceTitleError(title)
    if (error) {
      wx.showToast({ title: error, icon: 'none' })
      return
    }
    if (this.data.showAgreement && !this.data.agreed) {
      wx.showToast({ title: '请先阅读并同意用户协议和隐私政策', icon: 'none' })
      return
    }
    this.setData({ saving: true })
    try {
      if (this.data.showAgreement) {
        await agreePolicies(this.policyVersion)
        this.setData({ showAgreement: false })
      }
      await api('POST', '/invoices', { orderId: this.orderId, ...title })
      const done = () => wx.showToast({ title: '已提交', icon: 'success' })
      // Opened from a shared link there is nothing to go back to, so show the list instead.
      if (!isTop(this)) done()
      else if (getCurrentPages().length > 1) wx.navigateBack({ success: done })
      else wx.redirectTo({ url: '/pages/invoices/index', success: done })
    } catch (e) {
      if (needsAgreement(e)) {
        this.setData({ showAgreement: true, agreed: false })
        this.policyVersion = (await askToAgree(true)) ?? this.policyVersion
        return
      }
      showError(e)
    } finally {
      this.setData({ saving: false })
    }
  },

  retry() {
    this.setData({ state: 'loading' })
    this.load()
  },
})
