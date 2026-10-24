/**
 * A quick double tap reaches a handler twice before any busy flag in page data can stop it, so a
 * confirm dialog or system screen is guarded here instead. Page links use `navigateOnce` from
 * `nav.ts`.
 */

let asking = false

/** Shows a modal unless one is already up; a second tap gets null. */
export async function ask(
  options: WechatMiniprogram.ShowModalOption,
): Promise<WechatMiniprogram.ShowModalSuccessCallbackResult | null> {
  if (asking) return null
  asking = true
  try {
    return await wx.showModal(options)
  } finally {
    asking = false
  }
}

let opening = false

/**
 * Opens a system screen or sheet (map, phone call, photo viewer, copy toast) unless one is
 * already opening, so a double tap does not stack two. `open` must pass `complete` to the wx call.
 */
export function openOnce(open: (complete: () => void) => void): void {
  if (opening) return
  opening = true
  // The map and photo viewer report complete as they start to open, so a late second tap is
  // still ignored for a moment.
  open(() => {
    setTimeout(() => {
      opening = false
    }, 500)
  })
}
