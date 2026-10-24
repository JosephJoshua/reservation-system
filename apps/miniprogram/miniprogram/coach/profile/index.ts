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
      this.loaded = profileEdit(lesson.profile)
      this.setData({
        state: 'ready',
        student: lesson.student.name || '未填写姓名',
        edited: profileEdited(lesson.profile),
        typing: '',
      })
      this.fill(this.loaded)
    } catch (e) {
      this.setData({ state: 'error', canRetry: true, error: errorMessage(e) })
    }
  },

  fill(p: StudentProfileEdit) {
    this.setData({
      level: p.level,
      grip: p.grip,
      levelText: p.level ? studentLevelLabels[p.level] : '未填',
      gripText: p.grip ? gripLabels[p.grip] : '未填',
      tags: p.tags,
      note: p.note,
    })
    this.refresh()
  },

  /**
   * Someone else saved first. Takes their profile as the one to save on top of, keeping what this
   * coach changed and taking theirs for the rest, so nothing typed is lost and nothing of theirs is
   * overwritten without a second look.
   */
  async merge(): Promise<'merged' | 'closed' | 'failed'> {
    const before = this.loaded
    const mine = this.form()
    try {
      const lesson = await coachApi<CoachLessonDto>('GET', `/lessons/${this.id}`)
      if (!lesson.profile || !before) return 'closed'
      const theirs = profileEdit(lesson.profile)
      const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
      const pick = <K extends keyof StudentProfileEdit>(k: K) =>
        same(mine[k], before[k]) ? theirs[k] : mine[k]
      this.loaded = theirs
      this.setData({ edited: profileEdited(lesson.profile), typing: '' })
      this.fill({
        level: pick('level'),
        grip: pick('grip'),
        tags: pick('tags'),
        note: pick('note'),
      })
      return 'merged'
    } catch (e) {
      if (changed(e)) return 'closed'
      // The form stays as typed; the next save is refused again and tries once more.
      showError(e)
      return 'failed'
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

  async failed(error: unknown) {
    let err = error
    if (err instanceof ApiError && err.code === 'edited_elsewhere') {
      const merged = await this.merge()
      if (merged === 'failed') return
      if (merged === 'merged') {
        await wx.showModal({
          title: '档案已被修改',
          content:
            '其他教练或场馆刚刚修改了这份档案。你改过的内容已保留，其余已更新为最新，请确认后再保存。',
          showCancel: false,
        })
        this.getOpenerEventChannel().emit?.('stale')
        return
      }
      err = new ApiError(409, 'profile_closed', '这节课已不能查看学员档案')
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
