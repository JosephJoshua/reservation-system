import { ApiError, api, showError } from '../../utils/api'
import {
  agreementFor,
  agreePolicies,
  askToAgree,
  forgetCatalog,
  getMe,
  needsAgreement,
} from '../../utils/data'
import { isTop } from '../../utils/nav'

const clean = (code: string) =>
  code
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8)

Page({
  data: {
    code: '',
    showAgreement: false,
    agreed: false,
    // Whether the student still has to agree is known once /me answers.
    ready: false,
    linking: false,
  },

  // Opened from the desk's 小程序码, the code arrives as the scene.
  onLoad(options: Record<string, string | undefined>) {
    const scene = options.scene ? clean(decodeURIComponent(options.scene)) : ''
    if (scene) this.setData({ code: scene })
    getMe()
      .then(agreementFor)
      .then((version) => {
        this.policyVersion = version ?? ''
        this.versionKnown = true
        this.setData({ showAgreement: version !== null, ready: true })
      })
      .catch((e) => {
        // Asking again is harmless; the link itself still needs the network. Without a version
        // the server says policy_changed, which loads it and asks again.
        this.setData({ showAgreement: true, ready: true })
        showError(e)
      })
  },

  /** The version of the policies the agreement row offers. */
  policyVersion: '',
  /**
   * Whether the page knows which version the student was offered or had agreed to, so a refusal
   * means the texts changed. Not when /me failed and the row was shown without one.
   */
  versionKnown: false,

  onCode(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ code: clean(e.detail.value) })
  },

  onAgree(e: WechatMiniprogram.CustomEvent<{ checked: boolean }>) {
    this.setData({ agreed: e.detail.checked })
  },

  async submit() {
    if (this.data.code.length !== 8 || !this.data.ready || this.data.linking) return
    if (this.data.showAgreement && !this.data.agreed) {
      wx.showToast({ title: '请先阅读并同意用户协议和隐私政策', icon: 'none' })
      return
    }
    this.setData({ linking: true })
    try {
      if (this.data.showAgreement) {
        await agreePolicies(this.policyVersion)
        this.setData({ showAgreement: false })
      }
      const code = this.data.code
      try {
        await api('POST', '/me/link', { code })
      } catch (e) {
        // This WeChat already has records of its own: join the two only if the student says so.
        if (!(e instanceof ApiError) || e.code !== 'confirm_merge') throw e
        const { confirm } = await wx.showModal({
          title: '合并为同一位学员？',
          content: `${e.message}。如果前台记录是别人的，请换用本人的微信同步。`,
          confirmText: '合并',
        })
        if (!confirm) return
        await api('POST', '/me/link', { code, merge: true })
      }
      // The session now belongs to the desk record, whose 体验课 and packages may differ.
      forgetCatalog()
      if (!isTop(this)) return
      wx.switchTab({
        url: '/pages/profile/index',
        success: () => wx.showToast({ title: '已同步', icon: 'success' }),
      })
    } catch (e) {
      if (needsAgreement(e)) {
        this.setData({ showAgreement: true, agreed: false })
        const version = await askToAgree(this.versionKnown)
        if (version !== null) {
          this.policyVersion = version
          this.versionKnown = true
        }
        return
      }
      showError(e)
    } finally {
      this.setData({ linking: false })
    }
  },
})
