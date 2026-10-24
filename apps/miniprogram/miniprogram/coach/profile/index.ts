import {
  type CoachLessonDto,
  cleanTags,
  type Grip,
  gripLabels,
  grips,
  PROFILE_MAX_TAGS,
  PROFILE_NOTE_LENGTH,
  PROFILE_TAG_LENGTH,
  profileEdit,
  type StudentLevel,
  type StudentProfileEdit,
  studentLevelLabels,
  studentLevels,
  tagsError,
  versionOf,
} from '../../lib/shared'
import { ApiError, errorMessage, showError } from '../../utils/api'
import { isTop, navigateBackOnce } from '../../utils/nav'
import { coachApi } from '../utils/coach-api'
import { profileEdited } from '../utils/labels'

// The lesson or the student changed so the profile can no longer be kept here: say why and go back.
const LESSON_CHANGED = ['profile_closed', 'account_deleted', 'not_found']

const changed = (err: unknown): err is ApiError =>
  err instanceof ApiError && LESSON_CHANGED.includes(err.code)

Page({
  data: {
    state: 'loading' as 'loading' | 'ready' | 'error',
    error: '',
    canRetry: true,
    errorIcon: { name: 'error-circle', size: '112rpx' },
    student: '',
    edited: '',
    level: null as StudentLevel | null,
    grip: null as Grip | null,
    levelText: '未填',
    gripText: '未填',
    tags: [] as string[],
    typing: '',
    note: '',
    maxTags: PROFILE_MAX_TAGS,
    tagLength: PROFILE_TAG_LENGTH,
    noteLength: PROFILE_NOTE_LENGTH,
    noteSize: { minHeight: 200, maxHeight: 600 },
    canSave: false,
    saving: false,
  },

  id: 0,
  /** Held from the first tap, before page data can show it, so a double tap saves once. */
  busy: false,
  picking: false,
  /** The profile as loaded: what the save is checked against, and what counts as unchanged. */
  loaded: null as StudentProfileEdit | null,

  onLoad(query: Record<string, string | undefined>) {
    this.id = Number(query.id)
    this.load()
  },

  async load() {
    try {
      const lesson = await coachApi<CoachLessonDto>('GET', `/lessons/${this.id}`)
      if (!lesson.profile) {
        this.getOpenerEventChannel().emit?.('stale')
        this.setData({ state: 'error', canRetry: false, error: '这节课已不能查看学员档案' })
        return
      }
      const p = lesson.profile
      this.loaded = profileEdit(p)
      this.setData({
        state: 'ready',
        student: lesson.student.name || '未填写姓名',
        edited: profileEdited(p),
        level: p.level,
        grip: p.grip,
        levelText: p.level ? studentLevelLabels[p.level] : '未填',
        gripText: p.grip ? gripLabels[p.grip] : '未填',
        tags: p.tags,
        typing: '',
        note: p.note,
      })
      this.refresh()
    } catch (e) {
      this.setData({ state: 'error', canRetry: true, error: errorMessage(e) })
    }
  },

  retry() {
    this.setData({ state: 'loading' })
    this.load()
  },

  /** The form as it would be saved; text typed in the tag box but not added still counts. */
  form(): StudentProfileEdit {
    const { level, grip, tags, typing, note } = this.data
    return { level, grip, tags: cleanTags([...tags, typing]), note: note.trim() }
  },

  /** Updates whether saving does anything, and guards leaving with unsaved changes. */
  refresh() {
    const dirty =
      this.loaded !== null && JSON.stringify(this.form()) !== JSON.stringify(this.loaded)
    this.setData({ canSave: dirty })
    if (dirty) wx.enableAlertBeforeUnload({ message: '学员档案还没有保存，确定离开吗？' })
    else wx.disableAlertBeforeUnload()
  },

  pickLevel() {
    this.pick(studentLevels, studentLevelLabels, this.data.level, (level) =>
      this.setData({ level, levelText: level ? studentLevelLabels[level] : '未填' }),
    )
  },

  pickGrip() {
    this.pick(grips, gripLabels, this.data.grip, (grip) =>
      this.setData({ grip, gripText: grip ? gripLabels[grip] : '未填' }),
    )
  },

  /** An action sheet of the choices, with 不填 last once one is chosen. */
  async pick<K extends string>(
    keys: K[],
    labels: Record<K, string>,
    current: K | null,
    set: (value: K | null) => void,
  ) {
    if (this.picking || this.busy) return
    this.picking = true
    try {
      const options: (K | null)[] = current ? [...keys, null] : keys
      const { tapIndex } = await wx.showActionSheet({
        itemList: options.map((k) => (k ? labels[k] : '不填')),
      })
      set(options[tapIndex] ?? null)
      this.refresh()
    } catch {
      // Closed without picking.
    } finally {
      this.picking = false
    }
  },

  onTyping(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ typing: e.detail.value })
    this.refresh()
  },

  addTag() {
    const typed = this.data.typing.trim()
    if (!typed) return
    const tags = cleanTags([...this.data.tags, typed])
    const error = tagsError(tags)
    if (error) {
      wx.showToast({ title: error, icon: 'none' })
      return
    }
    this.setData({ tags, typing: '' })
    this.refresh()
  },

  removeTag(e: WechatMiniprogram.TouchEvent) {
    if (this.busy) return
    const index = Number(e.currentTarget.dataset.index)
    this.setData({ tags: this.data.tags.filter((_, i) => i !== index) })
    this.refresh()
  },

  onNote(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ note: e.detail.value })
    this.refresh()
  },

  async save() {
    if (this.busy || !this.data.canSave || !this.loaded) return
    const form = this.form()
    const error = tagsError(form.tags)
    if (error) {
      wx.showToast({ title: error, icon: 'none' })
      return
    }
    this.busy = true
    this.setData({ saving: true })
    try {
      const lesson = await coachApi<CoachLessonDto>('PUT', `/lessons/${this.id}/profile`, form, {
        'If-Match': versionOf(this.loaded),
      })
      wx.disableAlertBeforeUnload()
      this.getOpenerEventChannel().emit?.('saved', lesson)
      if (isTop(this)) navigateBackOnce()
      wx.showToast({ title: '已保存', icon: 'success' })
    } catch (err) {
      await this.failed(err)
    } finally {
      this.busy = false
      this.setData({ saving: false })
    }
  },

  async failed(err: unknown) {
    if (err instanceof ApiError && err.code === 'edited_elsewhere') {
      // Another coach or the venue saved first: show theirs rather than overwrite it.
      await wx.showModal({
        title: '档案已被修改',
        content: '其他教练或场馆刚刚修改了这份档案，已为你显示最新内容，请确认后再改。',
        showCancel: false,
      })
      this.getOpenerEventChannel().emit?.('stale')
      await this.load()
      return
    }
    if (!changed(err)) {
      showError(err)
      return
    }
    this.getOpenerEventChannel().emit?.('stale')
    wx.disableAlertBeforeUnload()
    await wx.showModal({ title: '无法保存', content: err.message, showCancel: false })
    if (isTop(this)) navigateBackOnce()
  },
})
