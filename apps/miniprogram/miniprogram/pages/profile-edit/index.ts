import { api, showError } from '../../utils/api'
import { agreePolicies, getMe } from '../../utils/data'

Page({
  data: {
    name: '',
    phone: '',
    showAgreement: false,
    agreed: false,
    saving: false,
  },

  onLoad() {
    getMe()
      .then((me) =>
        this.setData({ name: me.name, phone: me.phone, showAgreement: !me.agreedPolicies }),
      )
      .catch(showError)
  },

  onName(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ name: e.detail.value })
  },

  onPhone(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ phone: e.detail.value })
  },

  onAgree(e: WechatMiniprogram.CustomEvent<{ checked: boolean }>) {
    this.setData({ agreed: e.detail.checked })
  },

  async save() {
    if (this.data.saving) return
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
      wx.navigateBack({ success: () => wx.showToast({ title: '已保存', icon: 'success' }) })
    } catch (e) {
      showError(e)
    } finally {
      this.setData({ saving: false })
    }
  },

  openDelete() {
    wx.navigateTo({ url: '/pages/account-delete/index' })
  },
})
