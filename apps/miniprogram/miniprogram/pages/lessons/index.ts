import type { BookingDto } from '../../lib/shared'
import { api, errorMessage } from '../../utils/api'
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
  tone: 'primary' | 'warning' | 'default'
}

function view(b: BookingDto): LessonView {
  return {
    id: b.id,
    day: dayName(b.startsAt).length <= 2 ? dayName(b.startsAt) : weekday(b.startsAt),
    date: monthDay(b.startsAt),
    time: `${time(b.startsAt)}-${time(b.endsAt)}`,
    name: b.lessonType.name,
    coach: b.coach.name,
    status: BOOKING_STATUS[b.status],
    feedback: b.hasFeedback,
    tone:
      b.status === 'pending_payment' ? 'warning' : b.status === 'confirmed' ? 'primary' : 'default',
  }
}

Page({
  data: {
    scope: 'upcoming' as Scope,
    state: 'loading' as 'loading' | 'ready' | 'error',
    error: '',
    lessons: [] as LessonView[],
    emptyIcon: { name: 'calendar', size: '112rpx' },
    errorIcon: { name: 'error-circle', size: '112rpx' },
  },

  request: 0,

  onShow() {
    this.load()
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
      this.setData({ state: 'ready', lessons: rows.map(view) })
    } catch (e) {
      if (request !== this.request) return
      this.setData({ state: 'error', error: errorMessage(e) })
    }
  },

  onScope(e: WechatMiniprogram.CustomEvent<{ value: Scope }>) {
    this.setData({ scope: e.detail.value, lessons: [] })
    this.load()
  },

  open(e: WechatMiniprogram.TouchEvent) {
    navigateOnce(`/pages/booking-detail/index?id=${e.currentTarget.dataset.id}`)
  },

  book() {
    wx.switchTab({ url: '/pages/booking/index' })
  },
})
