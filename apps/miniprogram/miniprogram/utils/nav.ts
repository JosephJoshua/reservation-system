let navigating = false

/**
 * wx.navigateTo that ignores taps while a navigation is under way, so a quick double tap does not
 * push the same page twice.
 */
export function navigateOnce(url: string): void {
  if (navigating) return
  navigating = true
  wx.navigateTo({
    url,
    complete: () => {
      // The new page is shown a moment after complete; a short hold covers the transition.
      setTimeout(() => {
        navigating = false
      }, 500)
    },
  })
}
