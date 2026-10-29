import type { BookingDto } from '../../lib/shared'
import { api, errorMessage, serverNow, showError } from '../../utils/api'
import { scanToCheckIn } from '../../utils/check-in'
import { dayName, monthDay, time, weekday } from '../../utils/format'
import { lessonTag } from '../../utils/labels'
import { navigateOnce } from '../../utils/nav'

type Scope = 'upcoming' | 'past'

interface LessonView {
  id: number
  day: string
  date: string
  time: string
  name: string
  coach: string
  status: string
  feedback: boolean
  tone: 'primary' | 'warning' | 'success' | 'danger' | 'default'
}

function view(b: BookingDto, now: Date): LessonView {
  return {
    id: b.id,
    day: dayName(b.startsAt, now).length <= 2 ? dayName(b.startsAt, now) : weekday(b.startsAt),
    date: monthDay(b.startsAt),
    time: `${time(b.startsAt)}-${time(b.endsAt)}`,
    name: b.lessonType.name,
    coach: b.coach.name,
    feedback: b.hasFeedback,
    // An unpaid hold reads 已失效 from its payment time on, as 预约详情 shows it.
    ...lessonTag(b, now.getTime()),
  }
}

Page({
  data: {
    scope: 'upcoming' as Scope,
    state: 'loading' as 'loading' | 'ready' | 'error',
    error: '',
    lessons: [] as LessonView[],
    /** A lesson about to start or under way that the student can scan the 签到码 for. */
    checkIn: null as LessonView | null,
    emptyIcon: { name: 'calendar', size: '112rpx' },
    errorIcon: { name: 'error-circle', size: '112rpx' },
  },

  request: 0,
  timer: 0,

  onShow() {
    this.load()
    // A lesson opens for check-in 30 minutes before it starts and closes when it ends. Kept
    // quiet: offline, a toast every minute would only nag.
    clearInterval(this.timer)
    this.timer = setInterval(() => {
      if (this.data.scope === 'upcoming' && this.data.state === 'ready') this.load(true)
    }, 60_000)
  },

  onHide() {
    clearInterval(this.timer)
  },

  onUnload() {
    clearInterval(this.timer)
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh())
  },

  /**
   * Loads the list. A failure keeps what is on screen, and is said unless `quiet` (the timer's
   * refresh). The retry button passes its tap event here, so only `true` counts as quiet.
   */
  async load(quiet?: boolean) {
    const request = ++this.request
    if (!this.data.lessons.length) this.setData({ state: 'loading' })
    try {
      const rows = await api<BookingDto[]>('GET', `/bookings?scope=${this.data.scope}`)
      if (request !== this.request) return
      // Nothing to check in to while the venue cannot give the lesson.
      const open = rows.find((b) => b.canCheckIn && !b.disruption)
      const now = new Date(serverNow())
      this.setData({
        state: 'ready',
        lessons: rows.map((b) => view(b, now)),
        checkIn: this.data.scope === 'upcoming' && open ? view(open, now) : null,
      })
    } catch (e) {
      if (request !== this.request) return
      // A failed refresh keeps what is on screen.
      if (this.data.state === 'ready') {
        if (quiet !== true) showError(e)
      } else this.setData({ state: 'error', error: errorMessage(e) })
    }
  },

  onScope(e: WechatMiniprogram.CustomEvent<{ value: Scope }>) {
    this.setData({ scope: e.detail.value, lessons: [], checkIn: null })
    this.load()
  },

  open(e: WechatMiniprogram.TouchEvent) {
    navigateOnce(`/pages/booking-detail/index?id=${e.currentTarget.dataset.id}`)
  },

  async scan() {
    if (await scanToCheckIn()) this.load()
  },

  book() {
    wx.switchTab({ url: '/pages/booking/index' })
  },
})
