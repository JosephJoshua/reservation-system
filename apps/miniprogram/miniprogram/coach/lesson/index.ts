import {
  type Attendance,
  COACH_ATTENDANCE_DAYS,
  type CoachLessonDto,
  profileCounts,
  profileTraits,
  type StudentProfileDto,
} from '../../lib/shared'
import { assetUrl, errorMessage, refreshAfter, serverNow, showError } from '../../utils/api'
import { edgeWait } from '../../utils/edge'
import { dateTime, fullDate, lessonTime, yuan } from '../../utils/format'
import { navigateOnce } from '../../utils/nav'
import { previewPhotos } from '../../utils/photos'
import { openOnce } from '../../utils/tap'
import { modalDangerColor } from '../../utils/theme'
import { askForNotices, bindInstead, coachApi } from '../utils/coach-api'
import { confirmDeleteFeedback } from '../utils/feedback'
import { ATTENDANCE, lessonTag, profileEdited, type Tag } from '../utils/labels'

/** The longest 取消原因 the API takes. */
const CANCEL_REASON_MAX = 100

interface HistoryView {
  id: number
  date: string
  lesson: string
  attendance: string
  attendanceClass: string
  note: string
}

interface ProfileView {
  chips: { key: string; text: string; trait: boolean }[]
  note: string
  /** Long enough to be clamped, with 展开 to read it all. */
  long: boolean
  empty: boolean
  counts: string
  /** Who saved it last and when, such as 王教练 10月24日 14:00 修改. */
  edited: string
  feedbackCount: number
}

/** The 学员档案: level and grip first, then the tags. */
function profileView(p: StudentProfileDto | null): ProfileView | null {
  if (!p) return null
  const chips = [
    ...profileTraits(p).map((text) => ({ key: `trait:${text}`, text, trait: true })),
    ...p.tags.map((text) => ({ key: `tag:${text}`, text, trait: false })),
  ]
  return {
    chips,
    note: p.note,
    long: p.note.length > 80 || p.note.split('\n').length > 4,
    empty: !chips.length && !p.note,
    counts: profileCounts(p),
    edited: profileEdited(p),
    feedbackCount: p.feedbackCount,
  }
}

function paymentText(l: CoachLessonDto): string {
  if (l.paidWith === 'package') return l.packageName ? `课时包 · ${l.packageName}` : '课时包'
  if (l.status === 'pending_payment') return `待支付 ${yuan(l.price)}`
  return l.price ? `单次 ${yuan(l.price)}` : '免费'
}

/** Why the student does not see the feedback, if they do not. */
function feedbackNote(l: CoachLessonDto): string {
  if (!l.feedback || l.feedback.visible) return ''
  if (l.feedback.hidden) return '场馆已隐藏这条点评，学员看不到。'
  if (l.status === 'cancelled') return '课程已取消，学员看不到这条点评。'
  if (l.attendance === null) return '签到已撤销，学员看不到这条点评。'
  return '签到状态不是到课，学员看不到这条点评。'
}

/** Why no feedback can be written, for a lesson that has started and has none. */
function feedbackClosed(l: CoachLessonDto): string {
  // A lesson that has ended comes as completed.
  const started =
    (l.status === 'confirmed' || l.status === 'completed') && Date.parse(l.startsAt) <= serverNow()
  return started && !l.feedback ? (l.feedbackBlocked ?? '') : ''
}

function attendanceNote(l: CoachLessonDto): string {
  const mark = l.attendance ? `${ATTENDANCE[l.attendance]}。` : ''
  if (l.coachMarksOff) return `${mark}签到由前台办理。`
  if (l.attendance && l.attendanceBy === 'staff') {
    return `${mark}由前台登记，如需修改请联系前台。`
  }
  if (Date.parse(l.startsAt) > serverNow()) {
    return l.attendance ? `${mark}课程开始后可以修改。` : '课程开始后可以签到。'
  }
  // Marking stays open until COACH_ATTENDANCE_DAYS after the end; before that the buttons are
  // still on their way from the server, so nothing is said to be closed.
  if (Date.parse(l.endsAt) + COACH_ATTENDANCE_DAYS * 86_400_000 > serverNow()) {
    return mark || '正在更新签到状态…'
  }
  if (l.attendance) return `${mark}签到已截止，如需修改请联系场馆。`
  return '签到已截止，如需补签请联系场馆。'
}

/** Marking opens at the start and closes COACH_ATTENDANCE_DAYS after the end. */
function edgeTimes(l: CoachLessonDto): number[] {
  return [Date.parse(l.startsAt), Date.parse(l.endsAt) + COACH_ATTENDANCE_DAYS * 86_400_000]
}

Page({
  data: {
    state: 'loading' as 'loading' | 'ready' | 'error',
    error: '',
    errorIcon: { name: 'error-circle', size: '112rpx' },
    lesson: null as CoachLessonDto | null,
    tag: { text: '', tone: 'default' } as Tag,
    when: '',
    movedFrom: '',
    lessonName: '',
    payment: '',
    together: '',
    cancelReason: '',
    attendanceNote: '',
    history: [] as HistoryView[],
    profile: null as ProfileView | null,
    feedbackNote: '',
    feedbackClosed: '',
    feedbackPhotos: [] as string[],
    note: '',
    noteDirty: false,
    noteSize: { minHeight: 120, maxHeight: 400 },
    marking: false,
    savingNote: false,
    cancelling: false,
    deletingFeedback: false,
    noteOpen: false,
  },

  id: 0,
  cancelAsking: false,
  feedbackAsking: false,
  /** The last mark made here: which button and when. */
  lastMark: null as { picked: Attendance; at: number } | null,
  edgeTimer: 0 as number,
  /** Counts what show() has put on screen, so a slow fetch can tell it is older. */
  shows: 0,
  /** Behind another page or gone: no edge timer then, onShow sets one again. */
  hidden: false,
  /** When it was last hidden, so onShow can tell an edge passed meanwhile. */
  hiddenAt: 0,
  /**
   * Set once an edge passes, until the lesson is fetched after it: how soon to look again. The
   * buttons come from the server, so a redraw alone leaves the ones from before the edge.
   */
  edgeDue: 0,

  onLoad(query: Record<string, string | undefined>) {
    this.id = Number(query.id)
    this.load()
  },

  onShow() {
    this.hidden = false
    const l = this.data.lesson
    if (!l || this.data.state !== 'ready') return
    // An edge passed while it was hidden: the buttons on screen are from before it. The timer
    // fires a second after an edge, so one in the second before hiding was not handled either.
    const now = serverNow()
    if (this.hiddenAt && edgeTimes(l).some((t) => t > this.hiddenAt - 1000 && t <= now))
      void this.onEdge()
    else this.scheduleEdge(l)
  },

  onHide() {
    this.hidden = true
    this.hiddenAt = serverNow()
    this.clearEdge()
  },

  onUnload() {
    this.hidden = true
    this.clearEdge()
  },

  /**
   * For a booked lesson, fetches it again just after it starts and just after marking closes, as
   * the mark buttons come and go then; on a failure it is only redrawn for the time now.
   */
  scheduleEdge(l: CoachLessonDto) {
    this.clearEdge()
    if ((l.status !== 'confirmed' && l.status !== 'completed') || this.hidden) return
    const wait = this.edgeDue || edgeWait(edgeTimes(l), serverNow())
    if (wait === null) return
    this.edgeTimer = setTimeout(() => void this.onEdge(), wait) as unknown as number
  },

  async onEdge() {
    this.edgeTimer = 0
    const shown = this.data.lesson
    if (!shown || this.hidden || this.data.state !== 'ready') return
    // While a change is on its way, look again shortly.
    if (!this.edgeDue) this.edgeDue = 1000
    const busy =
      this.data.marking ||
      this.data.cancelling ||
      this.data.deletingFeedback ||
      this.data.savingNote
    if (busy) {
      this.show(shown)
      return
    }
    // A change saved meanwhile shows a newer lesson than this fetch may have read.
    const shows = this.shows
    try {
      const fetched = await coachApi<CoachLessonDto>('GET', `/lessons/${this.id}`)
      if (shows === this.shows) {
        this.edgeDue = 0
        this.show(fetched)
      }
    } catch {
      // Redrawn for the time now, and fetched again in a minute.
      this.edgeDue = 60_000
      const current = this.data.lesson
      if (current && !this.hidden && this.data.state === 'ready') this.show(current)
    }
  },

  clearEdge() {
    if (this.edgeTimer) clearTimeout(this.edgeTimer)
    this.edgeTimer = 0
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh())
  },

  async load() {
    try {
      const fetched = await coachApi<CoachLessonDto>('GET', `/lessons/${this.id}`)
      this.edgeDue = 0
      this.show(fetched)
    } catch (e) {
      if (bindInstead(e, this)) return
      this.setData({ state: 'error', error: errorMessage(e) })
    }
  },

  /** Shows a lesson; keeps an unsaved note unless the server has a newer one. */
  show(l: CoachLessonDto, keepNote?: boolean) {
    this.shows++
    const keep = keepNote ?? this.data.noteDirty
    this.setData({
      state: 'ready',
      lesson: l,
      tag: lessonTag(l, l.startsAt, serverNow(), l.endsAt),
      when: lessonTime(l.startsAt, l.endsAt),
      movedFrom: l.movedFrom ? dateTime(l.movedFrom) : '',
      lessonName: l.lessonType.isTrial
        ? `${l.lessonType.name}（体验课）`
        : l.sessionId
          ? `${l.lessonType.name}${l.lessonType.name.includes('小班') ? '' : '（小班课）'}`
          : l.lessonType.name,
      payment: paymentText(l),
      profile: profileView(l.profile),
      together: l.lessonsTogether ? `与你的第 ${l.lessonsTogether + 1} 节课` : '第一次上你的课',
      cancelReason: l.cancelReason || (l.cancelledBy === 'student' ? '学员取消' : '场馆取消'),
      attendanceNote: attendanceNote(l),
      noteEditable: l.status !== 'cancelled' && l.status !== 'expired',
      feedbackNote: feedbackNote(l),
      feedbackClosed: feedbackClosed(l),
      feedbackPhotos: l.feedback?.photos.map(assetUrl) ?? [],
      history: l.history.map((h) => ({
        id: h.id,
        date: fullDate(h.startsAt),
        lesson: h.lessonTypeName,
        attendance: h.attendance ? ATTENDANCE[h.attendance] : '',
        attendanceClass: h.attendance ? `mark-${h.attendance}` : '',
        note: h.coachNote,
      })),
      ...(keep ? {} : { note: l.coachNote, noteDirty: false }),
    })
    this.scheduleEdge(l)
  },

  async mark(e: WechatMiniprogram.TouchEvent) {
    askForNotices()
    const lesson = this.data.lesson
    if (!lesson || this.data.marking) return
    const picked = e.currentTarget.dataset.value as Attendance
    // The second tap of a double tap can land just after the first request returns; it would
    // reverse the mark or undo the first one made. A deliberate second tap comes later than this.
    if (this.lastMark?.picked === picked && Date.now() - this.lastMark.at < 400) return
    // Tapping the current mark again clears it.
    const attendance = lesson.attendance === picked ? null : picked
    this.setData({ marking: true })
    try {
      this.show(
        await coachApi<CoachLessonDto>('PUT', `/lessons/${this.id}/attendance`, { attendance }),
      )
      this.lastMark = { picked, at: Date.now() }
      wx.showToast({ title: attendance ? ATTENDANCE[attendance] : '已撤销', icon: 'none' })
    } catch (err) {
      // The front desk marked it meanwhile, marking was turned off or it is too late now: show the
      // lesson as it stands, then why.
      if (refreshAfter(err)) await this.load()
      showError(err)
    } finally {
      this.setData({ marking: false })
    }
  },

  onNote(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({
      note: e.detail.value,
      noteDirty: e.detail.value.trim() !== (this.data.lesson?.coachNote ?? ''),
    })
  },

  async saveNote() {
    if (!this.data.noteDirty || this.data.savingNote) return
    this.setData({ savingNote: true })
    try {
      const sent = this.data.note
      const saved = await coachApi<CoachLessonDto>('PUT', `/lessons/${this.id}/note`, {
        note: sent,
      })
      // Text typed while the save was on its way stays, and is still unsaved.
      const typed = this.data.note !== sent
      this.show(saved, typed)
      if (typed) this.setData({ noteDirty: this.data.note.trim() !== saved.coachNote })
      wx.showToast({ title: '备注已保存', icon: 'none' })
    } catch (err) {
      // Refused for how the lesson stands now: reload it, keeping the unsaved note.
      if (refreshAfter(err)) await this.load()
      showError(err)
    } finally {
      this.setData({ savingNote: false })
    }
  },

  writeFeedback() {
    askForNotices()
    const lesson = this.data.lesson
    if (!lesson || lesson.feedbackBlocked) return
    navigateOnce(`/coach/feedback/index?id=${lesson.id}`, {
      saved: (saved: CoachLessonDto) => this.show(saved),
      // Refused because the lesson changed meanwhile: show it as it is now.
      stale: () => this.load(),
    })
  },

  /** Once the feedback can no longer be changed, the coach can still take it down. */
  async deleteFeedback() {
    askForNotices()
    if (!this.data.lesson?.feedback || this.feedbackAsking) return
    this.feedbackAsking = true
    try {
      if (!(await confirmDeleteFeedback())) return
      this.setData({ deletingFeedback: true })
      this.show(await coachApi<CoachLessonDto>('DELETE', `/lessons/${this.id}/feedback`))
      wx.showToast({ title: '已删除', icon: 'success' })
    } catch (err) {
      if (refreshAfter(err)) await this.load()
      showError(err)
    } finally {
      this.feedbackAsking = false
      this.setData({ deletingFeedback: false })
    }
  },

  editProfile() {
    const lesson = this.data.lesson
    if (!lesson?.profile) return
    navigateOnce(`/coach/profile/index?id=${lesson.id}`, {
      saved: (saved: CoachLessonDto) => this.show(saved),
      // Refused because the lesson or the student changed meanwhile: show it as it is now.
      stale: () => this.load(),
    })
  },

  openStudentFeedback() {
    const lesson = this.data.lesson
    if (lesson?.profile) navigateOnce(`/coach/student-feedback/index?id=${lesson.id}`)
  },

  toggleNote() {
    this.setData({ noteOpen: !this.data.noteOpen })
  },

  previewPhoto(e: WechatMiniprogram.TouchEvent) {
    previewPhotos(this.data.feedbackPhotos, e.currentTarget.dataset.index)
  },

  call() {
    const phone = this.data.lesson?.student.phone
    if (phone) openOnce((complete) => wx.makePhoneCall({ phoneNumber: phone, complete }))
  },

  move() {
    askForNotices()
    const lesson = this.data.lesson
    if (!lesson?.canMove || this.data.cancelling) return
    navigateOnce(`/coach/move/index?id=${lesson.id}`, {
      moved: (moved: CoachLessonDto) => this.show(moved),
      // The move was refused because the lesson changed: show it as it is now.
      stale: () => this.load(),
    })
  },

  async cancel() {
    askForNotices()
    const lesson = this.data.lesson
    if (!lesson || this.data.cancelling || this.cancelAsking) return
    // Held across both modals, so a double tap cannot start a second cancel.
    this.cancelAsking = true
    try {
      await this.askAndCancel(lesson)
    } finally {
      this.cancelAsking = false
    }
  },

  async askAndCancel(lesson: CoachLessonDto) {
    const asked = await wx.showModal({
      title: '取消原因',
      editable: true,
      placeholderText: '学员会看到，如：教练生病',
      confirmText: '下一步',
    })
    if (!asked.confirm) return
    const reason = (asked.content ?? '').trim()
    if (!reason) {
      wx.showToast({ title: '请填写取消原因', icon: 'none' })
      return
    }
    // The API takes 100 characters at most.
    if (reason.length > CANCEL_REASON_MAX) {
      wx.showToast({ title: `取消原因不能超过 ${CANCEL_REASON_MAX} 个字`, icon: 'none' })
      return
    }
    const refund =
      lesson.paidWith === 'package'
        ? '课时将退回学员的课时包。'
        : lesson.status === 'pending_payment'
          ? '学员还未付款，订单会关闭。'
          : lesson.price > 0
            ? // Paid at the front desk, so the money is handed back there.
              lesson.paidOffline
              ? '已付的款项会全额到店退还。'
              : '已付的款项会全额原路退回。'
            : ''
    const { confirm } = await wx.showModal({
      title: '取消这节课？',
      content: `${refund}请同时电话告知学员。`,
      confirmText: '取消课程',
      confirmColor: modalDangerColor(),
      cancelText: '再想想',
    })
    if (!confirm) return
    this.setData({ cancelling: true })
    try {
      this.show(await coachApi<CoachLessonDto>('POST', `/lessons/${this.id}/cancel`, { reason }))
      wx.showToast({ title: '已取消', icon: 'success' })
    } catch (err) {
      // Not cancellable any more, say started or cancelled meanwhile: show it as it stands.
      if (refreshAfter(err)) await this.load()
      showError(err)
    } finally {
      this.setData({ cancelling: false })
    }
  },

  retry() {
    this.setData({ state: 'loading' })
    this.load()
  },
})
