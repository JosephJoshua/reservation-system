import { type CoachMeDto, type CoachSlotDto, venueDateKey } from '../../lib/shared'
import { errorMessage, showError } from '../../utils/api'
import { dayName, monthDay, time, weekday } from '../../utils/format'
import { isTop, navigateOnce } from '../../utils/nav'
import { askForNotices, coachApi, isNotBound, remember } from '../utils/coach-api'
import { lessonTag } from '../utils/labels'

const DAY = 24 * 60 * 60 * 1000
/** Past days stay on the strip so the coach can still mark attendance. */
const PAST_DAYS = 7

interface DayView {
  key: string
  label: string
  date: string
  past: boolean
  lessons: number
}

interface SlotView {
  id: number
  kind: 'lesson' | 'session' | 'free' | 'closed' | 'past'
  start: string
  end: string
  bookingId: number
  student: string
  lesson: string
  label: string
  tag: string
  tone: string
}

function slotView(s: CoachSlotDto, now: number): SlotView {
  const base = {
    id: s.id,
    start: time(s.startsAt),
    end: time(s.endsAt),
    bookingId: 0,
    student: '',
    lesson: '',
    label: '',
    tag: '',
    tone: 'default',
  }
  if (s.group) {
    const g = s.group
    return {
      ...base,
      kind: 'session',
      student: g.lessonTypeName,
      lesson: `已报名 ${g.booked}/${g.capacity} 人`,
      tag: g.cancelled ? '已取消' : '小班课',
      tone: g.cancelled ? 'default' : 'primary',
    }
  }
  if (s.lesson) {
    const tag = lessonTag(s.lesson, s.startsAt, now)
    return {
      ...base,
      kind: 'lesson',
      bookingId: s.lesson.bookingId,
      student: s.lesson.studentName || '未填写姓名',
      lesson: s.lesson.isTrial ? `${s.lesson.lessonTypeName} · 体验` : s.lesson.lessonTypeName,
      tag: tag.text,
      tone: tag.tone,
    }
  }
  if (Date.parse(s.startsAt) <= now) return { ...base, kind: 'past', label: '未预约' }
  return s.open
    ? { ...base, kind: 'free', label: s.tableFull ? '球台已满' : '空闲' }
    : { ...base, kind: 'closed', label: '已关闭' }
}

Page({
  data: {
    state: 'loading' as 'loading' | 'ready' | 'error',
    error: '',
    errorIcon: { name: 'error-circle', size: '112rpx' },
    emptyIcon: { name: 'calendar', size: '112rpx' },
    days: [] as DayView[],
    date: '',
    dayAnchor: '',
    slotsState: 'ready' as 'ready' | 'error',
    slots: [] as SlotView[],
    summary: '',
    dayEmpty: '',
  },

  me: null as CoachMeDto | null,
  schedule: [] as CoachSlotDto[],
  request: 0,
  slotBusy: false,

  onLoad() {
    this.load()
  },

  onShow() {
    if (this.data.state !== 'ready') return
    // Left open past midnight: today and the day strip have moved.
    if (this.data.days[PAST_DAYS]?.key !== venueDateKey(new Date())) {
      this.load()
      return
    }
    // Back from a lesson: attendance or a cancel changes the list.
    this.loadSchedule()
  },

  onPullDownRefresh() {
    this.loadSchedule().finally(() => wx.stopPullDownRefresh())
  },

  async load() {
    try {
      const me = await coachApi<CoachMeDto>('GET', '/me')
      this.me = me
      remember(me)
      const now = Date.now()
      const today = venueDateKey(new Date(now))
      const days = Array.from({ length: PAST_DAYS + me.advanceDays + 1 }, (_, i) => {
        const at = new Date(now + (i - PAST_DAYS) * DAY)
        const near = i >= PAST_DAYS && i - PAST_DAYS <= 2
        return {
          key: venueDateKey(at),
          label: near ? dayName(at) : weekday(at),
          date: monthDay(at),
          past: i < PAST_DAYS,
          lessons: 0,
        }
      })
      const yesterday = days[PAST_DAYS - 1]?.key ?? today
      this.setData({ days, date: today, dayAnchor: `day-${yesterday}` })
      await this.loadSchedule()
      this.setData({ state: 'ready' })
    } catch (e) {
      // Left for another page meanwhile: the error state's retry gets here again.
      if (isNotBound(e) && isTop(this)) {
        wx.redirectTo({ url: '/coach/bind/index' })
        return
      }
      this.setData({ state: 'error', error: errorMessage(e) })
    }
  },

  async loadSchedule() {
    const { days } = this.data
    const first = days[0]?.key
    const last = days[days.length - 1]?.key
    if (!first || !last) return
    const request = ++this.request
    try {
      const rows = await coachApi<CoachSlotDto[]>('GET', `/schedule?from=${first}&to=${last}`)
      if (request !== this.request) return
      this.schedule = rows
      const counts = new Map<string, number>()
      for (const s of rows) {
        // A group session counts once it has students and is still on.
        if (!s.lesson && !(s.group && s.group.booked > 0 && !s.group.cancelled)) continue
        const key = venueDateKey(new Date(s.startsAt))
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      this.setData({
        slotsState: 'ready',
        days: days.map((d) => ({ ...d, lessons: counts.get(d.key) ?? 0 })),
      })
      this.showDay()
    } catch (e) {
      if (request !== this.request) return
      if (this.data.state === 'ready') this.setData({ slotsState: 'error', error: errorMessage(e) })
      else throw e
    }
  },

  showDay() {
    const now = Date.now()
    const slots = this.schedule
      .filter((s) => venueDateKey(new Date(s.startsAt)) === this.data.date)
      .map((s) => slotView(s, now))
    const lessons = slots.filter((s) => s.kind === 'lesson' || s.kind === 'session').length
    const free = slots.filter((s) => s.kind === 'free').length
    const parts = [lessons ? `${lessons} 节课` : '没有预约', free ? `${free} 个空闲时段` : '']
    const past = this.data.date < venueDateKey(new Date(now))
    this.setData({
      slots,
      summary: parts.filter(Boolean).join(' · '),
      dayEmpty: past ? '这天没有课程' : '这天没有排课，可以在可约时间里设置',
    })
  },

  pickDate(e: WechatMiniprogram.TouchEvent) {
    askForNotices()
    const date = e.currentTarget.dataset.key as string
    if (date === this.data.date) return
    this.setData({ date })
    this.showDay()
  },

  openSlot(e: WechatMiniprogram.TouchEvent) {
    const slot = this.data.slots[e.currentTarget.dataset.index as number]
    if (!slot || slot.kind === 'past') return
    askForNotices()
    if (slot.kind === 'lesson') {
      navigateOnce(`/coach/lesson/index?id=${slot.bookingId}`)
      return
    }
    if (slot.kind === 'session') {
      navigateOnce(`/coach/session/index?id=${slot.id}`)
      return
    }
    if (this.slotBusy) return
    // Held from the sheet until the change is saved, so a double tap acts once.
    this.slotBusy = true
    const open = slot.kind === 'closed'
    wx.showActionSheet({
      itemList: [open ? '开放此时段' : '关闭此时段'],
      success: async () => {
        try {
          await coachApi('PUT', `/slots/${slot.id}`, { open })
          wx.showToast({ title: open ? '已开放' : '已关闭', icon: 'success' })
        } catch (err) {
          showError(err)
        } finally {
          this.slotBusy = false
        }
        await this.loadSchedule()
      },
      fail: () => {
        this.slotBusy = false
      },
    })
  },

  openHours() {
    askForNotices()
    navigateOnce('/coach/hours/index')
  },

  retry() {
    this.setData({ state: 'loading' })
    this.load()
  },
})
