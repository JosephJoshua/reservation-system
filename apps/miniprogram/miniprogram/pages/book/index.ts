import { type CatalogDto, type SlotDto, venueDateKey } from '../../lib/shared'
import { api, assetUrl, errorMessage } from '../../utils/api'
import { getCatalog } from '../../utils/data'
import { dayName, monthDay, priceText, time, weekday } from '../../utils/format'

interface CoachOption {
  id: number
  name: string
  title: string
  avatar: string
  price: string
  original: string
}

interface SlotView {
  id: number
  coachId: number
  coachName: string
  time: string
  startsAt: string
  endsAt: string
  available: boolean
  closed: boolean
}

const DAY = 24 * 60 * 60 * 1000

Page({
  data: {
    state: 'loading' as 'loading' | 'ready' | 'error',
    error: '',
    errorIcon: { name: 'error-circle', size: '112rpx' },
    emptyIcon: { name: 'time', size: '112rpx' },
    lessonTypeId: 0,
    lessonName: '',
    duration: 0,
    coaches: [] as CoachOption[],
    coachId: 0,
    days: [] as { key: string; label: string; date: string }[],
    date: '',
    /** The day before the selected one, so the selection is not flush with the screen edge. */
    dayAnchor: '',
    slotsState: 'loading' as 'loading' | 'ready' | 'error',
    slots: [] as SlotView[],
    availableCount: 0,
  },

  catalog: null as CatalogDto | null,
  request: 0,
  /** Until the student picks a day, skip ahead past days with nothing to book. */
  autoAdvance: true,

  onLoad(query: Record<string, string | undefined>) {
    this.setData({
      lessonTypeId: Number(query.lessonTypeId),
      coachId: Number(query.coachId ?? 0),
    })
    this.load()
  },

  onShow() {
    // Coming back from a booking that lost the race should show the slot as taken.
    if (this.data.state === 'ready') this.loadSlots()
  },

  async load() {
    try {
      const catalog = await getCatalog()
      this.catalog = catalog
      const lessonType = catalog.lessonTypes.find((t) => t.id === this.data.lessonTypeId)
      if (!lessonType) {
        this.setData({ state: 'error', error: '该课程已下架' })
        return
      }
      wx.setNavigationBarTitle({ title: lessonType.name })
      const coaches = catalog.coaches.flatMap((c): CoachOption[] => {
        const lesson = c.lessons.find((l) => l.lessonTypeId === lessonType.id)
        if (!lesson) return []
        return [
          {
            id: c.id,
            name: c.name,
            title: c.title,
            avatar: c.avatarUrl ? assetUrl(c.avatarUrl) : '',
            ...priceText(lesson.price),
          },
        ]
      })
      const now = Date.now()
      const days = Array.from({ length: catalog.booking.advanceDays + 1 }, (_, i) => {
        const at = new Date(now + i * DAY)
        return {
          key: venueDateKey(at),
          label: i < 3 ? dayName(at) : weekday(at),
          date: monthDay(at),
        }
      })
      const coachId = coaches.some((c) => c.id === this.data.coachId)
        ? this.data.coachId
        : coaches.length === 1
          ? (coaches[0]?.id ?? 0)
          : 0
      this.setData({
        state: 'ready',
        lessonName: lessonType.name,
        duration: lessonType.durationMinutes,
        coaches,
        coachId,
        days,
        date: days[0]?.key ?? '',
      })
      this.loadSlots()
    } catch (e) {
      this.setData({ state: 'error', error: errorMessage(e) })
    }
  },

  async loadSlots() {
    const request = ++this.request
    const { date, coachId, lessonTypeId, coaches } = this.data
    this.setData({ slotsState: 'loading' })
    try {
      const query = `date=${date}&lessonTypeId=${lessonTypeId}${coachId ? `&coachId=${coachId}` : ''}`
      const rows = await api<SlotDto[]>('GET', `/slots?${query}`)
      if (request !== this.request) return
      const names = new Map(coaches.map((c) => [c.id, c.name]))
      const now = Date.now()
      const notice = (this.catalog?.booking.minNoticeMinutes ?? 0) * 60_000
      const slots = rows
        .filter((s) => names.has(s.coachId) && Date.parse(s.startsAt) > now)
        .map((s) => ({
          id: s.id,
          coachId: s.coachId,
          coachName: names.get(s.coachId) ?? '',
          time: time(s.startsAt),
          startsAt: s.startsAt,
          endsAt: s.endsAt,
          available: s.available,
          // Too close to start to book online, as opposed to booked by someone else.
          closed: !s.available && Date.parse(s.startsAt) - now < notice,
        }))
      const availableCount = slots.filter((s) => s.available).length
      const days = this.data.days
      const next = days[days.findIndex((d) => d.key === date) + 1]
      if (this.autoAdvance && availableCount === 0 && next) {
        this.setData({ date: next.key, dayAnchor: `day-${date}` })
        this.loadSlots()
        return
      }
      this.autoAdvance = false
      this.setData({ slotsState: 'ready', slots, availableCount })
    } catch (e) {
      if (request !== this.request) return
      this.setData({ slotsState: 'error', error: errorMessage(e) })
    }
  },

  pickCoach(e: WechatMiniprogram.TouchEvent) {
    const coachId = Number(e.currentTarget.dataset.id)
    if (coachId === this.data.coachId) return
    this.autoAdvance = false
    this.setData({ coachId })
    this.loadSlots()
  },

  pickDate(e: WechatMiniprogram.TouchEvent) {
    const date = e.currentTarget.dataset.key as string
    if (date === this.data.date) return
    this.autoAdvance = false
    this.setData({ date })
    this.loadSlots()
  },

  pickSlot(e: WechatMiniprogram.TouchEvent) {
    const slot = this.data.slots[e.currentTarget.dataset.index as number]
    if (!slot?.available) return
    const query = [
      `slotId=${slot.id}`,
      `lessonTypeId=${this.data.lessonTypeId}`,
      `coachId=${slot.coachId}`,
      `startsAt=${encodeURIComponent(slot.startsAt)}`,
      `endsAt=${encodeURIComponent(slot.endsAt)}`,
    ].join('&')
    wx.navigateTo({ url: `/pages/confirm/index?${query}` })
  },

  retry() {
    this.setData({ state: 'loading' })
    this.load()
  },
})
