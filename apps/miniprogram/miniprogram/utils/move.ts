// Submitting a move from the student's and the coach's move pages.
import { ApiError, showError } from './api'
import { isTop, navigateBackOnce } from './nav'

/**
 * Refusals that mean the lesson itself can no longer move from this page: late, used up,
 * cancelled meanwhile, moved elsewhere since the page loaded, or gone (a coach's lesson the venue
 * gave to someone else). A missing time is 'slot_not_found'.
 */
const LESSON_FIXED = [
  'move_deadline',
  'no_moves_left',
  'not_movable',
  'started',
  'not_found',
  'booking_changed',
]

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
 * What happened: moved and going back; refused for good and going back; not known whether it
 * moved (the answer was lost, or the first send is still being handled) and going back to look;
 * this time refused for this lesson; the time went (taken, closed or too close now); or another
 * error, already shown.
 */
export type MoveResult = 'moved' | 'fixed' | 'unknown' | 'refused' | 'gone' | 'failed'

/** What a refused or lost move means for the page, from the error's status and code. */
export function moveFailure(status: number, code: string): Exclude<MoveResult, 'moved'> {
  // Lost after a resend, or a repeat of a send still being handled: the move may have gone
  // through, so letting the student pick another time could move the lesson twice.
  if (status === 0 || code === 'in_progress') return 'unknown'
  if (LESSON_FIXED.includes(code)) return 'fixed'
  if (TIME_REFUSED.includes(code)) return 'refused'
  if (status === 409 || status === 404) return 'gone'
  return 'failed'
}

/** Leaves the move page for the lesson's page: back to it, or onto it when nothing is beneath. */
export function leaveMove(detail: string): void {
  if (getCurrentPages().length > 1) navigateBackOnce()
  else wx.redirectTo({ url: detail })
}

/**
 * Sends the move and tells the page that opened the move page what became of the lesson:
 * 'moved' with the result, or 'stale' when it can no longer move, or may have moved, and needs
 * reloading.
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
    const result = e instanceof ApiError ? moveFailure(e.status, e.code) : 'failed'
    if (!(e instanceof ApiError) || result === 'failed') {
      showError(e)
      return 'failed'
    }
    if (result === 'fixed' || result === 'unknown') {
      // The lesson's page reloads and shows whether it moved.
      opener.emit?.('stale')
      await wx.showModal({ title: e.message, showCancel: false })
      if (isTop(page)) leaveMove(detail)
      return result
    }
    wx.showToast({ title: e.message, icon: 'none', duration: 2500 })
    return result
  }
}
