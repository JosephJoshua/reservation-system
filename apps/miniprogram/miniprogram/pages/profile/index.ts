import type { CatalogDto, HomeDto, PackageDto, StudentDto } from '../../lib/shared'
import { api, publicApi } from '../../utils/api'
import { getCatalog, getMe } from '../../utils/data'
import { maskPhone } from '../../utils/format'

Page({
  data: {
    name: '',
    phone: '',
    remaining: '',
    packagesEnabled: false,
    venue: null as HomeDto['venue'] | null,
    hasBookingPolicy: false,
    hasAgreement: false,
  },

  onShow() {
    this.load()
  },

  async load() {
    // Each part fills in on its own, so one failing request does not blank the page.
    getMe()
      .then((me: StudentDto) =>
        this.setData({ name: me.name, phone: me.phone ? maskPhone(me.phone) : '' }),
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
          hasAgreement: Boolean(catalog.policies.agreement),
        }),
      )
      .catch(() => {})
    publicApi<HomeDto>('GET', '/home')
      .then((home) => this.setData({ venue: home.venue }))
      .catch(() => {})
  },

  editProfile() {
    wx.navigateTo({ url: '/pages/profile-edit/index' })
  },

  openMyPackages() {
    wx.navigateTo({ url: '/pages/my-packages/index' })
  },

  openPackages() {
    wx.navigateTo({ url: '/pages/packages/index' })
  },

  openPolicy(e: WechatMiniprogram.TouchEvent) {
    wx.navigateTo({ url: `/pages/policy/index?kind=${e.currentTarget.dataset.kind}` })
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
