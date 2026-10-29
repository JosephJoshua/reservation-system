import {
  exceptionError,
  type HoursPeriod,
  hoursOn,
  type ScheduleConflictDto,
  type ScheduleExceptionDto,
  type ScheduleViewDto,
  venueDateKey,
  venueInstant,
  versionOf,
  type WeeklyHours,
  weeklyHoursError,
} from '../../lib/shared'
import { ApiError, errorMessage, serverNow, showError } from '../../utils/api'
import { dateText, time } from '../../utils/format'
import { modalDangerColor } from '../../utils/theme'
import { bindInstead, coachApi } from '../utils/coach-api'
import { hhmm, spanText, WEEKDAYS } from '../utils/labels'

// Monday first, the way a coach plans a week.
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]
const DAY = 86_400_000

/** A picker's HH:MM as minutes; as an end time, 00:00 is the midnight that ends the day. */
const toMinutes = (value: string, end = false) => {
  const m = Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5))
  return end && m === 0 ? 24 * 60 : m
}

/** A window's length in hours, to one decimal: 09:00-10:10 is 1.2. */
const hoursOf = (h: WeeklyHours) => Math.round((h.endMinute - h.startMinute) / 6) / 10

const dateLabel = (key: string) => dateText(`${key}T12:00:00+08:00`)

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
              sub: `${hoursOf(h)} 小时`,
            },
          ]
        : [],
    ),
  }))
}

/** One line per day with hours, for a planned change. */
/** Weekly hours as pieces that each stay on one line, separators included. */
function hoursSummary(hours: WeeklyHours[]) {
  const days = WEEK_ORDER.map((weekday) =>
    hours
      .filter((h) => h.weekday === weekday)
      .map(
        (h, i) => `${i ? '' : `${WEEKDAYS[weekday]} `}${hhmm(h.startMinute)}-${hhmm(h.endMinute)}`,
      ),
  ).filter((d) => d.length)
  if (!days.length) return ['不接课']
  return days.flatMap((windows, d) =>
    windows.map((w, i) => w + (i < windows.length - 1 ? '、' : d < days.length - 1 ? '；' : '')),
  )
}

function sortHours(hours: WeeklyHours[]) {
  return [...hours].sort((a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute)
}

function exceptionView(e: ScheduleExceptionDto, now: number) {
  return {
    id: e.id,
    kind: e.kind,
    closure: e.coachId === null,
    label: e.coachId === null ? '闭馆' : e.kind === 'off' ? '请假' : '加班',
    text: spanText(e.startsAt, e.endsAt),
    // Kept whole when the line wraps, so 周五 never splits.
    parts: spanText(e.startsAt, e.endsAt).split(' '),
    note: [e.note, e.byStaff ? `${e.byStaff}添加` : ''].filter(Boolean).join(' · '),
    underway: Date.parse(e.startsAt) <= now,
  }
}

/** Tells the coach about booked lessons a change leaves outside their 排班 or in 请假. */
function warnConflicts(conflicts: ScheduleConflictDto[], what: string) {
  if (!conflicts.length) return false
  const lines = conflicts
    .slice(0, 3)
    .map((c) => `${dateText(c.startsAt)} ${time(c.startsAt)} ${c.title}`)
  if (conflicts.length > 3) lines.push(`等 ${conflicts.length} 节`)
  wx.showModal({
    title: `有 ${conflicts.length} 节课${what}`,
    content: `${lines.join('\n')}\n课程不会自动取消，请联系学员改约或取消，或请前台处理。`,
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
    editable: true,
    /** How many days ahead students can book the coach's lessons. */
    advanceDays: 0,
    hours: [] as WeeklyHours[],
    week: [] as ReturnType<typeof weekView>,
    /** The date the edited hours apply from. */
    from: '',
    fromText: '',
    planned: [] as { from: string; text: string; summary: string[] }[],
    exceptions: [] as ReturnType<typeof exceptionView>[],
    today: '',
    lastDay: '',
    dirty: false,
    saving: false,
    // Adding a window to the weekly hours.
    adding: false,
    addWeekday: 1,
    addName: '',
    addStart: '09:00',
    addEnd: '12:00',
    addHint: '',
    addInvalid: false,
    // Adding 请假 or 加班.
    excepting: false,
    exKind: 'off' as 'off' | 'extra',
    exWholeDay: true,
    exDate: '',
    exDateText: '',
    exEndDate: '',
    exEndDateText: '',
    exStart: '09:00',
    exEnd: '12:00',
    exNote: '',
    exHint: '',
    exInvalid: false,
    exSaving: false,
  },

  periods: [] as HoursPeriod[],
  // The hours as loaded, sent back with a save so one over a change by staff is refused.
  hoursVersion: '',
  /** Weekdays changed since the hours were loaded, kept when 生效日期 moves. */
  touched: new Set<number>(),
  lessonMinutes: null as number | null,
  removing: false,

  onLoad() {
    this.load()
  },

  onShow() {
    // Left open past midnight: today, the 生效日期 and the date pickers' range have moved.
    if (this.data.state === 'ready' && this.data.today !== venueDateKey(new Date(serverNow()))) {
      this.load()
    }
  },

  async load() {
    try {
      const view = await coachApi<ScheduleViewDto>('GET', '/hours')
      const now = serverNow()
      const today = venueDateKey(new Date(now))
      this.periods = view.periods
      this.hoursVersion = view.hoursVersion
      this.lessonMinutes = view.lessonMinutes
      this.setData({
        state: 'ready',
        editable: view.coachEdits,
        advanceDays: view.advanceDays,
        today,
        lastDay: venueDateKey(new Date(now + 365 * DAY)),
        planned: view.periods
          .filter((p) => p.from > today)
          .map((p) => ({
            from: p.from,
            text: `${dateLabel(p.from)}起`,
            summary: hoursSummary(p.hours),
          })),
        exceptions: [...view.exceptions, ...view.closures]
          .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
          .map((e) => exceptionView(e, now)),
      })
      if (!this.data.dirty) {
        // Hours that only start later read as 不接课 today; open on the first week with hours.
        const next = view.periods.find((p) => p.hours.length)
        this.setFrom(!hoursOn(view.periods, today).length && next ? next.from : today)
      } else {
        // Hours changed elsewhere meanwhile: the days not edited here take the newer hours. A
        // 生效日期 that has passed overnight moves to today.
        let { from } = this.data
        if (from < today) from = today
        const kept = this.data.hours.filter((h) => this.touched.has(h.weekday))
        const rest = hoursOn(view.periods, from).filter((h) => !this.touched.has(h.weekday))
        this.setData({ from, fromText: from === today ? '今天' : dateLabel(from) })
        this.setHours([...rest, ...kept])
      }
    } catch (e) {
      if (bindInstead(e, this)) return
      this.setData({ state: 'error', error: errorMessage(e) })
    }
  },

  /** Edits the hours in effect from a date, as they stand then. */
  setFrom(from: string) {
    this.setData({
      from,
      fromText: from === this.data.today ? '今天' : dateLabel(from),
    })
    this.touched = new Set()
    this.setHours(hoursOn(this.periods, from), false)
  },

  onFrom(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    const from = e.detail.value
    if (from === this.data.from) return
    if (this.data.dirty) {
      // Keep the days edited and take the others as they stand on the new date, so the whole
      // week shown is what will apply from then.
      const kept = this.data.hours.filter((h) => this.touched.has(h.weekday))
      const rest = hoursOn(this.periods, from).filter((h) => !this.touched.has(h.weekday))
      this.setData({ from, fromText: from === this.data.today ? '今天' : dateLabel(from) })
      this.setHours([...rest, ...kept])
      return
    }
    this.setFrom(from)
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

  openAdd(e: WechatMiniprogram.TouchEvent) {
    if (!this.data.editable) return
    const weekday = Number(e.currentTarget.dataset.weekday)
    // Start after the day's last window, so adding an afternoon is two taps.
    const last = this.data.hours.filter((h) => h.weekday === weekday).pop()
    const start = last ? Math.min(last.endMinute + 60, 21 * 60) : 9 * 60
    this.setData({
      adding: true,
      addWeekday: weekday,
      addName: WEEKDAYS[weekday] ?? '',
      addStart: hhmm(start),
      addEnd: hhmm(Math.min(start + 3 * 60, 23 * 60)),
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

  draft(): WeeklyHours {
    return {
      weekday: this.data.addWeekday,
      startMinute: toMinutes(this.data.addStart),
      endMinute: toMinutes(this.data.addEnd, true),
    }
  },

  updateHint() {
    const d = this.draft()
    const error = weeklyHoursError([...this.data.hours, d])
    this.setData({
      addHint:
        error ??
        `每${this.data.addName} ${hhmm(d.startMinute)}-${hhmm(d.endMinute)}，共 ${hoursOf(d)} 小时`,
      addInvalid: !!error,
    })
  },

  confirmAdd() {
    const hours = [...this.data.hours, this.draft()]
    const error = weeklyHoursError(hours)
    if (error) {
      wx.showToast({ title: error, icon: 'none' })
      return
    }
    this.touched.add(this.data.addWeekday)
    this.setHours(hours)
    this.setData({ adding: false })
  },

  remove(e: WechatMiniprogram.TouchEvent) {
    if (!this.data.editable) return
    const index = Number(e.currentTarget.dataset.index)
    const removed = this.data.hours[index]
    if (removed) this.touched.add(removed.weekday)
    this.setHours(this.data.hours.filter((_, i) => i !== index))
  },

  /** Saving from a date replaces the changes planned after it, so that is confirmed first. */
  save() {
    if (!this.data.dirty || this.data.saving) return
    const later = this.periods.filter((p) => p.from > this.data.from)
    if (!later.length) {
      this.send()
      return
    }
    this.setData({ saving: true })
    wx.showModal({
      title: '替换已安排的调整？',
      content: `从${this.data.fromText}起按这份每周时间，${later.map((p) => dateLabel(p.from)).join('、')}起的安排会被替换。`,
      confirmText: '保存',
      cancelText: '再看看',
      success: (res) => {
        this.setData({ saving: false })
        if (res.confirm) this.send()
      },
      fail: () => this.setData({ saving: false }),
    })
  },

  async send() {
    if (this.data.saving) return
    this.setData({ saving: true })
    try {
      const sent = this.data.hours
      // Checked against the hours as loaded: staff may have changed them meanwhile.
      const res = await coachApi<{ conflicts: ScheduleConflictDto[] }>(
        'PUT',
        '/hours',
        { from: this.data.from, hours: sent },
        { 'If-Match': versionOf(this.hoursVersion) },
      )
      // Changes made while saving are still unsaved.
      this.setDirty(this.data.hours !== sent)
      if (!warnConflicts(res.conflicts, '不在新的排班里')) {
        wx.showToast({ title: '已保存', icon: 'success' })
      }
      await this.load()
    } catch (e) {
      if (e instanceof ApiError && e.code === 'edited_elsewhere') {
        wx.showToast({ title: '排班刚被修改，已载入最新时间，请核对后再保存', icon: 'none' })
        await this.load()
      } else showError(e)
    } finally {
      this.setData({ saving: false })
    }
  },

  // 请假 and 加班

  openException(e: WechatMiniprogram.TouchEvent) {
    if (!this.data.editable) return
    const kind = e.currentTarget.dataset.kind as 'off' | 'extra'
    const { today } = this.data
    this.setData({
      excepting: true,
      exKind: kind,
      exWholeDay: kind === 'off',
      exDate: today,
      exDateText: dateLabel(today),
      exEndDate: today,
      exEndDateText: dateLabel(today),
      exStart: kind === 'off' ? '09:00' : '18:00',
      exEnd: kind === 'off' ? '12:00' : '20:00',
      exNote: '',
    })
    this.updateExHint()
  },

  onExPopup(e: WechatMiniprogram.CustomEvent<{ visible: boolean }>) {
    this.setData({ excepting: e.detail.visible })
  },

  onExWholeDay(e: WechatMiniprogram.CustomEvent<{ value: boolean }>) {
    this.setData({ exWholeDay: e.detail.value })
    this.updateExHint()
  },

  onExDate(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    const date = e.detail.value
    const end = [date, this.data.exEndDate].sort()[1] ?? date
    this.setData({
      exDate: date,
      exDateText: dateLabel(date),
      exEndDate: end,
      exEndDateText: dateLabel(end),
    })
    this.updateExHint()
  },

  onExEndDate(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ exEndDate: e.detail.value, exEndDateText: dateLabel(e.detail.value) })
    this.updateExHint()
  },

  onExStart(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ exStart: e.detail.value })
    this.updateExHint()
  },

  onExEnd(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ exEnd: e.detail.value })
    this.updateExHint()
  },

  onExNote(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ exNote: e.detail.value })
  },

  exDraft() {
    const d = this.data
    if (d.exKind === 'off' && d.exWholeDay) {
      return {
        kind: d.exKind,
        startsAt: venueInstant(d.exDate, 0),
        endsAt: venueInstant(d.exEndDate, 24 * 60),
      }
    }
    return {
      kind: d.exKind,
      startsAt: venueInstant(d.exDate, toMinutes(d.exStart)),
      endsAt: venueInstant(d.exDate, toMinutes(d.exEnd, true)),
    }
  },

  updateExHint() {
    const d = this.data
    const draft = this.exDraft()
    const timed = !(d.exKind === 'off' && d.exWholeDay)
    // An end before the start on the same date means past midnight, which 加班 cannot do.
    const overnight = timed && d.exEnd !== '00:00' && toMinutes(d.exEnd) <= toMinutes(d.exStart)
    const error =
      overnight && d.exKind === 'extra'
        ? '加班不能跨到第二天'
        : exceptionError(draft, new Date(serverNow()))
    this.setData({ exHint: error ?? this.exEffect(draft), exInvalid: !!error })
  },

  /** What a valid 请假 or 加班 does, or why a 加班 adds nothing students can book. */
  exEffect(draft: { startsAt: Date; endsAt: Date }) {
    if (this.data.exKind === 'off') return '这段时间学员不能预约你的课'
    const date = this.data.exDate
    const weekday = new Date(`${date}T12:00:00+08:00`).getUTCDay()
    const inHours = hoursOn(this.periods, date).some(
      (h) =>
        h.weekday === weekday &&
        venueInstant(date, h.startMinute) <= draft.startsAt &&
        venueInstant(date, h.endMinute) >= draft.endsAt,
    )
    if (inHours) return '已在每周时间内，不用加班'
    const minutes = (draft.endsAt.getTime() - draft.startsAt.getTime()) / 60_000
    if (this.lessonMinutes !== null && minutes < this.lessonMinutes) {
      return '不足一节课，学员约不到'
    }
    return '这段时间学员可以预约你的课'
  },

  async confirmException() {
    if (this.data.exInvalid || this.data.exSaving) return
    const draft = this.exDraft()
    this.setData({ exSaving: true })
    try {
      const res = await coachApi<{ id: number; conflicts: ScheduleConflictDto[] }>(
        'POST',
        '/exceptions',
        {
          kind: draft.kind,
          startsAt: draft.startsAt.toISOString(),
          endsAt: draft.endsAt.toISOString(),
          note: this.data.exNote.trim(),
        },
      )
      this.setData({ excepting: false })
      if (!warnConflicts(res.conflicts, '在请假时间里')) {
        wx.showToast({ title: draft.kind === 'off' ? '已请假' : '已加班', icon: 'success' })
      }
      await this.load()
    } catch (e) {
      showError(e)
    } finally {
      this.setData({ exSaving: false })
    }
  },

  removeException(e: WechatMiniprogram.TouchEvent) {
    const item = this.data.exceptions[Number(e.currentTarget.dataset.index)]
    if (!item || item.closure || !this.data.editable || this.removing) return
    this.removing = true
    const done = () => {
      this.removing = false
    }
    const off = item.kind === 'off'
    wx.showModal({
      title: off ? '取消这次请假？' : '取消这次加班？',
      content: off
        ? `${item.text} 会重新开放预约。`
        : `${item.text} 不再开放预约，已约的课不受影响。`,
      confirmText: off ? '取消请假' : '取消加班',
      confirmColor: modalDangerColor(),
      cancelText: '保留',
      success: async (res) => {
        if (!res.confirm) {
          done()
          return
        }
        try {
          const res = await coachApi<{ conflicts: ScheduleConflictDto[] }>(
            'DELETE',
            `/exceptions/${item.id}`,
          )
          // Lessons booked in a 加班 stay, now outside 排班.
          if (!warnConflicts(res?.conflicts ?? [], '不在排班里')) {
            wx.showToast({ title: '已取消', icon: 'success' })
          }
          await this.load()
        } catch (err) {
          showError(err)
        } finally {
          done()
        }
      },
      fail: done,
    })
  },

  retry() {
    this.setData({ state: 'loading' })
    this.load()
  },
})
