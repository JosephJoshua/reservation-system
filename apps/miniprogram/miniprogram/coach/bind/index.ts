import { showError } from '../../utils/api'
import { isTop } from '../../utils/nav'
import { bind } from '../utils/coach-api'

const BIND_CODE_LENGTH = 8

Page({
  data: {
    code: '',
    binding: false,
  },

  onCode(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    // The venue shows the code as ABCD EFGH; the space or a dash is dropped and the code is 8 long.
    const code = e.detail.value
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, BIND_CODE_LENGTH)
    this.setData({ code })
  },

  async submit() {
    if (this.data.code.length < BIND_CODE_LENGTH || this.data.binding) return
    this.setData({ binding: true })
    try {
      await bind(this.data.code)
      if (!isTop(this)) return
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
