import {
  type Attendance,
  COACH_ATTENDANCE_DAYS,
  type CoachLessonDto,
  type CoachSessionDto,
} from '../../lib/shared'
import { errorMessage, serverNow, showError } from '../../utils/api'
import { edgeWait } from '../../utils/edge'
import { lessonTime } from '../../utils/format'
import { navigateOnce } from '../../utils/nav'
import { askForNotices, bindInstead, coachApi } from '../utils/coach-api'
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
  loads: 0,
  /** One mark at a time, so a double tap or two quick taps act once. */
  marking: false,
  /** Each booking's last mark made here, by booking id: which button and when. */
  lastMark: {} as Record<number, { picked: Attendance; at: number }>,
  edgeTimer: 0 as number,
  /** Behind another page or gone: no edge timer then, onShow sets one again. */
  hidden: false,

  onLoad(query: Record<string, string | undefined>) {
    this.id = Number(query.id)
    this.load()
  },

  onShow() {
    this.hidden = false
    // Back from a student's lesson page: attendance or feedback may have changed.
    if (this.data.state === 'ready') this.load()
  },

  onHide() {
    this.hidden = true
    this.clearEdge()
  },

  onUnload() {
    this.hidden = true
    this.clearEdge()
  },

  /**
   * Reloads the roster just after the class starts and just after marking closes, as the mark
   * buttons come and go then. A failed reload still redraws the rows for the time now.
   */
  scheduleEdge(s: CoachSessionDto) {
    this.clearEdge()
    if (this.hidden) return
    // Marking opens at the start and closes COACH_ATTENDANCE_DAYS after the end.
    const wait = edgeWait(
      [Date.parse(s.startsAt), Date.parse(s.endsAt) + COACH_ATTENDANCE_DAYS * 86_400_000],
      serverNow(),
    )
    if (wait === null) return
    this.edgeTimer = setTimeout(() => {
      this.edgeTimer = 0
      const shown = this.data.session
      if (!shown || this.hidden || this.data.state !== 'ready') return
      this.show(shown)
      if (!this.marking && !this.data.markingAll) void this.load()
    }, wait) as unknown as number
  },

  clearEdge() {
    if (this.edgeTimer) clearTimeout(this.edgeTimer)
    this.edgeTimer = 0
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh())
  },

  async load() {
    // Only the latest reload is shown: an older one may predate a mark made meanwhile.
    const seq = ++this.loads
    try {
      const s = await coachApi<CoachSessionDto>('GET', `/sessions/${this.id}`)
      if (seq === this.loads) this.show(s)
    } catch (e) {
      if (seq !== this.loads) return
      if (bindInstead(e, this)) return
      if (this.data.state === 'ready') showError(e)
      else this.setData({ state: 'error', error: errorMessage(e) })
    }
  },

  show(s: CoachSessionDto) {
    const now = serverNow()
    const started = Date.parse(s.startsAt) <= now
    const students = s.students.map((st): StudentView => {
      const tag = lessonTag(st, s.startsAt, now)
      const parts = [
        st.status === 'pending_payment' ? '待支付' : '',
        st.attendance
          ? `${ATTENDANCE[st.attendance]}${st.attendanceBy === 'staff' ? '（前台）' : ''}`
          : '',
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
      footnote: s.coachMarksOff
        ? '签到由前台办理。点学员可以写备注和课后点评；如需调整名单或取消课程，请联系场馆。'
        : Date.parse(s.endsAt) + COACH_ATTENDANCE_DAYS * 86_400_000 < now
          ? '签到已截止，如需修改请联系场馆。点学员可以写备注和课后点评。'
          : started
            ? '缺席照常计课，不退费用，也不退回课时。再点一次即可撤销；点学员可以写备注和课后点评。'
            : '课程开始后才能签到。如需调整名单或取消课程，请联系场馆。',
      canMarkAll: students.some((st) => st.canMark && st.attendance === null),
    })
    this.scheduleEdge(s)
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
    // The second tap of a double tap can land just after the first mark or undo shows; it would
    // reverse it. A deliberate second tap comes later than this.
    const last = this.lastMark[student.bookingId]
    if (last?.picked === picked && Date.now() - last.at < 400) return
    // Tapping the current mark again clears it.
    const attendance = student.attendance === picked ? null : picked
    this.marking = true
    let marked = false
    try {
      await coachApi('PUT', `/lessons/${student.bookingId}/attendance`, { attendance })
      marked = true
      wx.showToast({ title: attendance ? ATTENDANCE[attendance] : '已撤销', icon: 'none' })
      // Shown at once, so 全部记为到课 never reads the old row, even when the reload fails.
      this.showMarks([student.bookingId], attendance)
      await this.load()
    } catch (err) {
      showError(err)
      await this.load()
    } finally {
      this.marking = false
    }
    if (marked) this.lastMark[student.bookingId] = { picked, at: Date.now() }
  },

  async markAll() {
    askForNotices()
    if (this.marking || this.data.markingAll) return
    const todo = this.data.students.filter((st) => st.canMark && st.attendance === null)
    if (!todo.length) return
    this.setData({ markingAll: true })
    let failed: unknown = null
    const done: number[] = []
    for (const st of todo) {
      try {
        // The list may be old (a mark made on the student's page, or by the desk): a lesson
        // marked meanwhile keeps its mark.
        const lesson = await coachApi<CoachLessonDto & { changed?: boolean }>(
          'PUT',
          `/lessons/${st.bookingId}/attendance`,
          { attendance: 'attended', unmarkedOnly: true },
        )
        if (lesson.changed) done.push(st.bookingId)
      } catch (err) {
        failed = failed ?? err
      }
    }
    if (failed) showError(failed)
    else if (done.length) wx.showToast({ title: `${done.length} 人已到课`, icon: 'none' })
    this.showMarks(done, 'attended')
    // Held until the list is reloaded, so a second tap meanwhile sends nothing again.
    await this.load()
    this.setData({ markingAll: false })
  },

  /** Marks the coach just made, shown before the reload confirms them. */
  showMarks(bookingIds: number[], attendance: Attendance | null) {
    const s = this.data.session
    if (!s || !bookingIds.length) return
    this.show({
      ...s,
      students: s.students.map((st) =>
        bookingIds.includes(st.bookingId)
          ? { ...st, attendance, attendanceBy: attendance ? 'coach' : null }
          : st,
      ),
    })
  },

  retry() {
    this.setData({ state: 'loading' })
    this.load()
  },
})
