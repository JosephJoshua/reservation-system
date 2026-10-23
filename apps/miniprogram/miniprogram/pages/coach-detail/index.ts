import type { CoachDetailDto } from '../../lib/shared'
import { ApiError, api, assetUrl, errorMessage } from '../../utils/api'
import { getCatalog } from '../../utils/data'
import { priceText } from '../../utils/format'
import { navigateBackOnce, navigateOnce, switchTabOnce } from '../../utils/nav'
import { richTextNodes } from '../../utils/rich-text'

interface LessonRow {
  id: number
  name: string
  duration: string
  price: string
  original: string
}

Page({
  data: {
    state: 'loading' as 'loading' | 'ready' | 'error',
    error: '',
    missing: false,
    errorIcon: { name: 'error-circle', size: '112rpx' },
    emptyIcon: { name: 'calendar', size: '96rpx' },
    id: 0,
    name: '',
    category: '',
    title: '',
    tags: [] as string[],
    avatar: '',
    lessons: [] as LessonRow[],
    profile: '',
  },

  onLoad(query: Record<string, string | undefined>) {
    this.setData({ id: Number(query.id) })
    this.load()
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh())
  },

  async load() {
    try {
      const [coach, catalog] = await Promise.all([
        api<CoachDetailDto>('GET', `/coaches/${this.data.id}`),
        getCatalog(),
      ])
      wx.setNavigationBarTitle({ title: coach.name })
      const lessons = coach.lessons.flatMap((l): LessonRow[] => {
        const type = catalog.lessonTypes.find((t) => t.id === l.lessonTypeId)
        if (!type) return []
        return [
          {
            id: type.id,
            name: type.name,
            duration: `${type.durationMinutes}分钟`,
            ...priceText(l.price),
          },
        ]
      })
      this.setData({
        state: 'ready',
        name: coach.name,
        category: coach.category,
        title: coach.title,
        tags: coach.tags,
        avatar: coach.avatarUrl ? assetUrl(coach.avatarUrl) : '',
        lessons,
        profile: richTextNodes(coach.profile),
      })
    } catch (e) {
      this.setData({
        state: 'error',
        error: errorMessage(e),
        missing: e instanceof ApiError && e.status === 404,
      })
    }
  },

  retry() {
    this.setData({ state: 'loading' })
    this.load()
  },

  /** A removed coach can't be reloaded, so leave the page instead. */
  leave() {
    if (getCurrentPages().length > 1) navigateBackOnce()
    else switchTabOnce('/pages/booking/index')
  },

  openLesson(e: WechatMiniprogram.TouchEvent) {
    this.book(Number(e.currentTarget.dataset.id))
  },

  /** With more than one lesson type, the student picks which one first. */
  pickLesson() {
    const { lessons } = this.data
    const only = lessons[0]
    if (lessons.length === 1 && only) {
      this.book(only.id)
      return
    }
    wx.showActionSheet({
      itemList: lessons.map((l) => `${l.name} ${l.price}`),
      success: (res) => {
        const picked = lessons[res.tapIndex]
        if (picked) this.book(picked.id)
      },
    })
  },

  book(lessonTypeId: number) {
    // Opened from that lesson's booking page with this coach picked: just go back to it.
    const pages = getCurrentPages()
    const prev = pages[pages.length - 2]
    if (
      prev?.route === 'pages/book/index' &&
      prev.data.lessonTypeId === lessonTypeId &&
      prev.data.coachId === this.data.id
    ) {
      navigateBackOnce()
      return
    }
    navigateOnce(`/pages/book/index?lessonTypeId=${lessonTypeId}&coachId=${this.data.id}`)
  },

  onShareAppMessage() {
    return {
      title: `${this.data.name} · ${this.data.title || '乒乓球私教'}`,
      path: `/pages/coach-detail/index?id=${this.data.id}`,
    }
  },
})
