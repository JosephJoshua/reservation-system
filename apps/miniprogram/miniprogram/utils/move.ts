// Submitting a move from the student's and the coach's move pages.
import { ApiError, showError } from './api'
import { isTop, navigateBackOnce } from './nav'

/**
 * Refusals that mean the lesson itself can no longer move: late, used up, cancelled meanwhile, or
 * gone (a coach's lesson the venue gave to someone else). A missing time is 'slot_not_found'.
 */
const LESSON_FIXED = ['move_deadline', 'no_moves_left', 'not_movable', 'started', 'not_found']

/** Refusals of the picked time for this lesson, which still hold after the times reload. */
const TIME_REFUSED = [
  'price_differs',
  'coach_not_covered',
  'coach_not_teaching',
  'package_expires',
  'student_clash',
  'duration_mismatch',
  'tables_full',
]

/**
 * What happened: moved and going back; refused for good and going back; this time refused for
 * this lesson; the time went (taken, closed or too close now); or another error, already shown.
 */
export type MoveResult = 'moved' | 'fixed' | 'refused' | 'gone' | 'failed'

/** Leaves the move page for the lesson's page: back to it, or onto it when nothing is beneath. */
export function leaveMove(detail: string): void {
  if (getCurrentPages().length > 1) navigateBackOnce()
  else wx.redirectTo({ url: detail })
}

/**
 * Sends the move and tells the page that opened the move page what became of the lesson:
 * 'moved' with the result, or 'stale' when it can no longer move and needs reloading.
 * `request` runs before anything is awaited, so it may ask for subscriptions first.
 */
export async function submitMove(
  page: WechatMiniprogram.Page.Instance<WechatMiniprogram.IAnyObject, WechatMiniprogram.IAnyObject>,
  request: () => Promise<unknown>,
  detail: string,
): Promise<MoveResult> {
  const opener = page.getOpenerEventChannel()
  try {
    // Awaited first: in `emit?.(…, await request())` no opener would skip the request too.
    const moved = await request()
    opener.emit?.('moved', moved)
    wx.showToast({ title: '已改约', icon: 'success' })
    setTimeout(() => isTop(page) && leaveMove(detail), 600)
    return 'moved'
  } catch (e) {
    if (!(e instanceof ApiError)) {
      showError(e)
      return 'failed'
    }
    if (LESSON_FIXED.includes(e.code)) {
      opener.emit?.('stale')
      await wx.showModal({ title: e.message, showCancel: false })
      if (isTop(page)) leaveMove(detail)
      return 'fixed'
    }
    if (TIME_REFUSED.includes(e.code) || e.status === 409 || e.status === 404) {
      wx.showToast({ title: e.message, icon: 'none', duration: 2500 })
      return TIME_REFUSED.includes(e.code) ? 'refused' : 'gone'
    }
    showError(e)
    return 'failed'
  }
}
