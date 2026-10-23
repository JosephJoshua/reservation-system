import {
  type CoachHoursDto,
  type SlotSyncDto,
  venueDateKey,
  type WeeklyHours,
  weeklyHoursError,
} from '../../lib/shared'
import { errorMessage, showError } from '../../utils/api'
import { dateText } from '../../utils/format'
import { coachApi } from '../utils/coach-api'
import { hhmm, WEEKDAYS } from '../utils/labels'

// Monday first, the way a coach plans a week.
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]

const toMinutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5))

function weekView(hours: WeeklyHours[]) {
  return WEEK_ORDER.map((weekday) => ({
    weekday,
    name: WEEKDAYS[weekday],
    windows: hours.flatMap((h, index) =>
      h.weekday === weekday
        ? [
            {
              index,
              time: `${hhmm(h.startMinute)}-${hhmm(h.endMinute)}`,
              sub: `每节 ${h.lessonMinutes} 分钟 · ${Math.floor((h.endMinute - h.startMinute) / h.lessonMinutes)} 节`,
            },
          ]
        : [],
    ),
  }))
}

function sortHours(hours: WeeklyHours[]) {
  return [...hours].sort((a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute)
}

/** Tells the coach about lessons still booked on a day off. */
function warnBooked(result: SlotSyncDto) {
  if (!result.bookedOnDaysOff) return false
  wx.showModal({
    title: '休息日还有课',
    content: `有 ${result.bookedOnDaysOff} 节课已被预约，请联系学员，或在课程详情里取消。`,
    showCancel: false,
    confirmText: '知道了',
  })
  return true
}

Page({
  data: {
    state: 'loading' as 'loading' | 'ready' | 'error',
    error: '',
    errorIcon: { name: 'error-circle', size: '112rpx' },
    emptyIcon: { name: 'time', size: '112rpx' },
    hours: [] as WeeklyHours[],
    week: [] as ReturnType<typeof weekView>,
    daysOff: [] as { key: string; text: string }[],
    lessonMinutes: [] as number[],
    advanceDays: 14,
    today: '',
    lastDay: '',
    dirty: false,
    saving: false,
    adding: false,
    addWeekday: 1,
    addName: '',
    addStart: '09:00',
    addEnd: '12:00',
    addMinutes: 60,
    addHint: '',
  },

  onLoad() {
    this.load()
  },

  async load() {
    try {
      const res = await coachApi<CoachHoursDto>('GET', '/hours')
      const now = Date.now()
      this.setData({
        state: 'ready',
        lessonMinutes: res.lessonMinutes,
        advanceDays: res.advanceDays,
        today: venueDateKey(new Date(now)),
        lastDay: venueDateKey(new Date(now + 365 * 86_400_000)),
        addMinutes: res.lessonMinutes[0] ?? 60,
      })
      this.setHours(res.hours, false)
      this.setDaysOff(res.daysOff)
    } catch (e) {
      this.setData({ state: 'error', error: errorMessage(e) })
    }
  },

  setHours(hours: WeeklyHours[], dirty = true) {
    const sorted = sortHours(hours)
    this.setData({ hours: sorted, week: weekView(sorted) })
    this.setDirty(dirty)
  },

  /** Going back with unsaved hours asks first. */
  setDirty(dirty: boolean) {
    this.setData({ dirty })
    if (dirty) wx.enableAlertBeforeUnload({ message: '每周时间还没保存，确定离开吗？' })
    else wx.disableAlertBeforeUnload()
  },

  setDaysOff(keys: string[]) {
    this.setData({
      daysOff: keys.map((key) => ({ key, text: dateText(`${key}T12:00:00+08:00`) })),
    })
  },

  openAdd(e: WechatMiniprogram.TouchEvent) {
    const weekday = Number(e.currentTarget.dataset.weekday)
    // Start after the day's last window, so adding an afternoon is two taps.
    const last = this.data.hours.filter((h) => h.weekday === weekday).pop()
    const start = last ? Math.min(last.endMinute + 60, 22 * 60) : 9 * 60
    this.setData({
      adding: true,
      addWeekday: weekday,
      addName: WEEKDAYS[weekday] ?? '',
      addStart: hhmm(start),
      addEnd: hhmm(Math.min(start + 3 * 60, 23 * 60 + 59)),
    })
    this.updateHint()
  },

  onPopup(e: WechatMiniprogram.CustomEvent<{ visible: boolean }>) {
    this.setData({ adding: e.detail.visible })
  },

  onStart(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ addStart: e.detail.value })
    this.updateHint()
  },

  onEnd(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ addEnd: e.detail.value })
    this.updateHint()
  },

  onMinutes(e: WechatMiniprogram.TouchEvent) {
    this.setData({ addMinutes: Number(e.currentTarget.dataset.minutes) })
    this.updateHint()
  },

  draft(): WeeklyHours {
    return {
      weekday: this.data.addWeekday,
      startMinute: toMinutes(this.data.addStart),
      endMinute: toMinutes(this.data.addEnd),
      lessonMinutes: this.data.addMinutes,
    }
  },

  updateHint() {
    const d = this.draft()
    const count = Math.floor((d.endMinute - d.startMinute) / d.lessonMinutes)
    const error = weeklyHoursError([...this.data.hours, d])
    this.setData({ addHint: error ?? `每${this.data.addName}生成 ${count} 节课` })
  },

  confirmAdd() {
    const hours = [...this.data.hours, this.draft()]
    const error = weeklyHoursError(hours)
    if (error) {
      wx.showToast({ title: error, icon: 'none' })
      return
    }
    this.setHours(hours)
    this.setData({ adding: false })
  },

  remove(e: WechatMiniprogram.TouchEvent) {
    const index = Number(e.currentTarget.dataset.index)
    this.setHours(this.data.hours.filter((_, i) => i !== index))
  },

  async save() {
    if (!this.data.dirty || this.data.saving) return
    this.setData({ saving: true })
    try {
      const result = await coachApi<SlotSyncDto>('PUT', '/hours', { hours: this.data.hours })
      this.setDirty(false)
      if (!warnBooked(result)) {
        const changes = [
          result.created ? `新增 ${result.created} 个时段` : '',
          result.removed ? `移除 ${result.removed} 个时段` : '',
        ].filter(Boolean)
        wx.showToast({ title: changes.length ? changes.join('，') : '已保存', icon: 'none' })
      }
    } catch (e) {
      showError(e)
    } finally {
      this.setData({ saving: false })
    }
  },

  async addDayOff(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    const date = e.detail.value
    if (this.data.daysOff.some((d) => d.key === date)) return
    try {
      const result = await coachApi<SlotSyncDto>('PUT', `/days-off/${date}`)
      this.setDaysOff([...this.data.daysOff.map((d) => d.key), date].sort())
      if (!warnBooked(result)) wx.showToast({ title: '已设为休息日', icon: 'none' })
    } catch (err) {
      showError(err)
    }
  },

  async removeDayOff(e: WechatMiniprogram.TouchEvent) {
    const date = e.currentTarget.dataset.key as string
    try {
      await coachApi<SlotSyncDto>('DELETE', `/days-off/${date}`)
      this.setDaysOff(this.data.daysOff.map((d) => d.key).filter((k) => k !== date))
      wx.showToast({ title: '已恢复接课', icon: 'none' })
    } catch (err) {
      showError(err)
    }
  },

  retry() {
    this.setData({ state: 'loading' })
    this.load()
  },
})
