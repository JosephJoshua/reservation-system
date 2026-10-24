import {
  type Attendance,
  type CoachLessonDto,
  gripLabels,
  type StudentProfileDto,
  studentLevelLabels,
} from '../../lib/shared'
import { assetUrl, errorMessage, showError } from '../../utils/api'
import { dateTime, fullDate, lessonTime, yuan } from '../../utils/format'
import { navigateOnce } from '../../utils/nav'
import { previewPhotos } from '../../utils/photos'
import { modalDangerColor } from '../../utils/theme'
import { askForNotices, coachApi } from '../utils/coach-api'
import { confirmDeleteFeedback } from '../utils/feedback'
import { ATTENDANCE, lessonTag, type Tag } from '../utils/labels'

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
  empty: boolean
  counts: string
}

/** The venue's 学员档案: level and grip first, then the venue's tags. */
function profileView(p: StudentProfileDto | null): ProfileView | null {
  if (!p) return null
  const traits = [p.level && studentLevelLabels[p.level], p.grip && gripLabels[p.grip]]
  const chips = [
    ...traits.flatMap((text) => (text ? [{ key: `trait:${text}`, text, trait: true }] : [])),
    ...p.tags.map((text) => ({ key: `tag:${text}`, text, trait: false })),
  ]
  return {
    chips,
    note: p.note,
    empty: !chips.length && !p.note,
    counts: `在本馆上课 ${p.lessons} 次${p.noShows ? `，缺席 ${p.noShows} 次` : ''}`,
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
  return '签到不是到课，学员看不到这条点评。'
}

/** Why no feedback can be written, for a lesson that has started and has none. */
function feedbackClosed(l: CoachLessonDto): string {
  // A lesson that has ended comes as completed.
  const started =
    (l.status === 'confirmed' || l.status === 'completed') && Date.parse(l.startsAt) <= Date.now()
  return started && !l.feedback ? (l.feedbackBlocked ?? '') : ''
}

function attendanceNote(l: CoachLessonDto): string {
  if (l.attendance) return `${ATTENDANCE[l.attendance]}。签到已截止，如需修改请联系场馆。`
  if (Date.parse(l.startsAt) > Date.now()) return '课程开始后可以签到。'
  return '签到已截止，如需补签请联系场馆。'
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
  },

  id: 0,
  cancelAsking: false,
  feedbackAsking: false,
  markedAt: 0,

  onLoad(query: Record<string, string | undefined>) {
    this.id = Number(query.id)
    this.load()
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh())
  },

  async load() {
    try {
      this.show(await coachApi<CoachLessonDto>('GET', `/lessons/${this.id}`))
    } catch (e) {
      this.setData({ state: 'error', error: errorMessage(e) })
    }
  },

  /** Shows a lesson; keeps an unsaved note unless the server has a newer one. */
  show(l: CoachLessonDto, keepNote?: boolean) {
    const keep = keepNote ?? this.data.noteDirty
    this.setData({
      state: 'ready',
      lesson: l,
      tag: lessonTag(l, l.startsAt, Date.now()),
      when: lessonTime(l.startsAt, l.endsAt),
      movedFrom: l.movedFrom ? dateTime(l.movedFrom) : '',
      lessonName: l.lessonType.isTrial ? `${l.lessonType.name}（体验课）` : l.lessonType.name,
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
  },

  async mark(e: WechatMiniprogram.TouchEvent) {
    askForNotices()
    const lesson = this.data.lesson
    if (!lesson || this.data.marking) return
    const picked = e.currentTarget.dataset.value as Attendance
    // The second tap of a double tap can land just after the first request returns; it would undo
    // the mark the first one made. A deliberate undo comes later than this.
    if (lesson.attendance === picked && Date.now() - this.markedAt < 400) return
    // Tapping the current mark again clears it.
    const attendance = lesson.attendance === picked ? null : picked
    this.setData({ marking: true })
    try {
      this.show(
        await coachApi<CoachLessonDto>('PUT', `/lessons/${this.id}/attendance`, { attendance }),
      )
      this.markedAt = Date.now()
      wx.showToast({ title: attendance ? ATTENDANCE[attendance] : '已撤销', icon: 'none' })
    } catch (err) {
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
      showError(err)
    } finally {
      this.feedbackAsking = false
      this.setData({ deletingFeedback: false })
    }
  },

  previewPhoto(e: WechatMiniprogram.TouchEvent) {
    previewPhotos(this.data.feedbackPhotos, e.currentTarget.dataset.index)
  },

  call() {
    const phone = this.data.lesson?.student.phone
    if (phone) wx.makePhoneCall({ phoneNumber: phone })
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
    const refund =
      lesson.paidWith === 'package'
        ? '课时将退回学员的课时包。'
        : lesson.status === 'pending_payment'
          ? '学员还未付款，订单会关闭。'
          : lesson.price > 0
            ? '已付款项将全额退回。'
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
