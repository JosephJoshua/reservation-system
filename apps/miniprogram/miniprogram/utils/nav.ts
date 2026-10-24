let navigating = false
let last: { key: string; page: unknown; at: number } | undefined

function topPage(): unknown {
  const pages = getCurrentPages()
  return pages[pages.length - 1]
}

/**
 * Runs one navigation and ignores further ones until it settles, so a quick double tap does not
 * push a page twice or go back two pages.
 */
function once(key: string, go: (complete: () => void) => void): void {
  if (navigating) return
  // The new page is shown a moment after complete, so a late second tap of the same link is
  // still ignored for a short while. Any other navigation, or any tap after the user has left
  // that page, goes through.
  if (last && last.key === key && last.page === topPage() && Date.now() - last.at < 500) return
  navigating = true
  go(() => {
    navigating = false
    last = { key, page: topPage(), at: Date.now() }
  })
}

/** `events` are listeners for what the opened page sends back through its event channel. */
export function navigateOnce(url: string, events?: WechatMiniprogram.IAnyObject): void {
  once(`to:${url}`, (complete) => wx.navigateTo({ url, events, complete }))
}

export function navigateBackOnce(delta = 1): void {
  once(`back:${delta}`, (complete) => wx.navigateBack({ delta, complete }))
}

export function switchTabOnce(url: string): void {
  once(`tab:${url}`, (complete) => wx.switchTab({ url, complete }))
}
