import type { AccountDeletionDto } from '../../lib/shared'
import { api, apiOnce, clearSession, errorMessage, showError } from '../../utils/api'

Page({
  data: {
    state: 'loading' as 'loading' | 'ready' | 'error',
    error: '',
    errorIcon: { name: 'error-circle', size: '112rpx' },
    blockers: [] as string[],
    deleting: false,
  },

  onShow() {
    // Coming back after cancelling a lesson or asking for a refund should update the list.
    this.load()
  },

  async load() {
    try {
      const { blockers } = await api<AccountDeletionDto>('GET', '/me/deletion')
      this.setData({ state: 'ready', blockers })
    } catch (e) {
      this.setData({ state: 'error', error: errorMessage(e) })
    }
  },

  retry() {
    this.setData({ state: 'loading' })
    this.load()
  },

  async confirmDelete() {
    if (this.data.deleting || this.data.blockers.length) return
    this.setData({ deleting: true })
    try {
      const { confirm } = await wx.showModal({
        title: '确认注销账号？',
        content: '注销后无法恢复。',
        confirmText: '注销',
        confirmColor: '#d54941',
      })
      if (!confirm) return
      await apiOnce('DELETE', '/me')
      clearSession()
      wx.reLaunch({
        url: '/pages/booking/index',
        success: () => wx.showToast({ title: '账号已注销', icon: 'success' }),
      })
    } catch (e) {
      showError(e)
      // Something changed meanwhile, such as a new booking; show what now stands in the way.
      this.load()
    } finally {
      this.setData({ deleting: false })
    }
  },
})
