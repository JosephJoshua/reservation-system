import { type SlotDto, venueDateKey } from '../../lib/shared'
import { api, assetUrl, errorMessage, serverNow } from '../../utils/api'
import { catalogFetchedAt, getCatalog } from '../../utils/data'
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

/** Whether a load may move to another day, and whether it says so ('quiet' on first load). */
type Seek = 'quiet' | 'tell'

interface SlotView {
  /** A group session's id; null for a private lesson time, booked by coach and start. */
  id: number | null
  key: string
  coachId: number
  coachName: string
  time: string
  startsAt: string
  endsAt: string
  available: boolean
  closed: boolean
  /** Seats left in a group session; null for a private slot. */
  seatsLeft: number | null
  /** The student's own booking in this session: 待支付 or 已报名, opened on a tap. */
  mine: string
  bookingId: number | null
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
    /** Students per session, more than 1 for a group class. */
    capacity: 1,
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

  /** The lesson type's notice: a time closer than this to now cannot be booked. */
  noticeMs: 0,
  /** When the catalog this page shows was fetched. */
  catalogAt: 0,
  request: 0,
  /** Set by chooseCoach for the load onShow runs when the coach page goes back here. */
  pendingSeek: undefined as Seek | undefined,

  onLoad(query: Record<string, string | undefined>) {
    this.setData({
      lessonTypeId: Number(query.lessonTypeId),
      coachId: Number(query.coachId ?? 0),
    })
    this.load('quiet')
  },

  onShow() {
    // Coming back from a booking that lost the race should show the slot as taken.
    if (this.data.state !== 'ready') return
    const seek = this.pendingSeek
    this.pendingSeek = undefined
    // Another page refreshed the catalog meanwhile, say after a coach or lesson was turned off,
    // or the page was left open past midnight and the day strip has moved.
    const today = venueDateKey(new Date(serverNow()))
    if (catalogFetchedAt() !== this.catalogAt || this.data.days[0]?.key !== today) this.load(seek)
    else this.loadSlots(seek)
  },

  /** `seek` is for the slots load that follows; the first load is 'quiet'. */
  async load(seek?: Seek) {
    try {
      const catalog = await getCatalog()
      this.catalogAt = catalogFetchedAt()
      const lessonType = catalog.lessonTypes.find((t) => t.id === this.data.lessonTypeId)
      if (!lessonType) {
        this.setData({ state: 'error', error: '这门课程已下架' })
        return
      }
      this.noticeMs = lessonType.rules.minNoticeMinutes * 60_000
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
      const days = bookableDays(lessonType.rules.advanceDays, serverNow())
      const coachId = coaches.some((c) => c.id === this.data.coachId)
        ? this.data.coachId
        : coaches.length === 1
          ? (coaches[0]?.id ?? 0)
          : 0
      this.setData({
        state: 'ready',
        lessonName: lessonType.name,
        duration: lessonType.durationMinutes,
        capacity: lessonType.capacity,
        coaches,
        coachId,
        picked: coaches.find((c) => c.id === coachId) ?? null,
        days,
        // A reload keeps the day the student was looking at.
        date: days.some((d) => d.key === this.data.date) ? this.data.date : (days[0]?.key ?? ''),
      })
      this.loadSlots(seek)
    } catch (e) {
      this.setData({ state: 'error', error: errorMessage(e) })
    }
  },

  /**
   * Loads the selected day's slots. With `seek`, a day with nothing to book moves on to the next
   * open day after it, or the first one in the window; 'tell' says so in a toast once `moved`
   * loads.
   */
  async loadSlots(seek?: Seek, moved = false) {
    const request = ++this.request
    const { date, coachId, lessonTypeId, coaches } = this.data
    this.setData({ slotsState: 'loading' })
    try {
      const filter = `lessonTypeId=${lessonTypeId}${coachId ? `&coachId=${coachId}` : ''}`
      // Asked for alongside the day, and only a hint: without it the page stays on the day.
      const openDays = seek
        ? api<string[]>('GET', `/slots/open-days?${filter}`).catch((): string[] => [])
        : undefined
      const rows = await api<SlotDto[]>('GET', `/slots?date=${date}&${filter}`)
      if (request !== this.request) return
      const names = new Map(coaches.map((c) => [c.id, c.name]))
      const now = serverNow()
      const notice = this.noticeMs
      const slots = rows
        .filter((s) => names.has(s.coachId) && Date.parse(s.startsAt) > now)
        .map((s) => ({
          id: s.id,
          key: s.id === null ? `${s.coachId}@${s.startsAt}` : `s${s.id}`,
          coachId: s.coachId,
          coachName: names.get(s.coachId) ?? '',
          time: time(s.startsAt),
          startsAt: s.startsAt,
          endsAt: s.endsAt,
          available: s.available,
          // Too close to start to book online, as opposed to booked by someone else.
          closed: !s.available && Date.parse(s.startsAt) - now < notice,
          seatsLeft: s.lessonTypeId === null ? null : s.seatsLeft,
          mine: s.mine ? (s.mine.status === 'pending_payment' ? '待支付' : '已报名') : '',
          bookingId: s.mine?.bookingId ?? null,
        }))
      const availableCount = slots.filter((s) => s.available).length
      if (openDays && availableCount === 0) {
        const open = await openDays
        if (request !== this.request) return
        const keys = new Set(this.data.days.map((d) => d.key))
        const shown = open.filter((k) => keys.has(k))
        const next = shown.find((k) => k > date) ?? shown[0]
        if (next && next !== date) {
          this.setData({ date: next, dayAnchor: dayAnchor(this.data.days, next) })
          this.loadSlots(undefined, seek === 'tell')
          return
        }
      }
      this.setData({ slotsState: 'ready', slots, availableCount })
      const day = this.data.days.find((d) => d.key === date)
      if (moved && day && availableCount > 0) {
        wx.showToast({ title: `当天没有可约时段，已跳到 ${day.date}`, icon: 'none' })
      }
    } catch (e) {
      if (request !== this.request) return
      this.setData({ slotsState: 'error', error: errorMessage(e) })
    }
  },

  retrySlots() {
    this.loadSlots()
  },

  pickCoach(e: WechatMiniprogram.TouchEvent) {
    const coachId = Number(e.currentTarget.dataset.id)
    if (coachId === this.data.coachId) return
    this.setData({ coachId, picked: this.data.coaches.find((c) => c.id === coachId) ?? null })
    // Stay on the selected day if the coach has time then, else move to their next open day.
    this.loadSlots('tell')
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
    this.pendingSeek = 'tell'
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
    this.setData({ date })
    this.loadSlots()
  },

  pickSlot(e: WechatMiniprogram.TouchEvent) {
    const slot = this.data.slots[e.currentTarget.dataset.index as number]
    // Booked already: open that booking, to pay for or cancel it there.
    if (slot?.bookingId) {
      navigateOnce(`/pages/booking-detail/index?id=${slot.bookingId}`)
      return
    }
    if (!slot?.available) return
    const query = [
      ...(slot.id === null ? [] : [`slotId=${slot.id}`]),
      `lessonTypeId=${this.data.lessonTypeId}`,
      `coachId=${slot.coachId}`,
      `startsAt=${encodeURIComponent(slot.startsAt)}`,
      `endsAt=${encodeURIComponent(slot.endsAt)}`,
    ].join('&')
    navigateOnce(`/pages/confirm/index?${query}`)
  },

  retry() {
    this.setData({ state: 'loading' })
    this.load('quiet')
  },

  onShareAppMessage() {
    const { lessonTypeId, lessonName, coachId } = this.data
    return {
      title: lessonName || '课程预约',
      path: `/pages/book/index?lessonTypeId=${lessonTypeId}${coachId ? `&coachId=${coachId}` : ''}`,
    }
  },
})
