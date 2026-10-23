import { api, showError } from '../../utils/api'
import { getMe } from '../../utils/data'

Page({
  data: {
    name: '',
    phone: '',
    saving: false,
  },

  onLoad() {
    getMe()
      .then((me) => this.setData({ name: me.name, phone: me.phone }))
      .catch(showError)
  },

  onName(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ name: e.detail.value })
  },

  onPhone(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ phone: e.detail.value })
  },

  async save() {
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
    this.setData({ saving: true })
    try {
      await api('PUT', '/me', { name, phone })
      wx.navigateBack({ success: () => wx.showToast({ title: '已保存', icon: 'success' }) })
    } catch (e) {
      showError(e)
    } finally {
      this.setData({ saving: false })
    }
  },
})
