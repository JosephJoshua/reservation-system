import { showError } from '../../utils/api'
import { bind } from '../utils/coach-api'

Page({
  data: {
    code: '',
    binding: false,
  },

  onCode(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    const code = e.detail.value.toUpperCase().replace(/[^A-Z0-9]/g, '')
    this.setData({ code })
  },

  async submit() {
    if (this.data.code.length < 8 || this.data.binding) return
    this.setData({ binding: true })
    try {
      await bind(this.data.code)
      wx.redirectTo({
        url: '/coach/index/index',
        success: () => wx.showToast({ title: '绑定成功', icon: 'success' }),
      })
    } catch (e) {
      showError(e)
    } finally {
      this.setData({ binding: false })
    }
  },
})
