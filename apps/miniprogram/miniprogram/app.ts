type PrivacyResolve = (result: { event: 'disagree' }) => void

App({
  onLaunch() {
    // A privacy API (such as the clipboard) used before the user agreed to the privacy guide
    // waits here; the current page shows the consent sheet. The typings get this listener's
    // arguments wrong, hence the cast.
    const listen = wx.onNeedPrivacyAuthorization as unknown as
      | ((listener: (resolve: PrivacyResolve) => void) => void)
      | undefined
    listen?.((resolve) => {
      const pages = getCurrentPages()
      const popup = pages[pages.length - 1]?.selectComponent('#privacy-popup') as
        | { show(resolve: PrivacyResolve): void }
        | null
        | undefined
      if (popup) popup.show(resolve)
      else resolve({ event: 'disagree' })
    })
  },
})
