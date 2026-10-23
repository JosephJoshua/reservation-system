/**
 * A quick double tap reaches a handler twice before any busy flag in page data can stop it, so a
 * confirm dialog is guarded here instead. Page links use `navigateOnce` from `nav.ts`.
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
