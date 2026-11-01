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
import { backOr, isTop } from '../../utils/nav'
import { bindInstead, coachApi, profileClosed } from '../utils/coach-api'
import { profileEdited } from '../utils/labels'

const FIELD_NAMES = { level: '水平', grip: '握拍', tags: '标签', note: '备注' } as const

/** What a refused save did to the form, after it took in what someone else saved first. */
function conflictText(
  both: (keyof StudentProfileEdit)[],
  theirNote: string,
  changed: boolean,
): string {
  const lead = '档案刚被其他人修改。'
  if (!changed) return `${lead}对方已保存了你的修改，无需再保存。`
  if (!both.length) return `${lead}你的修改已保留，其余已更新，请确认后保存。`
  const note = both.includes('note')
    ? `\n对方的备注：${theirNote.length > 80 ? `${theirNote.slice(0, 80)}…` : theirNote || '（空）'}`
    : ''
  return `${lead}对方也改了${both.map((k) => FIELD_NAMES[k]).join('、')}，现显示你的内容，保存会覆盖对方的。${note}`
}

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
  /** When save last refused the tags, so a double tap shows that once. */
  warnedAt: 0,
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
      if (bindInstead(e, this)) return
      const closed = profileClosed(e)
      if (closed) this.getOpenerEventChannel().emit?.('stale')
      this.setData({ state: 'error', canRetry: !closed, error: errorMessage(e) })
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
  async merge(): Promise<
    { both: (keyof StudentProfileEdit)[]; theirNote: string } | 'closed' | 'failed'
  > {
    const before = this.loaded
    const mine = this.form()
    try {
      const lesson = await coachApi<CoachLessonDto>('GET', `/lessons/${this.id}`)
      if (!lesson.profile || !before) return 'closed'
      const theirs = profileEdit(lesson.profile)
      const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
      const keys = ['level', 'grip', 'tags', 'note'] as const
      // Changed on both sides to different values: this coach's stays on screen, and is named.
      const both = keys.filter(
        (k) =>
          !same(mine[k], before[k]) && !same(theirs[k], before[k]) && !same(mine[k], theirs[k]),
      )
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
      return { both: [...both], theirNote: theirs.note }
    } catch (e) {
      if (profileClosed(e)) return 'closed'
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
      // Shown once for a double tap.
      if (Date.now() - this.warnedAt < 1500) return
      this.warnedAt = Date.now()
      // Most often the tag still being typed: say so, as it is not in the list yet.
      const typed = this.data.typing.trim()
      const inBox = typed && tagsError([typed])
      wx.showToast({
        title: inBox ? `输入框里的标签超过 ${PROFILE_TAG_LENGTH} 个字` : error,
        icon: 'none',
      })
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
      const done = () => wx.showToast({ title: '已保存', icon: 'success' })
      if (isTop(this)) backOr(`/coach/lesson/index?id=${this.id}`, done)
      else done()
    } catch (err) {
      // The spinner stops before any dialog; busy still holds until the dialog is closed.
      this.setData({ saving: false })
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
      if (merged !== 'closed') {
        this.getOpenerEventChannel().emit?.('stale')
        await wx.showModal({
          title: '档案已被修改',
          content: conflictText(merged.both, merged.theirNote, this.data.canSave),
          showCancel: false,
        })
        return
      }
      err = new ApiError(409, 'profile_closed', '这节课已不能查看学员档案')
    }
    if (!profileClosed(err)) {
      showError(err)
      return
    }
    this.getOpenerEventChannel().emit?.('stale')
    wx.disableAlertBeforeUnload()
    await wx.showModal({ title: '无法保存', content: err.message, showCancel: false })
    if (isTop(this)) backOr(`/coach/lesson/index?id=${this.id}`)
  },
})
