import { type CoachLessonDto, FEEDBACK_PHOTOS } from '../../lib/shared'
import { ApiError, assetUrl, errorMessage, showError } from '../../utils/api'
import { lessonTime } from '../../utils/format'
import { backOr, isTop } from '../../utils/nav'
import { previewPhotos } from '../../utils/photos'
import { askForNotices, bindInstead, coachApi, coachUpload } from '../utils/coach-api'
import { confirmDeleteFeedback } from '../utils/feedback'

interface PhotoView {
  key: string
  /** What the image shows: the local file while it uploads, then the server copy. */
  src: string
  /** The server's URL once uploaded. */
  url: string
  uploading: boolean
}

// The lesson changed so feedback can no longer be written here: say why and go back.
const LESSON_CHANGED = [
  'not_attended',
  'too_late',
  'feedback_hidden',
  'feedback_deleted',
  'account_deleted',
  'not_found',
]

const changed = (err: unknown): err is ApiError =>
  err instanceof ApiError && LESSON_CHANGED.includes(err.code)

let keys = 0

Page({
  data: {
    state: 'loading' as 'loading' | 'ready' | 'error',
    error: '',
    canRetry: true,
    errorIcon: { name: 'error-circle', size: '112rpx' },
    student: '',
    when: '',
    existing: false,
    text: '',
    photos: [] as PhotoView[],
    maxPhotos: FEEDBACK_PHOTOS,
    // WeChat's own editor, for cropping and rotating a photo. Base library 2.22 and later.
    canEdit: wx.canIUse('editImage'),
    textSize: { minHeight: 240, maxHeight: 600 },
    canSave: false,
    saving: false,
    deleting: false,
  },

  id: 0,
  /** Held from the first tap, before page data can show it, so a double tap does one thing. */
  busy: false,
  choosing: false,
  /** What was saved last, to tell whether there is anything to save. */
  savedText: '',
  savedPhotos: '',
  gone: false,

  onLoad(query: Record<string, string | undefined>) {
    this.id = Number(query.id)
    this.load()
  },

  onUnload() {
    this.gone = true
  },

  async load() {
    try {
      const lesson = await coachApi<CoachLessonDto>('GET', `/lessons/${this.id}`)
      if (lesson.feedbackBlocked) {
        this.getOpenerEventChannel().emit?.('stale')
        this.setData({ state: 'error', canRetry: false, error: lesson.feedbackBlocked })
        return
      }
      const f = lesson.feedback
      this.savedText = f?.text ?? ''
      this.savedPhotos = (f?.photos ?? []).join('\n')
      this.setData({
        state: 'ready',
        student: lesson.student.name || '未填写姓名',
        when: lessonTime(lesson.startsAt, lesson.endsAt),
        existing: f !== null,
        text: f?.text ?? '',
        photos: (f?.photos ?? []).map((url) => ({
          key: `p${keys++}`,
          src: assetUrl(url),
          url,
          uploading: false,
        })),
      })
      this.refresh()
    } catch (e) {
      if (bindInstead(e, this)) return
      this.setData({ state: 'error', canRetry: true, error: errorMessage(e) })
    }
  },

  retry() {
    this.setData({ state: 'loading' })
    this.load()
  },

  /** Updates whether saving does anything, and guards leaving with unsaved changes. */
  refresh() {
    const { text, photos } = this.data
    const uploading = photos.some((p) => p.uploading)
    const dirty =
      text.trim() !== this.savedText || photos.map((p) => p.url).join('\n') !== this.savedPhotos
    this.setData({ canSave: dirty && !uploading && text.trim().length > 0 })
    if (dirty) wx.enableAlertBeforeUnload({ message: '点评还没有保存，确定离开吗？' })
    else wx.disableAlertBeforeUnload()
  },

  onText(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ text: e.detail.value })
    this.refresh()
  },

  async addPhotos() {
    if (this.choosing || this.busy) return
    const room = FEEDBACK_PHOTOS - this.data.photos.length
    if (room <= 0) return
    this.choosing = true
    let files: WechatMiniprogram.MediaFile[] = []
    try {
      files = (
        await wx.chooseMedia({
          count: room,
          mediaType: ['image'],
          sizeType: ['compressed'],
          sourceType: ['album', 'camera'],
        })
      ).tempFiles
    } catch {
      // Closed without picking.
    } finally {
      this.choosing = false
    }
    const added = files
      .slice(0, FEEDBACK_PHOTOS - this.data.photos.length)
      .map((f) => ({ key: `p${keys++}`, src: f.tempFilePath, url: '', uploading: true }))
    if (!added.length) return
    this.setData({ photos: [...this.data.photos, ...added] })
    this.refresh()
    // One at a time, in the order picked.
    for (const photo of added) {
      if (!(await this.upload(photo))) return
    }
  },

  /**
   * Uploads the photo with this key and shows the server copy. On failure it is put back to
   * `previous`, or removed when it was new. Returns false when the rest should not be tried.
   */
  async upload(photo: PhotoView, previous?: PhotoView): Promise<boolean> {
    try {
      const { url } = await coachUpload<{ url: string }>(`/lessons/${this.id}/photos`, photo.src)
      if (this.gone) return false
      this.setData({
        photos: this.data.photos.map((p) =>
          p.key === photo.key ? { ...p, url, uploading: false } : p,
        ),
      })
    } catch (err) {
      if (this.gone) return false
      if (changed(err)) {
        // The rest would fail the same way.
        this.failed(err)
        return false
      }
      this.setData({
        photos: previous
          ? this.data.photos.map((p) => (p.key === photo.key ? previous : p))
          : this.data.photos.filter((p) => p.key !== photo.key),
      })
      showError(err)
    }
    this.refresh()
    return true
  },

  /** Opens WeChat's editor to crop or rotate a photo, then uploads the result in its place. */
  async editPhoto(e: WechatMiniprogram.TouchEvent) {
    if (this.choosing || this.busy) return
    const previous = this.data.photos[Number(e.currentTarget.dataset.index)]
    if (!previous || previous.uploading) return
    this.choosing = true
    let edited = ''
    try {
      // The editor takes a local file; a saved photo is downloaded first.
      const local = previous.src.startsWith('http')
        ? (await wx.getImageInfo({ src: previous.src })).path
        : previous.src
      const full = await new Promise<string>((resolve, reject) =>
        wx.editImage({ src: local, success: (r) => resolve(r.tempFilePath), fail: reject }),
      )
      // The editor saves at full size, which can be over the upload limit; 添加 compresses too.
      edited = await new Promise<string>((resolve) =>
        wx.compressImage({
          src: full,
          quality: 80,
          success: (r) => resolve(r.tempFilePath),
          fail: () => resolve(full),
        }),
      )
    } catch (err) {
      // Closed without saving, or the photo could not be downloaded.
      if (!/cancel/.test((err as { errMsg?: string }).errMsg ?? '')) {
        wx.showToast({ title: '无法打开这张照片', icon: 'none' })
      }
    } finally {
      this.choosing = false
    }
    if (!edited || this.gone) return
    // Removed while the editor was open.
    if (!this.data.photos.some((p) => p.key === previous.key)) return
    const photo = { key: `p${keys++}`, src: edited, url: '', uploading: true }
    this.setData({
      photos: this.data.photos.map((p) => (p.key === previous.key ? photo : p)),
    })
    this.refresh()
    await this.upload(photo, previous)
  },

  removePhoto(e: WechatMiniprogram.TouchEvent) {
    if (this.busy) return
    const index = Number(e.currentTarget.dataset.index)
    this.setData({ photos: this.data.photos.filter((_, i) => i !== index) })
    this.refresh()
  },

  previewPhoto(e: WechatMiniprogram.TouchEvent) {
    previewPhotos(
      this.data.photos.map((p) => p.src),
      e.currentTarget.dataset.index,
    )
  },

  async save() {
    askForNotices()
    if (this.busy || !this.data.canSave) return
    this.busy = true
    this.setData({ saving: true })
    const existing = this.data.existing
    try {
      const lesson = await coachApi<CoachLessonDto>('PUT', `/lessons/${this.id}/feedback`, {
        text: this.data.text,
        photos: this.data.photos.map((p) => p.url),
      })
      this.done(lesson, existing ? '已保存' : '已发布')
    } catch (err) {
      this.failed(err)
    } finally {
      this.busy = false
      this.setData({ saving: false })
    }
  },

  async remove() {
    askForNotices()
    if (this.busy) return
    this.busy = true
    try {
      if (!(await confirmDeleteFeedback())) return
      this.setData({ deleting: true })
      const lesson = await coachApi<CoachLessonDto>('DELETE', `/lessons/${this.id}/feedback`)
      this.done(lesson, '已删除')
    } catch (err) {
      this.failed(err)
    } finally {
      this.busy = false
      this.setData({ deleting: false })
    }
  },

  done(lesson: CoachLessonDto, message: string) {
    wx.disableAlertBeforeUnload()
    this.getOpenerEventChannel().emit?.('saved', lesson)
    const toast = () => wx.showToast({ title: message, icon: 'success' })
    if (isTop(this)) backOr(`/coach/lesson/index?id=${this.id}`, toast)
    else toast()
  },

  async failed(err: unknown) {
    if (!changed(err)) {
      showError(err)
      return
    }
    this.getOpenerEventChannel().emit?.('stale')
    wx.disableAlertBeforeUnload()
    await wx.showModal({ title: '无法保存', content: err.message, showCancel: false })
    if (isTop(this)) backOr(`/coach/lesson/index?id=${this.id}`)
  },
})
