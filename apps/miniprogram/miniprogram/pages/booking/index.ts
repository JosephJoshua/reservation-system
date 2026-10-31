import {
  type BannerDto,
  type CatalogDto,
  type HomeDto,
  NO_LINK,
  phoneToDial,
} from '../../lib/shared'
import { assetUrl, errorMessage, publicApi, showError } from '../../utils/api'
import { catalogFetchedAt, getCatalog, TRIAL_USED_UP, trialUsedUp } from '../../utils/data'
import { priceText } from '../../utils/format'
import { openLink, openVenue } from '../../utils/link'
import { navigateOnce } from '../../utils/nav'
import { openOnce } from '../../utils/tap'

Page({
  data: {
    state: 'loading' as 'loading' | 'ready' | 'error',
    error: '',
    emptyIcon: { name: 'calendar', size: '112rpx' },
    errorIcon: { name: 'error-circle', size: '112rpx' },
    venue: null as HomeDto['venue'] | null,
    notice: '',
    noticeLink: NO_LINK,
    banners: [] as (BannerDto & { src: string })[],
    lessonTypes: [] as {
      id: number
      name: string
      description: string
      duration: string
      isTrial: boolean
      /** A 体验课 this student has used up: shown, but not opened. */
      usedUp: boolean
      isGroup: boolean
      price: string
      original: string
      from: boolean
    }[],
    coaches: [] as { id: number; name: string; category: string; title: string; avatar: string }[],
    packageCount: 0,
  },

  /** When the catalog this page shows was fetched. */
  catalogAt: 0,

  onLoad() {
    this.load()
  },

  onShow() {
    // Another page refreshed the catalog meanwhile, say after booking a 体验课.
    if (this.data.state !== 'ready') return
    getCatalog()
      .then((catalog) => {
        if (catalogFetchedAt() === this.catalogAt) return
        this.catalogAt = catalogFetchedAt()
        this.setData(this.catalogData(catalog))
      })
      .catch(() => undefined)
  },

  onPullDownRefresh() {
    this.load(true).finally(() => wx.stopPullDownRefresh())
  },

  async load(fresh = false) {
    try {
      const [home, catalog] = await Promise.all([
        publicApi<HomeDto>('GET', '/home'),
        getCatalog(fresh),
      ])
      this.catalogAt = catalogFetchedAt()
      this.show(home, catalog)
    } catch (e) {
      // A failed refresh keeps what is on screen.
      if (this.data.state === 'ready') showError(e)
      else this.setData({ state: 'error', error: errorMessage(e) })
    }
  },

  show(home: HomeDto, catalog: CatalogDto) {
    if (home.venue.name) wx.setNavigationBarTitle({ title: home.venue.name })
    this.setData({
      state: 'ready',
      venue: home.venue,
      notice: home.notice ?? '',
      // Missing from an API older than this page.
      noticeLink: home.noticeLink ?? NO_LINK,
      banners: home.banners.map((b) => ({ ...b, src: assetUrl(b.imageUrl) })),
      ...this.catalogData(catalog),
    })
  },

  catalogData(catalog: CatalogDto) {
    return {
      lessonTypes: this.lessonRows(catalog),
      coaches: catalog.coaches.map((c) => ({
        id: c.id,
        name: c.name,
        category: c.category,
        title: c.title,
        avatar: c.avatarUrl ? assetUrl(c.avatarUrl) : '',
      })),
      packageCount: catalog.packageProducts.length,
    }
  },

  lessonRows(catalog: CatalogDto) {
    const usedUp = trialUsedUp(catalog)
    return catalog.lessonTypes.map((t) => {
      const { price, original } = priceText(t.fromPrice)
      // 起 only when coaches charge different prices for it.
      const prices = new Set(
        catalog.coaches.flatMap((c) =>
          c.lessons.filter((l) => l.lessonTypeId === t.id).map((l) => l.price.price),
        ),
      )
      return {
        id: t.id,
        name: t.name,
        description: t.description,
        duration:
          t.capacity > 1
            ? `${t.durationMinutes}分钟 · 最多${t.capacity}人`
            : `${t.durationMinutes}分钟`,
        isTrial: t.isTrial,
        usedUp: t.isTrial && usedUp,
        isGroup: t.capacity > 1,
        price,
        original,
        from: prices.size > 1,
      }
    })
  },

  retry() {
    this.setData({ state: 'loading' })
    this.load(true)
  },

  openBanner(e: WechatMiniprogram.TouchEvent) {
    const banner = this.data.banners[e.currentTarget.dataset.index as number]
    if (banner) openLink(banner, this.data.venue)
  },

  openNotice() {
    openLink(this.data.noticeLink, this.data.venue)
  },

  openLessonType(e: WechatMiniprogram.TouchEvent) {
    const row = this.data.lessonTypes[e.currentTarget.dataset.index as number]
    if (row?.usedUp) {
      wx.showToast({ title: TRIAL_USED_UP, icon: 'none' })
      return
    }
    navigateOnce(`/pages/book/index?lessonTypeId=${e.currentTarget.dataset.id}`)
  },

  openCoach(e: WechatMiniprogram.TouchEvent) {
    navigateOnce(`/pages/coach-detail/index?id=${e.currentTarget.dataset.id}`)
  },

  openPackages() {
    navigateOnce('/pages/packages/index')
  },

  openMap() {
    if (this.data.venue) openVenue(this.data.venue)
  },

  call() {
    // The first number: the phone may hold an extension, a second number or a note.
    const phone = phoneToDial(this.data.venue?.phone ?? '')
    if (phone) openOnce((complete) => wx.makePhoneCall({ phoneNumber: phone, complete }))
  },

  onShareAppMessage() {
    const name = this.data.venue?.name
    return { title: name ? `${name} · 课程预约` : '课程预约', path: '/pages/booking/index' }
  },
})
