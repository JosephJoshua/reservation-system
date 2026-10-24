// Opened by scanning the venue's 签到码 with WeChat, once the link is set up in the mini program
// console under 扫普通链接二维码打开小程序.
import { type CheckInLessonDto, isCheckInCode } from '../../lib/shared'
import { api, errorMessage } from '../../utils/api'
import { scanToCheckIn } from '../../utils/check-in'
import { lessonTime } from '../../utils/format'

Page({
  data: {
    state: 'loading' as 'loading' | 'done' | 'error',
    error: '',
    lessons: [] as { id: number; when: string; name: string }[],
    /** Every lesson was checked in before this scan. */
    already: false,
  },

  code: '',

  onLoad(query: Record<string, string | undefined>) {
    this.code = query.q ? decodeURIComponent(query.q) : ''
    this.send()
  },

  async send() {
    if (!isCheckInCode(this.code)) {
      this.setData({ state: 'error', error: '这不是场馆的签到码' })
      return
    }
    this.setData({ state: 'loading' })
    try {
      const rows = await api<CheckInLessonDto[]>('POST', '/check-in', { code: this.code })
      this.setData({
        state: 'done',
        already: rows.every((l) => l.already),
        lessons: rows.map((l) => ({
          id: l.bookingId,
          when: lessonTime(l.startsAt, l.endsAt),
          name: `${l.lessonTypeName} · ${l.coachName}`,
        })),
      })
    } catch (e) {
      this.setData({ state: 'error', error: errorMessage(e) })
    }
  },

  async rescan() {
    if (await scanToCheckIn()) this.lessons()
  },

  lessons() {
    wx.switchTab({ url: '/pages/lessons/index' })
  },
})
