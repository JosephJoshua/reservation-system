import { type CheckInLessonDto, isCheckInCode } from '../lib/shared'
import { ApiError, api, errorMessage } from './api'
import { ask } from './tap'

let busy = false

/** Sends a scanned 签到码 and tells the student how it went. Resolves true when checked in. */
export async function checkIn(code: string): Promise<boolean> {
  if (!isCheckInCode(code)) {
    await ask({ title: '这不是场馆的签到码', content: '请扫描前台的签到码', showCancel: false })
    return false
  }
  wx.showLoading({ title: '签到中', mask: true })
  try {
    const lessons = await api<CheckInLessonDto[]>('POST', '/check-in', { code })
    wx.hideLoading()
    const fresh = lessons.some((l) => !l.already)
    wx.showToast({ title: fresh ? '签到成功' : '已签到过', icon: 'success' })
    return true
  } catch (e) {
    wx.hideLoading()
    await ask({
      title: e instanceof ApiError && e.status === 0 ? '签到失败' : '无法签到',
      content: errorMessage(e),
      showCancel: false,
    })
    return false
  }
}

/** Opens the camera for the venue's 签到码, once however often it is tapped. */
export function scanToCheckIn(): Promise<boolean> {
  if (busy) return Promise.resolve(false)
  busy = true
  return new Promise<string | null>((resolve) => {
    wx.scanCode({
      onlyFromCamera: true,
      scanType: ['qrCode'],
      success: (res) => resolve(res.result),
      // Closing the camera is not an error.
      fail: () => resolve(null),
    })
  })
    .then((code) => (code === null ? false : checkIn(code)))
    .finally(() => {
      busy = false
    })
}
