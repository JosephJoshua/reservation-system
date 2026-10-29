import { api, errorMessage, showError } from '../../utils/api'
import { agreePolicies, getMe } from '../../utils/data'
import { backOr, isTop, navigateOnce } from '../../utils/nav'

Page({
  data: {
    state: 'loading' as 'loading' | 'ready' | 'error',
    error: '',
    errorIcon: { name: 'error-circle', size: '112rpx' },
    name: '',
    phone: '',
    showAgreement: false,
    agreed: false,
    saving: false,
  },

  // Set once the student types, so a late profile answer never replaces what they typed.
  edited: false,

  onLoad() {
    this.load()
  },

  // The form shows only once the profile is in, so a student who has not agreed yet sees the
  // agreement instead of having every save refused.
  async load() {
    try {
      const me = await getMe()
      const fields = this.edited ? {} : { name: me.name, phone: me.phone }
      this.setData({ state: 'ready', ...fields, showAgreement: !me.agreedPolicies })
    } catch (e) {
      this.setData({ state: 'error', error: errorMessage(e) })
    }
  },

  retry() {
    this.setData({ state: 'loading' })
    this.load()
  },

  onName(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.edited = true
    this.setData({ name: e.detail.value })
  },

  onPhone(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.edited = true
    this.setData({ phone: e.detail.value })
  },

  onAgree(e: WechatMiniprogram.CustomEvent<{ checked: boolean }>) {
    this.setData({ agreed: e.detail.checked })
  },

  async save() {
    if (this.data.saving || this.data.state !== 'ready') return
    const name = this.data.name.trim()
    const phone = this.data.phone.trim()
    if (!name) {
      wx.showToast({ title: '请填写姓名', icon: 'none' })
      return
    }
    if (!/^1\d{10}$/.test(phone)) {
      wx.showToast({ title: '请填写正确的手机号', icon: 'none' })
      return
    }
    if (this.data.showAgreement && !this.data.agreed) {
      wx.showToast({ title: '请先阅读并同意用户协议和隐私政策', icon: 'none' })
      return
    }
    this.setData({ saving: true })
    try {
      if (this.data.showAgreement) {
        await agreePolicies()
        this.setData({ showAgreement: false })
      }
      await api('PUT', '/me', { name, phone })
      const done = () => wx.showToast({ title: '已保存', icon: 'success' })
      if (isTop(this)) backOr('/pages/profile/index', done)
      else done()
    } catch (e) {
      showError(e)
    } finally {
      this.setData({ saving: false })
    }
  },

  openDelete() {
    navigateOnce('/pages/account-delete/index')
  },
})
