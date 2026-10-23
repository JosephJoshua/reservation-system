type Resolve = (result: {
  event: 'agree' | 'disagree' | 'exposureAuthorization'
  buttonId?: string
}) => void

// Several privacy APIs can wait at once, across pages, and one answer settles them all.
let pending: Resolve[] = []

/**
 * WeChat's privacy consent sheet. A privacy API (such as the clipboard) waits until the user
 * agrees here; app.ts shows it on the current page, which must include it as #privacy-popup.
 */
Component({
  data: {
    visible: false,
    contractName: '《隐私保护指引》',
  },

  methods: {
    show(resolve: Resolve) {
      pending.push(resolve)
      resolve({ event: 'exposureAuthorization' })
      if (this.data.visible) return
      this.setData({ visible: true })
      wx.getPrivacySetting({
        success: (res) => {
          if (res.privacyContractName) this.setData({ contractName: res.privacyContractName })
        },
      })
    },

    openContract() {
      wx.openPrivacyContract({})
    },

    agree() {
      this.settle({ event: 'agree', buttonId: 'agree-privacy' })
    },

    disagree() {
      this.settle({ event: 'disagree' })
    },

    settle(result: Parameters<Resolve>[0]) {
      const waiting = pending
      pending = []
      this.setData({ visible: false })
      for (const resolve of waiting) resolve(result)
    },
  },

  lifetimes: {
    // A page closed with the sheet open must not leave the waiting APIs hanging.
    detached() {
      if (this.data.visible) this.settle({ event: 'disagree' })
    },
  },
})
