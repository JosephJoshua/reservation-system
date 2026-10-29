import { ApiError, showError } from '../../utils/api'
import { isTop } from '../../utils/nav'
import { bind } from '../utils/coach-api'

const BIND_CODE_LENGTH = 8

Page({
  data: {
    code: '',
    binding: false,
  },

  /** A code whose bind got no answer: it may have gone through. */
  lostCode: '',

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
      const { code } = this.data
      try {
        await bind(code, this.lostCode === code)
      } catch (e) {
        if (e instanceof ApiError && e.code === 'network') this.lostCode = code
        throw e
      }
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
