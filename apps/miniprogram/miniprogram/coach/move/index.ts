import {
  type CoachLessonDto,
  type CoachMeDto,
  type OpenTimeDto,
  venueDateKey,
} from '../../lib/shared'
import { ApiError, errorMessage } from '../../utils/api'
import { bookableDays, dateText, dayAnchor, lessonTime, time } from '../../utils/format'
import { leaveMove, submitMove } from '../../utils/move'
import { askForNotices, coachApi } from '../utils/coach-api'

interface DayView {
  key: string
  label: string
  date: string
  free: number
}

interface SlotView {
  key: string
  time: string
  startsAt: string
  /** Refused for this lesson, say when the student has another lesson then. */
  refused?: boolean
  /** Every table is in use then. */
  full?: boolean
}

Page({
  data: {
    state: 'loading' as 'loading' | 'ready' | 'error',
    error: '',
    errorIcon: { name: 'error-circle', size: '112rpx' },
    /** The lesson can no longer move, so reloading would not help. */
    fixed: false,
    emptyIcon: { name: 'time', size: '112rpx' },
    current: '',
    student: '',
    days: [] as DayView[],
    date: '',
    dayAnchor: '',
    slots: [] as SlotView[],
    picked: null as SlotView | null,
    pickedDay: '',
    submitting: false,
  },

  id: 0,
  coachId: 0,
  /** Times the server refused for this lesson, by start. */
  refused: new Set<string>(),
  free: [] as OpenTimeDto[],

  onLoad(query: Record<string, string | undefined>) {
    this.id = Number(query.id)
    // Its own set per page, not one shared through the page definition.
    this.refused = new Set()
    this.load()
  },

  async load() {
    try {
      const [lesson, me] = await Promise.all([
        coachApi<CoachLessonDto>('GET', `/lessons/${this.id}`),
        coachApi<CoachMeDto>('GET', '/me'),
      ])
      if (!lesson.canMove) {
        this.getOpenerEventChannel().emit?.('stale')
        this.setData({ state: 'error', fixed: true, error: '这节课现在不能改约' })
        return
      }
      this.coachId = me.id
      const strip = bookableDays(me.advanceDays)
      const first = strip[0]?.key ?? ''
      const last = strip[strip.length - 1]?.key ?? first
      // Start times in the coach's own 排班 that fit the lesson, with its own time free.
      const times = await coachApi<OpenTimeDto[]>(
        'GET',
        `/move-times?bookingId=${this.id}&from=${first}&to=${last}`,
      )
      this.free = times.filter((t) => Date.parse(t.startsAt) > Date.now())
      const days = strip.map((d) => ({
        ...d,
        free: this.free.filter((s) => !s.tableFull && venueDateKey(new Date(s.startsAt)) === d.key)
          .length,
      }))
      const own = venueDateKey(new Date(lesson.startsAt))
      const date = days.some((d) => d.key === own) ? own : first
      this.setData({
        state: 'ready',
        current: lessonTime(lesson.startsAt, lesson.endsAt),
        student: lesson.student.name || '未填写姓名',
        days,
        date,
        dayAnchor: dayAnchor(days, date),
      })
      this.showDay()
    } catch (e) {
      // Not this coach's lesson any more: reloading would not help.
      const gone = e instanceof ApiError && e.status === 404
      this.setData({ state: 'error', fixed: gone, error: errorMessage(e) })
    }
  },

  showDay() {
    this.setData({
      picked: null,
      slots: this.free
        .filter((s) => venueDateKey(new Date(s.startsAt)) === this.data.date)
        .map((s) => ({
          key: s.startsAt,
          time: time(s.startsAt),
          startsAt: s.startsAt,
          refused: this.refused.has(s.startsAt),
          full: s.tableFull,
        })),
    })
  },

  pickDate(e: WechatMiniprogram.TouchEvent) {
    askForNotices()
    const date = e.currentTarget.dataset.key as string
    if (date === this.data.date || this.data.submitting) return
    this.setData({ date })
    this.showDay()
  },

  pickSlot(e: WechatMiniprogram.TouchEvent) {
    const slot = this.data.slots[e.currentTarget.dataset.index as number]
    if (!slot || slot.refused || slot.full || this.data.submitting) return
    this.setData({ picked: slot, pickedDay: `${dateText(slot.startsAt)} ${slot.time}` })
  },

  async submit() {
    askForNotices()
    const slot = this.data.picked
    if (!slot || this.data.submitting) return
    this.setData({ submitting: true })
    const coachId = this.coachId
    const result = await submitMove(
      this,
      () =>
        coachApi<CoachLessonDto>('POST', `/lessons/${this.id}/move`, {
          coachId,
          startsAt: slot.startsAt,
        }),
      `/coach/lesson/index?id=${this.id}`,
    )
    if (result === 'moved' || result === 'fixed') return
    this.setData({ submitting: false })
    if (result === 'refused') {
      // Say the student has another lesson then: keep the time from being picked again.
      this.refused.add(slot.startsAt)
      this.showDay()
    } else if (result === 'gone') {
      this.setData({ state: 'loading' })
      this.load()
    }
  },

  leave() {
    leaveMove(`/coach/lesson/index?id=${this.id}`)
  },

  retry() {
    this.setData({ state: 'loading' })
    this.load()
  },
})
