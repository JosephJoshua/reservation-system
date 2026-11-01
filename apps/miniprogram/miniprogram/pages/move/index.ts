import {
  type BookingDto,
  type CatalogDto,
  cancelDeadline,
  type MeDto,
  type MoveOptionsDto,
  type SlotDto,
  venueDateKey,
} from '../../lib/shared'
import { api, assetUrl, errorMessage, serverNow } from '../../utils/api'
import { askForNotices, getCatalog, getMe } from '../../utils/data'
import { edgeWait, nextMidnight } from '../../utils/edge'
import { bookableDays, dateText, dayAnchor, lessonTime, time } from '../../utils/format'
import { leaveMove, submitMove } from '../../utils/move'

/** Why a lesson the student opened 改约 for can no longer move. */
function whyFixed(b: BookingDto): string {
  if (b.status !== 'confirmed' || Date.parse(b.startsAt) <= serverNow()) return '这节课现在不能改约'
  if (b.movedFrom && b.movesLeft === 0) return '改约次数已用完'
  if (Date.parse(b.cancelDeadline) <= serverNow()) return '已过改约截止时间，如需调整请联系场馆'
  return '这节课现在不能改约'
}

interface CoachOption {
  id: number
  name: string
  avatar: string
}

interface SlotView {
  /** A group session's id; null for a private lesson time, moved to by coach and start. */
  id: number | null
  key: string
  coachId: number
  time: string
  startsAt: string
  endsAt: string
  available: boolean
  current: boolean
  /** Too close to start to book online, as opposed to taken. */
  closed: boolean
  /** Refused for this lesson, say by a package that ends before it. */
  refused: boolean
  /** Seats left in a group session; null for a private slot. */
  seatsLeft: number | null
  /** The student's own other booking in this session: 待支付 or 已报名. */
  mine: string
}

Page({
  data: {
    state: 'loading' as 'loading' | 'ready' | 'error',
    error: '',
    errorIcon: { name: 'error-circle', size: '112rpx' },
    emptyIcon: { name: 'time', size: '112rpx' },
    /** The lesson can no longer move, so reloading would not help. */
    fixed: false,
    current: '',
    coaches: [] as CoachOption[],
    coachId: 0,
    days: [] as { key: string; label: string; date: string }[],
    date: '',
    dayAnchor: '',
    slotsState: 'loading' as 'loading' | 'ready' | 'error',
    slotsError: '',
    slots: [] as SlotView[],
    picked: null as SlotView | null,
    pickedDay: '',
    pickedSub: '',
    note: '',
    submitting: false,
  },

  id: 0,
  /** Times the server refused for this lesson, by key. */
  refused: new Set<string>(),
  booking: null as BookingDto | null,
  catalog: null as CatalogDto | null,
  templates: {} as MeDto['noticeTemplates'],
  request: 0,
  /** The selected day's times as fetched, redrawn as they pass. */
  rows: [] as SlotDto[],
  edgeTimer: 0 as number,
  /** Behind another page or gone: no edge timer then, onShow sets one again. */
  hidden: false,

  onLoad(query: Record<string, string | undefined>) {
    this.id = Number(query.id)
    // Its own set per page, not one shared through the page definition.
    this.refused = new Set()
    this.load()
  },

  onShow() {
    this.hidden = false
    // Left open past midnight: the day strip has moved.
    const today = venueDateKey(new Date(serverNow()))
    const { state, submitting, days } = this.data
    if (state === 'ready' && !submitting && days[0]?.key !== today) this.load()
    // Its timer was stopped while hidden, and an edge may have passed meanwhile.
    else if (state === 'ready' && this.booking) this.onEdge(this.booking)
  },

  onHide() {
    this.hidden = true
    this.clearEdge()
  },

  onUnload() {
    this.hidden = true
    this.clearEdge()
  },

  async load() {
    try {
      const [booking, options, catalog, me] = await Promise.all([
        api<BookingDto>('GET', `/bookings/${this.id}`),
        api<MoveOptionsDto>('GET', `/bookings/${this.id}/move-options`),
        getCatalog(),
        getMe(),
      ])
      if (!booking.canMove) {
        this.getOpenerEventChannel().emit?.('stale')
        this.setData({ state: 'error', fixed: true, error: whyFixed(booking) })
        return
      }
      if (!options.coachIds.length) {
        this.setData({ state: 'error', error: '暂时没有可改约的教练，请联系场馆' })
        return
      }
      this.booking = booking
      this.catalog = catalog
      this.templates = me.noticeTemplates
      const coaches = options.coachIds.flatMap((id): CoachOption[] => {
        const c = catalog.coaches.find((coach) => coach.id === id)
        return c ? [{ id, name: c.name, avatar: c.avatarUrl ? assetUrl(c.avatarUrl) : '' }] : []
      })
      const days = bookableDays(booking.window.advanceDays, serverNow())
      // Open on the lesson's own day, where nearby times are the likely pick.
      const date = days.some((d) => d.key === venueDateKey(new Date(booking.startsAt)))
        ? venueDateKey(new Date(booking.startsAt))
        : (days[0]?.key ?? '')
      this.setData({
        state: 'ready',
        current: `${lessonTime(booking.startsAt, booking.endsAt)} · ${booking.coach.name}`,
        coaches,
        coachId: coaches.some((c) => c.id === booking.coach.id)
          ? booking.coach.id
          : (coaches[0]?.id ?? 0),
        days,
        date,
        dayAnchor: dayAnchor(days, date),
        note:
          booking.movesLeft > 1
            ? `改约后，原时段会被释放，之后还可以再改约 ${booking.movesLeft - 1} 次。`
            : '改约后，原时段会被释放，之后不能再改约。',
      })
      this.loadSlots()
    } catch (e) {
      this.setData({ state: 'error', error: errorMessage(e) })
    }
  },

  async loadSlots() {
    const request = ++this.request
    const { date, coachId } = this.data
    const booking = this.booking
    if (!booking) return
    this.setData({ slotsState: 'loading', picked: null })
    try {
      // Filtered by the lesson's own length rather than the lesson type's, which may have changed.
      const rows = await api<SlotDto[]>(
        'GET',
        `/slots?date=${date}&coachId=${coachId}&moving=${booking.id}`,
      )
      if (request !== this.request) return
      this.rows = rows
      const slots: SlotView[] = this.slotViews(booking)
      this.setData({ slotsState: 'ready', slots })
      this.scheduleEdge()
    } catch (e) {
      if (request !== this.request) return
      this.setData({ slotsState: 'error', slotsError: errorMessage(e) })
    }
  },

  /**
   * The day's times as of now: past ones dropped, those now inside the notice shown closed, and
   * the times the server refused kept refused.
   */
  slotViews(booking: BookingDto): SlotView[] {
    const length = Date.parse(booking.endsAt) - Date.parse(booking.startsAt)
    const now = serverNow()
    const notice = booking.window.minNoticeMinutes * 60_000
    // A group class moves to another session of the same class, a private lesson to a private slot.
    const sessionOf = booking.capacity > 1 ? booking.lessonType.id : null
    return this.rows
      .filter(
        (s) =>
          Date.parse(s.startsAt) > now &&
          Date.parse(s.endsAt) - Date.parse(s.startsAt) === length &&
          s.lessonTypeId === sessionOf,
      )
      .map((s) => {
        const current = s.coachId === booking.coach.id && s.startsAt === booking.startsAt
        const key = s.id === null ? `${s.coachId}@${s.startsAt}` : `s${s.id}`
        const tooSoon = Date.parse(s.startsAt) - now < notice
        return {
          id: s.id,
          key,
          coachId: s.coachId,
          time: time(s.startsAt),
          startsAt: s.startsAt,
          endsAt: s.endsAt,
          available: s.available && !tooSoon && !current && !this.refused.has(key),
          current,
          closed: tooSoon,
          refused: this.refused.has(key),
          seatsLeft: sessionOf === null ? null : s.seatsLeft,
          mine:
            s.mine && !current ? (s.mine.status === 'pending_payment' ? '待支付' : '已报名') : '',
        }
      })
  },

  /**
   * Redraws the day as its next time comes inside the notice or starts, and shows the lesson as
   * fixed once its own 改约 deadline passes, as the server would refuse the move then.
   */
  scheduleEdge() {
    this.clearEdge()
    const booking = this.booking
    if (this.hidden || !booking) return
    const now = serverNow()
    const wait = edgeWait(
      [
        Date.parse(booking.cancelDeadline),
        // 今天 and the day strip move on then.
        nextMidnight(now),
        ...this.rows.flatMap((s) => [
          Date.parse(s.startsAt) - booking.window.minNoticeMinutes * 60_000,
          Date.parse(s.startsAt),
        ]),
      ],
      now,
    )
    if (wait === null) return
    this.edgeTimer = setTimeout(() => this.onEdge(booking), wait) as unknown as number
  },

  /** At an edge; while a move is being sent or the times are loading, it looks again shortly. */
  onEdge(booking: BookingDto) {
    this.edgeTimer = 0
    if (this.hidden || this.data.state !== 'ready') return
    if (this.data.submitting || this.data.slotsState === 'loading') {
      this.edgeTimer = setTimeout(() => this.onEdge(booking), 1000) as unknown as number
      return
    }
    if (Date.parse(booking.cancelDeadline) < serverNow()) {
      this.getOpenerEventChannel().emit?.('stale')
      this.setData({ state: 'error', fixed: true, error: whyFixed(booking) })
      return
    }
    if (this.data.days[0]?.key !== venueDateKey(new Date(serverNow()))) {
      this.load()
      return
    }
    if (this.data.slotsState === 'ready') {
      const slots: SlotView[] = this.slotViews(booking)
      const picked = this.data.picked
      const still = picked && slots.find((s) => s.key === picked.key)?.available
      this.setData({ slots, ...(picked && !still ? { picked: null } : {}) })
    }
    // On a slots error too, so the lesson's own deadline still shows.
    this.scheduleEdge()
  },

  clearEdge() {
    if (this.edgeTimer) clearTimeout(this.edgeTimer)
    this.edgeTimer = 0
  },

  pickCoach(e: WechatMiniprogram.TouchEvent) {
    const coachId = Number(e.currentTarget.dataset.id)
    if (coachId === this.data.coachId || this.data.submitting) return
    this.setData({ coachId })
    this.loadSlots()
  },

  pickDate(e: WechatMiniprogram.TouchEvent) {
    const date = e.currentTarget.dataset.key as string
    if (date === this.data.date || this.data.submitting) return
    this.setData({ date })
    this.loadSlots()
  },

  pickSlot(e: WechatMiniprogram.TouchEvent) {
    const slot = this.data.slots[e.currentTarget.dataset.index as number]
    if (!slot?.available || this.data.submitting) return
    const coach = this.data.coaches.find((c) => c.id === slot.coachId)
    // The lesson keeps the cancel rules it was booked under.
    const rules = this.booking?.terms
    // A time the student picks is free to cancel only until its usual deadline, which may be past.
    const late = rules
      ? cancelDeadline(new Date(slot.startsAt), rules).getTime() < serverNow()
      : false
    this.setData({
      picked: slot,
      pickedDay: `${dateText(slot.startsAt)} ${slot.time}`,
      pickedSub: [
        this.data.coaches.length > 1 ? (coach?.name ?? '') : '',
        late ? '改约后不能免费取消' : '',
      ]
        .filter(Boolean)
        .join(' · '),
    })
  },

  async submit() {
    const slot = this.data.picked
    const booking = this.booking
    if (!slot || this.data.submitting) return
    this.setData({ submitting: true })
    const result = await submitMove(
      this,
      async () => {
        // Asked inside the tap, before any await, or WeChat does not show the prompt.
        await askForNotices(this.templates, ['moved', 'reminder', 'cancelled'])
        return api<BookingDto>('POST', `/bookings/${this.id}/move`, {
          ...(slot.id === null
            ? { coachId: slot.coachId, startsAt: slot.startsAt }
            : { slotId: slot.id }),
          // Where this page showed the lesson, so a move made elsewhere meanwhile is refused.
          ...(booking ? { from: { coachId: booking.coach.id, startsAt: booking.startsAt } } : {}),
        })
      },
      `/pages/booking-detail/index?id=${this.id}`,
    )
    if (result === 'moved' || result === 'fixed' || result === 'unknown') return
    this.setData({ submitting: false })
    if (result === 'refused') this.refuse(slot.key)
    // The picked time went: taken, closed or too close now. Show what is left.
    else if (result === 'gone') this.loadSlots()
  },

  /** Marks a time the server refused for this lesson, so it is not picked again. */
  refuse(key: string) {
    this.refused.add(key)
    const index = this.data.slots.findIndex((s) => s.key === key)
    if (index < 0) return
    this.setData({
      picked: null,
      [`slots[${index}].available`]: false,
      [`slots[${index}].refused`]: true,
    })
  },

  retry() {
    this.setData({ state: 'loading' })
    this.load()
  },

  leave() {
    leaveMove(`/pages/booking-detail/index?id=${this.id}`)
  },
})
