import type { CatalogDto, HomeDto, MeDto, PackageDto } from '../../lib/shared'
import { api, publicApi } from '../../utils/api'
import { getCatalog, getMe } from '../../utils/data'
import { maskPhone } from '../../utils/format'
import { navigateOnce } from '../../utils/nav'

Page({
  data: {
    name: '',
    phone: '',
    remaining: '',
    packagesEnabled: false,
    venue: null as HomeDto['venue'] | null,
    hasBookingPolicy: false,
    isCoach: false,
    meLoaded: false,
  },

  onShow() {
    this.load()
  },

  async load() {
    // Each part fills in on its own, so one failing request does not blank the page.
    getMe()
      .then((me: MeDto) =>
        this.setData({
          name: me.name,
          phone: me.phone ? maskPhone(me.phone) : '',
          isCoach: me.isCoach,
          meLoaded: true,
        }),
      )
      .catch(() => {})
    api<PackageDto[]>('GET', '/packages')
      .then((packages) => {
        const left = packages
          .filter((p) => p.status === 'active')
          .reduce((sum, p) => sum + p.lessonsRemaining, 0)
        this.setData({ remaining: left ? `剩余 ${left} 节` : '' })
      })
      .catch(() => {})
    getCatalog()
      .then((catalog: CatalogDto) =>
        this.setData({
          packagesEnabled: catalog.payment.packagesEnabled,
          hasBookingPolicy: Boolean(catalog.policies.booking),
        }),
      )
      .catch(() => {})
    publicApi<HomeDto>('GET', '/home')
      .then((home) => this.setData({ venue: home.venue }))
      .catch(() => {})
  },

  editProfile() {
    navigateOnce('/pages/profile-edit/index')
  },

  openCoach() {
    navigateOnce('/coach/index/index')
  },

  openMyPackages() {
    navigateOnce('/pages/my-packages/index')
  },

  openPackages() {
    navigateOnce('/pages/packages/index')
  },

  openPolicy(e: WechatMiniprogram.TouchEvent) {
    navigateOnce(`/pages/policy/index?kind=${e.currentTarget.dataset.kind}`)
  },

  openMap() {
    const venue = this.data.venue
    if (!venue) return
    if (venue.latitude == null || venue.longitude == null) {
      wx.setClipboardData({ data: venue.address })
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
})
