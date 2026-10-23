let navigating = false

/**
 * Runs one navigation and ignores further ones until it settles, so a quick double tap does not
 * push a page twice or go back two pages.
 */
function once(go: (complete: () => void) => void): void {
  if (navigating) return
  navigating = true
  go(() => {
    // The new page is shown a moment after complete; a short hold covers the transition.
    setTimeout(() => {
      navigating = false
    }, 500)
  })
}

export function navigateOnce(url: string): void {
  once((complete) => wx.navigateTo({ url, complete }))
}

export function navigateBackOnce(delta = 1): void {
  once((complete) => wx.navigateBack({ delta, complete }))
}

export function switchTabOnce(url: string): void {
  once((complete) => wx.switchTab({ url, complete }))
}
