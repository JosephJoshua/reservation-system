import type { BookingDto } from '../../lib/shared'
import { api, errorMessage, serverNow, showError } from '../../utils/api'
import { scanToCheckIn } from '../../utils/check-in'
import { dayName, monthDay, time, weekday } from '../../utils/format'
import { BOOKING_STATUS } from '../../utils/labels'
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

/** The status tag, with the attendance once it is marked. */
function statusOf(b: BookingDto): Pick<LessonView, 'status' | 'tone'> {
  if (b.attendance === 'attended') {
    return { status: b.status === 'confirmed' ? '已签到' : '已到课', tone: 'success' }
  }
  if (b.attendance === 'no_show') return { status: '缺席', tone: 'danger' }
  return {
    status: BOOKING_STATUS[b.status],
    tone:
      b.status === 'pending_payment' ? 'warning' : b.status === 'confirmed' ? 'primary' : 'default',
  }
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
    ...statusOf(b),
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
    // A lesson opens for check-in 30 minutes before it starts and closes when it ends.
    this.timer = setInterval(() => {
      if (this.data.scope === 'upcoming' && this.data.state === 'ready') this.load()
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

  async load() {
    const request = ++this.request
    if (!this.data.lessons.length) this.setData({ state: 'loading' })
    try {
      const rows = await api<BookingDto[]>('GET', `/bookings?scope=${this.data.scope}`)
      if (request !== this.request) return
      const open = rows.find((b) => b.canCheckIn)
      const now = new Date(serverNow())
      this.setData({
        state: 'ready',
        lessons: rows.map((b) => view(b, now)),
        checkIn: this.data.scope === 'upcoming' && open ? view(open, now) : null,
      })
    } catch (e) {
      if (request !== this.request) return
      // A failed refresh keeps what is on screen.
      if (this.data.state === 'ready') showError(e)
      else this.setData({ state: 'error', error: errorMessage(e) })
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
