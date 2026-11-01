import {
  type CoachDaysDto,
  type CoachMeDto,
  type CoachSlotDto,
  venueDateKey,
  venueInstant,
} from '../../lib/shared'
import { errorMessage, serverNow, showError } from '../../utils/api'
import { edgeWait } from '../../utils/edge'
import { dayName, monthDay, time, weekday } from '../../utils/format'
import { isTop, navigateOnce } from '../../utils/nav'
import { modalDangerColor } from '../../utils/theme'
import { askForNotices, coachApi, isNotBound, remember } from '../utils/coach-api'
import { lessonTag, spanText } from '../utils/labels'

const DAY = 24 * 60 * 60 * 1000
/** Past days stay on the strip so the coach can still mark attendance. */
const PAST_DAYS = 7
/** Times in 排班 are whole multiples of 5 minutes. */
const STEP = 5 * 60 * 1000

interface DayView {
  key: string
  label: string
  date: string
  past: boolean
  lessons: number
}

interface RowView {
  key: string
  /** A session's slot id, or a 请假's id. */
  id: number
  kind: 'lesson' | 'session' | 'free' | 'off'
  startsAt: string
  endsAt: string
  start: string
  end: string
  bookingId: number
  /** A 请假's whole span, which may run over several days. */
  whole: string
  /** When a 请假 really starts, before it is clipped to the day shown. */
  since: string
  student: string
  lesson: string
  label: string
  tag: string
  tone: string
  /** Tapping does something. */
  active: boolean
}

function lessonRow(s: CoachSlotDto, now: number): RowView {
  const base = {
    key: `l${s.id}`,
    id: s.id,
    startsAt: s.startsAt,
    endsAt: s.endsAt,
    start: time(s.startsAt),
    end: time(s.endsAt),
    bookingId: 0,
    whole: '',
    since: '',
    student: '',
    lesson: '',
    label: '',
    tag: '',
    tone: 'default',
    active: true,
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
  const l = s.lesson
  const tag = l ? lessonTag(l, s.startsAt, now, s.endsAt) : { text: '', tone: 'default' }
  return {
    ...base,
    kind: 'lesson',
    bookingId: l?.bookingId ?? 0,
    whole: '',
    since: '',
    student: l?.studentName || '未填写姓名',
    lesson: l ? (l.isTrial ? `${l.lessonTypeName} · 体验` : l.lessonTypeName) : '',
    tag: tag.text,
    tone: tag.tone,
  }
}

/** A time on the day, or 24:00 for the midnight that ends it. */
function clock(iso: string, dayEnd: number) {
  return Date.parse(iso) >= dayEnd ? '24:00' : time(iso)
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
    slotsState: 'ready' as 'loading' | 'ready' | 'error',
    rows: [] as RowView[],
    summary: '',
    dayEmpty: '',
    footnote: '',
  },

  me: null as CoachMeDto | null,
  schedule: null as CoachDaysDto | null,
  request: 0,
  /** Held from the action sheet until a 请假 change is saved, so a double tap acts once. */
  rowBusy: false,
  edgeTimer: 0 as number,
  /** Behind another page or gone: no edge timer then, onShow sets one again. */
  hidden: false,

  onLoad() {
    this.load()
  },

  onHide() {
    this.hidden = true
    this.clearEdge()
  },

  onUnload() {
    this.hidden = true
    this.clearEdge()
  },

  onShow() {
    this.hidden = false
    if (this.data.state !== 'ready') return
    // Left open past midnight: today and the day strip have moved.
    if (this.data.days[PAST_DAYS]?.key !== venueDateKey(new Date(serverNow()))) {
      this.load()
      return
    }
    // Back from a lesson: attendance or a cancel changes the list.
    this.loadSchedule()
  },

  onPullDownRefresh() {
    this.loadSchedule().finally(() => wx.stopPullDownRefresh())
  },

  /** `quiet` (the move to a new day at midnight) keeps the day shown on a failure. */
  async load(quiet = false) {
    try {
      const me = await coachApi<CoachMeDto>('GET', '/me')
      this.me = me
      remember(me)
      const now = serverNow()
      const today = venueDateKey(new Date(now))
      const days = Array.from({ length: PAST_DAYS + me.advanceDays + 1 }, (_, i) => {
        const at = new Date(now + (i - PAST_DAYS) * DAY)
        const near = i >= PAST_DAYS && i - PAST_DAYS <= 2
        return {
          key: venueDateKey(at),
          label: near ? dayName(at, new Date(now)) : weekday(at),
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
      // Tries again in a minute, or when the page is shown.
      if (quiet && this.data.state === 'ready') {
        this.clearEdge()
        this.edgeTimer = setTimeout(() => {
          this.edgeTimer = 0
          if (!this.hidden && this.data.state === 'ready') this.load(true)
        }, 60_000) as unknown as number
        return
      }
      this.setData({ state: 'error', error: errorMessage(e) })
    }
  },

  /** Loads the schedule; `quiet` (the edge timer's reload) keeps the day shown on a failure. */
  async loadSchedule(quiet?: boolean) {
    const { days } = this.data
    const first = days[0]?.key
    const last = days[days.length - 1]?.key
    if (!first || !last) return
    const request = ++this.request
    try {
      const schedule = await coachApi<CoachDaysDto>('GET', `/schedule?from=${first}&to=${last}`)
      if (request !== this.request) return
      this.schedule = schedule
      const counts = new Map<string, number>()
      for (const s of schedule.lessons) {
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
      if (quiet && this.data.state === 'ready') return
      if (this.data.state === 'ready') this.setData({ slotsState: 'error', error: errorMessage(e) })
      else throw e
    }
  },

  retrySchedule() {
    if (this.data.slotsState === 'loading') return
    this.setData({ slotsState: 'loading' })
    this.loadSchedule()
  },

  showDay() {
    const schedule = this.schedule
    if (!schedule) return
    const now = serverNow()
    const { date } = this.data
    const dayStart = venueInstant(date, 0).getTime()
    const dayEnd = dayStart + DAY
    const onDay = (r: { startsAt: string; endsAt: string }) =>
      Date.parse(r.startsAt) < dayEnd && Date.parse(r.endsAt) > dayStart
    const clip = (r: { startsAt: string; endsAt: string }) => ({
      startsAt: new Date(Math.max(Date.parse(r.startsAt), dayStart)).toISOString(),
      endsAt: new Date(Math.min(Date.parse(r.endsAt), dayEnd)).toISOString(),
    })
    const edits = schedule.coachEdits
    const onDate = schedule.lessons.filter((s) => venueDateKey(new Date(s.startsAt)) === date)
    const lessons = onDate.map((s) => lessonRow(s, now))
    // Free time already begun starts at the next 5-minute step, as the server would send it, so
    // the row stays right offline too.
    const ahead = Math.ceil(now / STEP) * STEP
    const free = schedule.free
      .filter(onDay)
      .map(clip)
      .map((span) => ({
        ...span,
        startsAt: new Date(Math.max(Date.parse(span.startsAt), ahead)).toISOString(),
      }))
      .filter((span) => Date.parse(span.startsAt) < Date.parse(span.endsAt))
      .map((span, i): RowView => {
        return {
          key: `f${i}`,
          id: 0,
          kind: 'free',
          ...span,
          start: time(span.startsAt),
          end: clock(span.endsAt, dayEnd),
          bookingId: 0,
          whole: '',
          since: '',
          student: '',
          lesson: '',
          label: '空闲，可预约',
          tag: '',
          tone: 'default',
          active: edits,
        }
      })
    const off = schedule.off.filter(onDay).map((o): RowView => {
      const span = clip(o)
      return {
        key: `o${o.id}`,
        id: o.id,
        kind: 'off',
        ...span,
        start: time(span.startsAt),
        end: clock(span.endsAt, dayEnd),
        bookingId: 0,
        whole: spanText(o.startsAt, o.endsAt),
        since: o.startsAt,
        student: o.closure ? '闭馆' : '请假',
        lesson: o.note,
        label: '',
        tag: '',
        tone: 'default',
        active: edits && !o.closure && Date.parse(o.endsAt) > now,
      }
    })
    // Lessons starting, and 请假 and free time starting or ending, change what the day shows.
    this.scheduleEdge([
      ...onDate.map((s) => Date.parse(s.startsAt)),
      ...[...off, ...free].flatMap((r) => [Date.parse(r.startsAt), Date.parse(r.endsAt)]),
    ])
    const rows = [...off, ...lessons, ...free].sort(
      (a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt),
    )
    const lessonCount = lessons.filter((r) => r.tag !== '已取消').length
    const freeMinutes = free.reduce(
      (sum, r) => sum + (Date.parse(r.endsAt) - Date.parse(r.startsAt)) / 60_000,
      0,
    )
    const hours = Math.round((freeMinutes / 60) * 10) / 10
    const today = venueDateKey(new Date(now))
    // Missing from an API older than this page: read as a day with no 排班.
    const working = (schedule.working ?? []).filter(onDay)
    const dayEmpty =
      date < today
        ? '这天没有课程'
        : !working.length
          ? '这天不在排班里'
          : working.every((w) => Date.parse(w.endsAt) <= now)
            ? '今天的排班已结束'
            : '这天没有可约的空闲时间'
    this.setData({
      rows,
      summary: [lessonCount ? `${lessonCount} 节课` : '没有课程', hours ? `空闲 ${hours} 小时` : '']
        .filter(Boolean)
        .join(' · '),
      dayEmpty,
      footnote: edits
        ? '点空闲时间可请假，点请假可取消；已预约的课程点开可签到、写备注或取消，小班课点开可按名单签到。'
        : '已预约的课程点开可签到、写备注或取消。排班由场馆设置，需要请假请联系前台。',
    })
  },

  /**
   * Redraws the day just after the next of its edges (a lesson starting, so 已预约 becomes 待签到,
   * a 请假 or free stretch starting or ending, or midnight), and loads the schedule again then.
   */
  scheduleEdge(starts: number[]) {
    this.clearEdge()
    if (this.hidden) return
    const now = serverNow()
    // Midnight too, when 今天 and the day strip move on.
    const today = this.data.days[PAST_DAYS]?.key ?? venueDateKey(new Date(now))
    const wait = edgeWait([...starts, venueInstant(today, 24 * 60).getTime()], now)
    if (wait === null) return
    this.edgeTimer = setTimeout(() => {
      this.edgeTimer = 0
      if (this.hidden || this.data.state !== 'ready') return
      if (this.data.days[PAST_DAYS]?.key !== venueDateKey(new Date(serverNow()))) {
        this.load(true)
        return
      }
      this.showDay()
      if (!this.rowBusy) void this.loadSchedule(true)
    }, wait) as unknown as number
  },

  clearEdge() {
    if (this.edgeTimer) clearTimeout(this.edgeTimer)
    this.edgeTimer = 0
  },

  pickDate(e: WechatMiniprogram.TouchEvent) {
    askForNotices()
    const date = e.currentTarget.dataset.key as string
    if (date === this.data.date) return
    this.setData({ date })
    this.showDay()
  },

  openRow(e: WechatMiniprogram.TouchEvent) {
    const row = this.data.rows[e.currentTarget.dataset.index as number]
    if (row?.kind === 'free' && !this.schedule?.coachEdits) {
      wx.showToast({ title: '排班由场馆设置，请假请联系前台', icon: 'none' })
      return
    }
    if (!row?.active) return
    askForNotices()
    if (row.kind === 'lesson') {
      navigateOnce(`/coach/lesson/index?id=${row.bookingId}`)
      return
    }
    if (row.kind === 'session') {
      navigateOnce(`/coach/session/index?id=${row.id}`)
      return
    }
    if (this.rowBusy) return
    this.rowBusy = true
    const span = `${row.start}-${row.end}`
    const done = () => {
      this.rowBusy = false
    }
    if (row.kind === 'free') {
      wx.showActionSheet({
        itemList: [`${span} 请假`],
        success: () => this.addLeave(row).finally(done),
        fail: done,
      })
      return
    }
    // Worded as of the tap: one under way ends early, keeping the part already passed.
    const started = Date.parse(row.since) <= serverNow()
    wx.showModal({
      title: started ? '提前结束这段请假？' : '取消这段请假？',
      content: started
        ? '从现在起重新开放预约，已过去的部分保留记录。'
        : `${row.whole} 会重新开放预约。`,
      confirmText: started ? '提前结束' : '取消请假',
      confirmColor: modalDangerColor(),
      cancelText: '保留',
      success: (res) => {
        if (res.confirm) this.removeLeave(row.id).finally(done)
        else done()
      },
      fail: done,
    })
  },

  /** Takes a free stretch out of the coach's 排班 as 请假. */
  async addLeave(row: RowView) {
    try {
      // Free time that started earlier begins at the next 5-minute mark already.
      const startsAt = new Date(Math.floor(Date.parse(row.startsAt) / STEP) * STEP).toISOString()
      await coachApi('POST', '/exceptions', { kind: 'off', startsAt, endsAt: row.endsAt })
      wx.showToast({ title: '已请假', icon: 'success' })
    } catch (err) {
      showError(err)
    }
    await this.loadSchedule()
  },

  async removeLeave(id: number) {
    try {
      const res = await coachApi<{ endedAt?: string | null }>('DELETE', `/exceptions/${id}`)
      wx.showToast({ title: res?.endedAt ? '已提前结束' : '已取消请假', icon: 'success' })
    } catch (err) {
      showError(err)
    }
    await this.loadSchedule()
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
