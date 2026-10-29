import { FEEDBACK_RECORD_LIMIT, type FeedbackItemDto } from '../../lib/shared'
import { assetUrl, errorMessage } from '../../utils/api'
import { fullDate } from '../../utils/format'
import { previewPhotos } from '../../utils/photos'
import { bindInstead, coachApi, profileClosed } from '../utils/coach-api'

interface ItemView {
  bookingId: number
  date: string
  lesson: string
  text: string
  photos: string[]
}

function view(f: FeedbackItemDto): ItemView {
  return {
    bookingId: f.bookingId,
    date: fullDate(f.startsAt),
    lesson: `${f.coachName} · ${f.lessonTypeName}`,
    text: f.text,
    photos: f.photos.map(assetUrl),
  }
}

// Every 课后点评 the lesson's student sees, from any coach, as part of their 学员档案.
Page({
  data: {
    state: 'loading' as 'loading' | 'ready' | 'error',
    error: '',
    canRetry: true,
    items: [] as ItemView[],
    limit: FEEDBACK_RECORD_LIMIT,
    emptyIcon: { name: 'chat', size: '112rpx' },
    errorIcon: { name: 'error-circle', size: '112rpx' },
  },

  id: 0,
  request: 0,
  loaded: false,

  onLoad(query: Record<string, string | undefined>) {
    this.id = Number(query.id)
    this.load()
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh())
  },

  async load() {
    const request = ++this.request
    try {
      const rows = await coachApi<FeedbackItemDto[]>('GET', `/lessons/${this.id}/student-feedback`)
      if (request !== this.request) return
      this.loaded = true
      this.setData({
        state: 'ready',
        items: rows.map(view),
      })
    } catch (e) {
      if (request !== this.request) return
      if (bindInstead(e, this)) return
      const closed = profileClosed(e)
      // A list already on screen stays; only a first load, or a lesson now closed, shows the error.
      if (this.loaded && !closed) wx.showToast({ title: errorMessage(e), icon: 'none' })
      else this.setData({ state: 'error', canRetry: !closed, error: errorMessage(e) })
    }
  },

  retry() {
    this.setData({ state: 'loading' })
    this.load()
  },

  previewPhoto(e: WechatMiniprogram.TouchEvent) {
    const item = this.data.items[Number(e.currentTarget.dataset.item)]
    if (item) previewPhotos(item.photos, e.currentTarget.dataset.index)
  },
})
