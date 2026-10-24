import type { Attendance, CoachSessionDto } from '../../lib/shared'
import { errorMessage, showError } from '../../utils/api'
import { lessonTime } from '../../utils/format'
import { navigateOnce } from '../../utils/nav'
import { askForNotices, coachApi } from '../utils/coach-api'
import { ATTENDANCE, lessonTag } from '../utils/labels'

interface StudentView {
  bookingId: number
  name: string
  sub: string
  attendance: Attendance | null
  canMark: boolean
  tag: string
  tone: string
}

Page({
  data: {
    state: 'loading' as 'loading' | 'ready' | 'error',
    error: '',
    errorIcon: { name: 'error-circle', size: '112rpx' },
    emptyIcon: { name: 'user', size: '112rpx' },
    session: null as CoachSessionDto | null,
    when: '',
    count: 0,
    students: [] as StudentView[],
    footnote: '',
    canMarkAll: false,
    markingAll: false,
  },

  id: 0,
  /** One mark at a time, so a double tap or two quick taps act once. */
  marking: false,

  onLoad(query: Record<string, string | undefined>) {
    this.id = Number(query.id)
    this.load()
  },

  onShow() {
    // Back from a student's lesson page: attendance or feedback may have changed.
    if (this.data.state === 'ready') this.load()
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh())
  },

  async load() {
    try {
      this.show(await coachApi<CoachSessionDto>('GET', `/sessions/${this.id}`))
    } catch (e) {
      if (this.data.state === 'ready') showError(e)
      else this.setData({ state: 'error', error: errorMessage(e) })
    }
  },

  show(s: CoachSessionDto) {
    const now = Date.now()
    const started = Date.parse(s.startsAt) <= now
    const students = s.students.map((st): StudentView => {
      const tag = lessonTag(st, s.startsAt, now)
      const parts = [
        st.status === 'pending_payment' ? '待支付' : '',
        st.attendance ? ATTENDANCE[st.attendance] : '',
        st.hasFeedback ? '已点评' : '',
      ].filter(Boolean)
      return {
        bookingId: st.bookingId,
        name: st.name || '未填写姓名',
        sub: parts.join(' · ') || (started ? '未签到' : '已报名'),
        attendance: st.attendance,
        canMark: st.canMarkAttendance,
        tag: tag.text,
        tone: tag.tone,
      }
    })
    this.setData({
      state: 'ready',
      session: s,
      when: lessonTime(s.startsAt, s.endsAt),
      count: s.students.length,
      students,
      footnote: started
        ? '缺席照常计课，不退费用和课时。再点一次已选的按钮可撤销，点学员可写备注和课后点评。'
        : '课程开始后可以签到。调整名单或取消课程请联系场馆。',
      canMarkAll: students.some((st) => st.canMark && st.attendance === null),
    })
  },

  openStudent(e: WechatMiniprogram.TouchEvent) {
    const student = this.data.students[e.currentTarget.dataset.index as number]
    if (student) navigateOnce(`/coach/lesson/index?id=${student.bookingId}`)
  },

  noop() {},

  async mark(e: WechatMiniprogram.TouchEvent) {
    askForNotices()
    const student = this.data.students[e.currentTarget.dataset.index as number]
    if (!student || this.marking || this.data.markingAll) return
    const picked = e.currentTarget.dataset.value as Attendance
    // Tapping the current mark again clears it.
    const attendance = student.attendance === picked ? null : picked
    this.marking = true
    try {
      await coachApi('PUT', `/lessons/${student.bookingId}/attendance`, { attendance })
      wx.showToast({ title: attendance ? ATTENDANCE[attendance] : '已撤销', icon: 'none' })
    } catch (err) {
      showError(err)
    } finally {
      this.marking = false
    }
    await this.load()
  },

  async markAll() {
    askForNotices()
    if (this.marking || this.data.markingAll) return
    const todo = this.data.students.filter((st) => st.canMark && st.attendance === null)
    if (!todo.length) return
    this.setData({ markingAll: true })
    let failed: unknown = null
    for (const st of todo) {
      try {
        await coachApi('PUT', `/lessons/${st.bookingId}/attendance`, { attendance: 'attended' })
      } catch (err) {
        failed = failed ?? err
      }
    }
    this.setData({ markingAll: false })
    if (failed) showError(failed)
    else wx.showToast({ title: `${todo.length} 人已到课`, icon: 'none' })
    await this.load()
  },

  retry() {
    this.setData({ state: 'loading' })
    this.load()
  },
})
