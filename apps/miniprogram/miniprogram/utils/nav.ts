let navigating = false
let landed: unknown
let landedAt = 0

function topPage(): unknown {
  const pages = getCurrentPages()
  return pages[pages.length - 1]
}

/**
 * Runs one navigation and ignores further ones until it settles, so a quick double tap does not
 * push a page twice or go back two pages.
 */
function once(go: (complete: () => void) => void): void {
  if (navigating) return
  // The new page is shown a moment after complete, so a late second tap is still ignored for a
  // short while. Once the user has left that page, for example by going back, taps count again.
  if (topPage() === landed && Date.now() - landedAt < 500) return
  navigating = true
  go(() => {
    navigating = false
    landed = topPage()
    landedAt = Date.now()
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
