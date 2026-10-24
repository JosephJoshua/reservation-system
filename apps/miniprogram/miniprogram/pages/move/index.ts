import {
  type BookingDto,
  type CatalogDto,
  cancelDeadline,
  type MeDto,
  type MoveOptionsDto,
  type SlotDto,
  venueDateKey,
} from '../../lib/shared'
import { api, assetUrl, errorMessage } from '../../utils/api'
import { askForNotices, getCatalog, getMe } from '../../utils/data'
import { bookableDays, dateText, dayAnchor, lessonTime, time } from '../../utils/format'
import { submitMove } from '../../utils/move'

interface CoachOption {
  id: number
  name: string
  avatar: string
}

interface SlotView {
  id: number
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
}

Page({
  data: {
    state: 'loading' as 'loading' | 'ready' | 'error',
    error: '',
    errorIcon: { name: 'error-circle', size: '112rpx' },
    emptyIcon: { name: 'time', size: '112rpx' },
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
  /** Times the server refused for this lesson. */
  refused: new Set<number>(),
  booking: null as BookingDto | null,
  catalog: null as CatalogDto | null,
  templates: {} as MeDto['noticeTemplates'],
  request: 0,

  onLoad(query: Record<string, string | undefined>) {
    this.id = Number(query.id)
    // Its own set per page, not one shared through the page definition.
    this.refused = new Set()
    this.load()
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
        this.setData({ state: 'error', error: '这节课现在不能改约' })
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
      const days = bookableDays(catalog.booking.advanceDays)
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
            ? `改约后原时段将释放，之后还可再改约 ${booking.movesLeft - 1} 次。`
            : '改约后原时段将释放，之后不能再改约。',
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
      const length = Date.parse(booking.endsAt) - Date.parse(booking.startsAt)
      const now = Date.now()
      const notice = (this.catalog?.booking.minNoticeMinutes ?? 0) * 60_000
      // A group class moves to another session of the same class, a private lesson to a private slot.
      const sessionOf = booking.capacity > 1 ? booking.lessonType.id : null
      const slots = rows
        .filter(
          (s) =>
            Date.parse(s.startsAt) > now &&
            Date.parse(s.endsAt) - Date.parse(s.startsAt) === length &&
            s.lessonTypeId === sessionOf,
        )
        .map((s) => {
          const current = s.coachId === booking.coach.id && s.startsAt === booking.startsAt
          return {
            id: s.id,
            coachId: s.coachId,
            time: time(s.startsAt),
            startsAt: s.startsAt,
            endsAt: s.endsAt,
            available: s.available && !current && !this.refused.has(s.id),
            current,
            closed: !s.available && Date.parse(s.startsAt) - now < notice,
            refused: this.refused.has(s.id),
            seatsLeft: sessionOf === null ? null : s.seatsLeft,
          }
        })
      this.setData({ slotsState: 'ready', slots })
    } catch (e) {
      if (request !== this.request) return
      this.setData({ slotsState: 'error', slotsError: errorMessage(e) })
    }
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
    const rules = this.catalog?.booking
    // A time the student picks is free to cancel only until its usual deadline, which may be past.
    const late = rules
      ? cancelDeadline(new Date(slot.startsAt), rules).getTime() < Date.now()
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
    if (!slot || this.data.submitting) return
    this.setData({ submitting: true })
    const result = await submitMove(this, async () => {
      // Asked inside the tap, before any await, or WeChat does not show the prompt.
      await askForNotices(this.templates, ['moved', 'reminder', 'cancelled'])
      return api<BookingDto>('POST', `/bookings/${this.id}/move`, { slotId: slot.id })
    })
    if (result === 'moved' || result === 'fixed') return
    this.setData({ submitting: false })
    if (result === 'refused') this.refuse(slot.id)
    // The picked time went: taken, closed or too close now. Show what is left.
    else if (result === 'gone') this.loadSlots()
  },

  /** Marks a time the server refused for this lesson, so it is not picked again. */
  refuse(id: number) {
    this.refused.add(id)
    const index = this.data.slots.findIndex((s) => s.id === id)
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
})
