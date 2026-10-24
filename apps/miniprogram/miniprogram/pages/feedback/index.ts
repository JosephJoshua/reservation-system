import { FEEDBACK_RECORD_LIMIT, type FeedbackItemDto } from '../../lib/shared'
import { api, assetUrl, errorMessage } from '../../utils/api'
import { fullDate, time, weekday } from '../../utils/format'
import { navigateOnce } from '../../utils/nav'
import { previewPhotos } from '../../utils/photos'

interface ItemView {
  bookingId: number
  date: string
  lesson: string
  text: string
  photos: string[]
  /** The first three photos; the third says how many more there are. */
  shown: string[]
  more: number
}

function view(f: FeedbackItemDto): ItemView {
  const photos = f.photos.map(assetUrl)
  return {
    bookingId: f.bookingId,
    date: `${fullDate(f.startsAt)} ${weekday(f.startsAt)} ${time(f.startsAt)}`,
    lesson: `${f.lessonTypeName} · ${f.coachName}`,
    text: f.text,
    photos,
    shown: photos.slice(0, 3),
    more: Math.max(0, photos.length - 3),
  }
}

Page({
  data: {
    state: 'loading' as 'loading' | 'ready' | 'error',
    error: '',
    items: [] as ItemView[],
    limit: FEEDBACK_RECORD_LIMIT,
    emptyIcon: { name: 'chat', size: '112rpx' },
    errorIcon: { name: 'error-circle', size: '112rpx' },
  },

  request: 0,
  loaded: false,

  onShow() {
    // Again on return, so feedback changed meanwhile shows.
    this.load()
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh())
  },

  async load() {
    const request = ++this.request
    if (!this.loaded) this.setData({ state: 'loading' })
    try {
      const rows = await api<FeedbackItemDto[]>('GET', '/feedback')
      if (request !== this.request) return
      this.loaded = true
      this.setData({ state: 'ready', items: rows.map(view) })
    } catch (e) {
      if (request !== this.request) return
      // A list already on screen stays; only a first load shows the error.
      if (this.loaded) wx.showToast({ title: errorMessage(e), icon: 'none' })
      else this.setData({ state: 'error', error: errorMessage(e) })
    }
  },

  retry() {
    this.setData({ state: 'loading' })
    this.load()
  },

  open(e: WechatMiniprogram.TouchEvent) {
    navigateOnce(`/pages/booking-detail/index?id=${e.currentTarget.dataset.id}`)
  },

  previewPhoto(e: WechatMiniprogram.TouchEvent) {
    const item = this.data.items[Number(e.currentTarget.dataset.item)]
    if (item) previewPhotos(item.photos, e.currentTarget.dataset.index)
  },
})
