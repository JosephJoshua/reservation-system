import type { CatalogDto, SlotDto } from '../../lib/shared'
import { api, assetUrl, errorMessage } from '../../utils/api'
import { getCatalog } from '../../utils/data'
import { bookableDays, dayAnchor, priceText, time } from '../../utils/format'
import { navigateOnce } from '../../utils/nav'

interface CoachOption {
  id: number
  name: string
  category: string
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
    /** The coach picked in the strip, for the line that links to their page. */
    picked: null as CoachOption | null,
    /** The list of coaches to read about, for students who have not picked one. */
    coachSheet: false,
    /** Scrolls the coach strip when a coach is picked from outside it. */
    coachAnchor: '',
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
  /**
   * While set, the day a search for an open day started from: a day with nothing to book moves on
   * to the next one, wrapping to today once, and the search ends back on this day if no day has
   * anything. Picking a day by hand ends it.
   */
  seekFrom: '',
  seekWrapped: false,
  /** Whether to say so when the search lands on another day: not on first load. */
  seekTell: false,

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
            category: c.category,
            title: c.title,
            avatar: c.avatarUrl ? assetUrl(c.avatarUrl) : '',
            ...priceText(lesson.price),
          },
        ]
      })
      const days = bookableDays(catalog.booking.advanceDays)
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
        picked: coaches.find((c) => c.id === coachId) ?? null,
        days,
        date: days[0]?.key ?? '',
      })
      this.seek(false)
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
      if (this.seekFrom && availableCount === 0) {
        const next = this.nextSeekDay(date) ?? (date === this.seekFrom ? '' : this.seekFrom)
        if (next === this.seekFrom) this.seekFrom = ''
        if (next) {
          this.setData({ date: next, dayAnchor: dayAnchor(this.data.days, next) })
          this.loadSlots()
          return
        }
      }
      const from = this.seekFrom
      this.seekFrom = ''
      this.setData({ slotsState: 'ready', slots, availableCount })
      const found = this.data.days.find((d) => d.key === date)
      if (from && from !== date && found && this.seekTell) {
        wx.showToast({ title: `当天无可约时段，已跳到 ${found.date}`, icon: 'none' })
      }
    } catch (e) {
      if (request !== this.request) return
      this.seekFrom = ''
      this.setData({ slotsState: 'error', error: errorMessage(e) })
    }
  },

  /** Starts a search for an open day from the selected one; the next loadSlots runs it. */
  seek(tell = true) {
    this.seekFrom = this.data.date
    this.seekWrapped = false
    this.seekTell = tell
  },

  /** The day after `date` in the search, or undefined once it is back where it started. */
  nextSeekDay(date: string): string | undefined {
    const days = this.data.days
    let next = days[days.findIndex((d) => d.key === date) + 1]
    if (!next && !this.seekWrapped) {
      this.seekWrapped = true
      next = days[0]
    }
    return next && next.key !== this.seekFrom ? next.key : undefined
  },

  pickCoach(e: WechatMiniprogram.TouchEvent) {
    const coachId = Number(e.currentTarget.dataset.id)
    if (coachId === this.data.coachId) return
    // Stay on the selected day if the coach has time then, else move to their next open day.
    this.seek()
    this.setData({ coachId, picked: this.data.coaches.find((c) => c.id === coachId) ?? null })
    this.loadSlots()
  },

  /**
   * Called by the coach page when the student books that coach from it, just before it goes back
   * here; onShow then loads the coach's slots, moving to their next open day if the selected one
   * has nothing.
   */
  chooseCoach(coachId: number) {
    const coaches = this.data.coaches
    const index = coaches.findIndex((c) => c.id === coachId)
    if (index < 0) return
    this.seek()
    // Coaches on the first screen keep the strip at its start; later ones bring the coach before
    // into view, so the picked one is not flush with the screen edge.
    const before = coaches[index - 1]
    this.setData({
      coachId,
      picked: coaches[index] ?? null,
      coachSheet: false,
      coachAnchor: index < 3 || !before ? 'coach-start' : `coach-${before.id}`,
    })
  },

  openCoach(e: WechatMiniprogram.TouchEvent) {
    const id = Number(e.currentTarget.dataset.id)
    if (id) navigateOnce(`/pages/coach-detail/index?id=${id}`)
  },

  showCoaches() {
    this.setData({ coachSheet: true })
  },

  onCoachSheet(e: WechatMiniprogram.CustomEvent<{ visible: boolean }>) {
    this.setData({ coachSheet: e.detail.visible })
  },

  pickDate(e: WechatMiniprogram.TouchEvent) {
    const date = e.currentTarget.dataset.key as string
    if (date === this.data.date) return
    this.seekFrom = ''
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
    navigateOnce(`/pages/confirm/index?${query}`)
  },

  retry() {
    this.setData({ state: 'loading' })
    this.load()
  },

  onShareAppMessage() {
    const { lessonTypeId, lessonName, coachId } = this.data
    return {
      title: lessonName || '课程预约',
      path: `/pages/book/index?lessonTypeId=${lessonTypeId}${coachId ? `&coachId=${coachId}` : ''}`,
    }
  },
})
