let navigating = false
let last: { key: string; page: unknown; at: number } | undefined

function topPage(): unknown {
  const pages = getCurrentPages()
  return pages[pages.length - 1]
}

/**
 * Whether `page` is still the one on screen. The user can go back with the nav bar or a swipe
 * while a request runs, and going back or redirecting then would act on another page.
 */
export function isTop(page: unknown): boolean {
  return topPage() === page
}

/**
 * Runs one navigation and ignores further ones until it settles, so a quick double tap does not
 * push a page twice or go back two pages.
 */
function once(key: string, go: (complete: () => void) => void): boolean {
  if (navigating) return false
  // The new page is shown a moment after complete, so a late second tap of the same link is
  // still ignored for a short while. Any other navigation, or any tap after the user has left
  // that page, goes through.
  if (last && last.key === key && last.page === topPage() && Date.now() - last.at < 500)
    return false
  navigating = true
  go(() => {
    navigating = false
    last = { key, page: topPage(), at: Date.now() }
  })
  return true
}

/** `events` are listeners for what the opened page sends back through its event channel. */
export function navigateOnce(url: string, events?: WechatMiniprogram.IAnyObject): void {
  once(`to:${url}`, (complete) => wx.navigateTo({ url, events, complete }))
}

/** Returns false when the tap was ignored, so callers can skip work tied to leaving. */
export function navigateBackOnce(delta = 1): boolean {
  return once(`back:${delta}`, (complete) => wx.navigateBack({ delta, complete }))
}

export function switchTabOnce(url: string): void {
  once(`tab:${url}`, (complete) => wx.switchTab({ url, complete }))
}

/**
 * Leaves a page after a save: back to the page beneath, or onto `fallback` when it was opened
 * with nothing beneath (a shared link, a notice, a relaunch), where going back does nothing.
 * `done` runs once the next page is showing, for a toast.
 */
export function backOr(fallback: string, done?: () => void): void {
  const go = (complete: () => void) => {
    const settle = () => {
      complete()
      done?.()
    }
    if (getCurrentPages().length > 1) wx.navigateBack({ complete: settle })
    else wx.reLaunch({ url: fallback, complete: settle })
  }
  if (!once(`leave:${fallback}`, go)) done?.()
}
