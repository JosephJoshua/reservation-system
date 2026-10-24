import type { CatalogDto, HomeDto, MeDto, PackageDto } from '../../lib/shared'
import { api, publicApi, showError } from '../../utils/api'
import { getCatalog, getMe } from '../../utils/data'
import { maskPhone } from '../../utils/format'
import { navigateOnce } from '../../utils/nav'
import { openOnce } from '../../utils/tap'
import { THEME_SETTING_LABELS, themeSetting } from '../../utils/theme'

Page({
  data: {
    name: '',
    phone: '',
    // Shown at the front desk, which tells students with the same phone apart by it.
    studentNo: 0,
    remaining: '',
    packagesEnabled: false,
    venue: null as HomeDto['venue'] | null,
    hasBookingPolicy: false,
    isCoach: false,
    meLoaded: false,
    meFailed: false,
    themeLabel: '',
  },

  onShow() {
    this.setData({ themeLabel: THEME_SETTING_LABELS[themeSetting()] })
    this.load()
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh())
  },

  async load() {
    // Each part fills in on its own, so one failing request does not blank the page. What was
    // loaded before stays, and one toast says something failed.
    let told = false
    const fail = (e: unknown) => {
      if (told) return
      told = true
      showError(e)
    }
    const me = getMe()
      .then((me: MeDto) =>
        this.setData({
          name: me.name,
          phone: me.phone ? maskPhone(me.phone) : '',
          studentNo: me.id,
          isCoach: me.isCoach,
          meLoaded: true,
          meFailed: false,
        }),
      )
      .catch((e: unknown) => {
        this.setData({ meFailed: true })
        fail(e)
      })
    const packages = api<PackageDto[]>('GET', '/packages')
      .then((packages) => {
        const left = packages
          .filter((p) => p.status === 'active')
          .reduce((sum, p) => sum + p.lessonsRemaining, 0)
        this.setData({ remaining: left ? `剩余 ${left} 节` : '' })
      })
      .catch(fail)
    const catalog = getCatalog()
      .then((catalog: CatalogDto) =>
        this.setData({
          packagesEnabled: catalog.payment.packagesEnabled,
          hasBookingPolicy: Boolean(catalog.policies.booking),
        }),
      )
      .catch(fail)
    const home = publicApi<HomeDto>('GET', '/home')
      .then((home) => this.setData({ venue: home.venue }))
      .catch(fail)
    await Promise.all([me, packages, catalog, home])
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

  openFeedback() {
    navigateOnce('/pages/feedback/index')
  },

  openPackages() {
    navigateOnce('/pages/packages/index')
  },

  openTheme() {
    navigateOnce('/pages/theme/index')
  },

  openInvoices() {
    navigateOnce('/pages/invoices/index')
  },

  openLink() {
    navigateOnce('/pages/link/index')
  },

  openPolicy(e: WechatMiniprogram.TouchEvent) {
    navigateOnce(`/pages/policy/index?kind=${e.currentTarget.dataset.kind}`)
  },

  openMap() {
    const venue = this.data.venue
    if (!venue) return
    const { latitude, longitude } = venue
    if (latitude == null || longitude == null) {
      openOnce((complete) => wx.setClipboardData({ data: venue.address, complete }))
      return
    }
    openOnce((complete) =>
      wx.openLocation({
        latitude,
        longitude,
        name: venue.name,
        address: venue.address,
        scale: 16,
        complete,
      }),
    )
  },

  call() {
    const phone = this.data.venue?.phone
    if (phone) openOnce((complete) => wx.makePhoneCall({ phoneNumber: phone, complete }))
  },
})
