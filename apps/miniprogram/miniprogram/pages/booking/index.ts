import type { BannerDto, CatalogDto, HomeDto } from '../../lib/shared'
import { assetUrl, errorMessage, publicApi } from '../../utils/api'
import { getCatalog } from '../../utils/data'
import { priceText } from '../../utils/format'
import { navigateOnce } from '../../utils/nav'

Page({
  data: {
    state: 'loading' as 'loading' | 'ready' | 'error',
    error: '',
    emptyIcon: { name: 'calendar', size: '112rpx' },
    errorIcon: { name: 'error-circle', size: '112rpx' },
    venue: null as HomeDto['venue'] | null,
    notice: '',
    banners: [] as (BannerDto & { src: string })[],
    lessonTypes: [] as {
      id: number
      name: string
      description: string
      duration: string
      isTrial: boolean
      price: string
      original: string
    }[],
    coaches: [] as { id: number; name: string; category: string; title: string; avatar: string }[],
    packageCount: 0,
  },

  onLoad() {
    this.load()
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
      this.show(home, catalog)
    } catch (e) {
      this.setData({ state: 'error', error: errorMessage(e) })
    }
  },

  show(home: HomeDto, catalog: CatalogDto) {
    if (home.venue.name) wx.setNavigationBarTitle({ title: home.venue.name })
    this.setData({
      state: 'ready',
      venue: home.venue,
      notice: home.notice ?? '',
      banners: home.banners.map((b) => ({ ...b, src: assetUrl(b.imageUrl) })),
      lessonTypes: catalog.lessonTypes.map((t) => {
        const { price, original } = priceText(t.fromPrice)
        return {
          id: t.id,
          name: t.name,
          description: t.description,
          duration: `${t.durationMinutes}分钟`,
          isTrial: t.isTrial,
          price,
          original,
        }
      }),
      coaches: catalog.coaches.map((c) => ({
        id: c.id,
        name: c.name,
        category: c.category,
        title: c.title,
        avatar: c.avatarUrl ? assetUrl(c.avatarUrl) : '',
      })),
      packageCount: catalog.packageProducts.length,
    })
  },

  retry() {
    this.setData({ state: 'loading' })
    this.load(true)
  },

  openBanner(e: WechatMiniprogram.TouchEvent) {
    const banner = this.data.banners[e.currentTarget.dataset.index as number]
    if (!banner?.linkId) return
    if (banner.linkKind === 'lesson_type') {
      navigateOnce(`/pages/book/index?lessonTypeId=${banner.linkId}`)
    } else if (banner.linkKind === 'package') {
      navigateOnce(`/pages/packages/index?id=${banner.linkId}`)
    }
  },

  openLessonType(e: WechatMiniprogram.TouchEvent) {
    navigateOnce(`/pages/book/index?lessonTypeId=${e.currentTarget.dataset.id}`)
  },

  openCoach(e: WechatMiniprogram.TouchEvent) {
    navigateOnce(`/pages/coach-detail/index?id=${e.currentTarget.dataset.id}`)
  },

  openPackages() {
    navigateOnce('/pages/packages/index')
  },

  openMap() {
    const venue = this.data.venue
    if (!venue) return
    if (venue.latitude == null || venue.longitude == null) {
      if (venue.address) wx.setClipboardData({ data: venue.address })
      return
    }
    wx.openLocation({
      latitude: venue.latitude,
      longitude: venue.longitude,
      name: venue.name,
      address: venue.address,
      scale: 16,
    })
  },

  call() {
    const phone = this.data.venue?.phone
    if (phone) wx.makePhoneCall({ phoneNumber: phone })
  },

  onShareAppMessage() {
    const name = this.data.venue?.name
    return { title: name ? `${name} · 课程预约` : '课程预约', path: '/pages/booking/index' }
  },
})
