import type { AccountDeletionDto } from '../../lib/shared'
import { ApiError, api, apiOnce, clearSession, errorMessage, showError } from '../../utils/api'
import { ask } from '../../utils/tap'
import { modalDangerColor } from '../../utils/theme'

const isSignedOut = (e: unknown) => e instanceof ApiError && e.status === 401

Page({
  data: {
    state: 'loading' as 'loading' | 'ready' | 'error',
    error: '',
    errorIcon: { name: 'error-circle', size: '112rpx' },
    blockers: [] as string[],
    deleting: false,
  },

  /**
   * Set once a 注销 was sent without a clear answer, such as a lost response. From then on the
   * page never logs in again: that would make a new account if the old one is gone.
   */
  maybeDeleted: false,

  onShow() {
    // Coming back after cancelling a lesson or asking for a refund should update the list.
    this.load()
  },

  /** Answers true when it found the account already gone and left the page. */
  async load(): Promise<boolean> {
    try {
      const path = '/me/deletion'
      const { blockers } = this.maybeDeleted
        ? await apiOnce<AccountDeletionDto>('GET', path)
        : await api<AccountDeletionDto>('GET', path)
      // Answered with this session: the account is still there.
      this.maybeDeleted = false
      this.setData({ state: 'ready', blockers })
    } catch (e) {
      if (this.maybeDeleted && isSignedOut(e)) {
        this.deleted()
        return true
      }
      this.setData({ state: 'error', error: errorMessage(e) })
    }
    return false
  },

  /** The account is gone: start again signed out, on the home tab. */
  deleted() {
    clearSession()
    wx.reLaunch({
      url: '/pages/booking/index',
      success: () => wx.showToast({ title: '账号已注销', icon: 'success' }),
    })
  },

  retry() {
    this.setData({ state: 'loading' })
    this.load()
  },

  async confirmDelete() {
    if (this.data.deleting || this.data.blockers.length) return
    this.setData({ deleting: true })
    try {
      const answer = await ask({
        title: '确认注销账号？',
        content: '注销后无法恢复。',
        confirmText: '注销',
        // Error red that keeps its contrast on the light and dark dialog.
        confirmColor: modalDangerColor(),
      })
      if (!answer?.confirm) return
      try {
        await apiOnce('DELETE', '/me')
      } catch (e) {
        // Refused after an earlier 注销 whose answer was lost: that one ended the session.
        if (this.maybeDeleted && isSignedOut(e)) {
          this.deleted()
          return
        }
        if (e instanceof ApiError && e.status === 0) this.maybeDeleted = true
        throw e
      }
      this.deleted()
    } catch (e) {
      // Something changed meanwhile, such as a new booking; show what now stands in the way.
      // After a lost answer the reload finds out whether the 注销 went through, so check first.
      if (!(await this.load())) showError(e)
    } finally {
      this.setData({ deleting: false })
    }
  },
})
