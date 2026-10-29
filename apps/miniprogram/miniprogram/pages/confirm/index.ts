import {
  type BookingQuoteDto,
  type BookingTerms,
  bookingTerms,
  type CreateBookingResponse,
  type MeDto,
  minCheckHours,
  type StudentDto,
} from '../../lib/shared'
import { ApiError, api, assetUrl, errorMessage, showError } from '../../utils/api'
import { agreePolicies, askForNotices, cancelRuleText, getCatalog, getMe } from '../../utils/data'
import { lessonTime, yuan } from '../../utils/format'
import { backOr, isTop, navigateOnce } from '../../utils/nav'
import { payOrder } from '../../utils/pay'

type PayWith = 'package' | 'wechat'

/**
 * Booking errors that mean this time cannot be booked any more, so the student should pick another:
 * taken, closed, deleted, too close, or its coach or lesson no longer offered.
 */
const SLOT_GONE = [
  'slot_taken',
  'time_unavailable',
  'tables_full',
  'slot_closed',
  'started',
  'too_soon',
  'too_far',
  'not_found',
  'coach_not_teaching',
  'slot_not_found',
  'coach_off',
  'venue_closed',
]

Page({
  data: {
    state: 'loading' as 'loading' | 'ready' | 'error',
    error: '',
    errorIcon: { name: 'error-circle', size: '112rpx' },
    /** A group session; 0 for a private lesson, which is booked by coach and start time. */
    slotId: 0,
    lessonTypeId: 0,
    coachId: 0,
    startsAt: '',
    lessonName: '',
    isTrial: false,
    when: '',
    duration: 0,
    /** For a group class: who it is for and when it is called off. */
    groupNote: '',
    coachName: '',
    coachTitle: '',
    coachAvatar: '',
    price: 0,
    priceText: '',
    originalText: '',
    pkg: null as { id: number; name: string; remaining: number } | null,
    perClassEnabled: true,
    payWith: 'wechat' as PayWith,
    cancelRule: '',
    needName: false,
    needPhone: false,
    name: '',
    phone: '',
    hasBookingPolicy: false,
    showAgreement: false,
    agreed: false,
    noticeTemplates: {} as MeDto['noticeTemplates'],
    submitting: false,
  },

  /** Set once the student has gone back from this page. */
  left: false,
  /** The cancel and move rules shown, which the booking must still be made under. */
  terms: null as BookingTerms | null,
  /** Set after the first onShow, so coming back to the page can be told apart. */
  shown: false,
  /** Counts quotes asked for, so only the latest one is shown. */
  quotes: 0,

  onLoad(query: Record<string, string | undefined>) {
    this.setData({
      slotId: Number(query.slotId ?? 0),
      lessonTypeId: Number(query.lessonTypeId),
      coachId: Number(query.coachId),
      startsAt: decodeURIComponent(query.startsAt ?? ''),
      when: lessonTime(
        decodeURIComponent(query.startsAt ?? ''),
        decodeURIComponent(query.endsAt ?? ''),
      ),
    })
    this.load()
  },

  onShow() {
    if (!this.shown) {
      this.shown = true
      return
    }
    // Back from buying a package (or from the coach or a policy page): the package to use and
    // the price may have changed meanwhile.
    if (this.data.state === 'ready' && !this.data.submitting) this.requote()
  },

  /** Where the booking goes: the session, or the coach and start time. */
  target() {
    const { slotId, coachId, startsAt } = this.data
    return slotId ? { slotId } : { coachId, startsAt }
  },

  /** The API says which package it will use and what it will charge. */
  quote(): Promise<BookingQuoteDto> {
    const target = Object.entries(this.target())
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join('&')
    return api<BookingQuoteDto>(
      'GET',
      `/bookings/quote?${target}&lessonTypeId=${this.data.lessonTypeId}`,
    )
  },

  /**
   * Asks for the quote again and shows it, keeping the rest of the page. A package that is new
   * since the last quote is picked; a student who chose WeChat Pay over the same package keeps it.
   */
  async requote() {
    const asked = ++this.quotes
    let quote: BookingQuoteDto
    try {
      quote = await this.quote()
    } catch {
      // The quote on screen stays; the booking is still checked against it.
      return
    }
    if (asked !== this.quotes || this.data.submitting || this.left) return
    const { price, package: pkg, perClassEnabled } = quote
    const before = this.data.pkg
    const usePackage =
      pkg !== null &&
      (!before || before.id !== pkg.id || this.data.payWith === 'package' || !perClassEnabled)
    this.setData({
      price: price.price,
      priceText: yuan(price.price),
      originalText: price.originalPrice == null ? '' : yuan(price.originalPrice),
      pkg: pkg ? { id: pkg.id, name: pkg.name, remaining: pkg.lessonsRemaining } : null,
      perClassEnabled,
      payWith: usePackage ? 'package' : 'wechat',
    })
  },

  async load() {
    // A quote still on its way would show over this one.
    this.quotes++
    try {
      const { lessonTypeId } = this.data
      const [catalog, quote, me] = await Promise.all([getCatalog(), this.quote(), getMe()])
      const lessonType = catalog.lessonTypes.find((t) => t.id === lessonTypeId)
      const coach = catalog.coaches.find((c) => c.id === this.data.coachId)
      if (!lessonType || !coach) {
        this.setData({ state: 'error', error: '这门课程暂时不能预约' })
        return
      }
      const { price, package: pkg, perClassEnabled } = quote
      this.terms = bookingTerms(lessonType.rules)
      this.setData({
        state: 'ready',
        lessonName: lessonType.name,
        isTrial: lessonType.isTrial,
        duration: lessonType.durationMinutes,
        groupNote:
          lessonType.capacity > 1
            ? `小班课，多人同上${
                lessonType.minStudents
                  ? `；如果开课前 ${minCheckHours(lessonType.rules)} 小时报名仍不足 ${lessonType.minStudents} 人，课程会自动取消，并退款或退回课时`
                  : ''
              }`
            : '',
        coachName: coach.name,
        coachTitle: coach.title,
        coachAvatar: coach.avatarUrl ? assetUrl(coach.avatarUrl) : '',
        price: price.price,
        priceText: yuan(price.price),
        originalText: price.originalPrice == null ? '' : yuan(price.originalPrice),
        pkg: pkg ? { id: pkg.id, name: pkg.name, remaining: pkg.lessonsRemaining } : null,
        perClassEnabled,
        payWith: pkg ? 'package' : 'wechat',
        cancelRule: cancelRuleText(
          lessonType.rules.cancelDeadlineHours,
          lessonType.rules.lateCancel,
        ),
        needName: !me.name,
        needPhone: !me.phone,
        hasBookingPolicy: Boolean(catalog.policies.booking),
        showAgreement: !me.agreedPolicies,
        noticeTemplates: me.noticeTemplates,
      })
    } catch (e) {
      this.setData({ state: 'error', error: errorMessage(e) })
    }
  },

  choosePackage() {
    if (this.data.pkg) this.setData({ payWith: 'package' })
  },

  chooseWechat() {
    if (this.data.perClassEnabled) this.setData({ payWith: 'wechat' })
  },

  onName(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ name: e.detail.value })
  },

  onPhone(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ phone: e.detail.value })
  },

  onAgree(e: WechatMiniprogram.CustomEvent<{ checked: boolean }>) {
    this.setData({ agreed: e.detail.checked })
  },

  openPolicy(e: WechatMiniprogram.TouchEvent) {
    if (this.data.submitting) return
    navigateOnce(`/pages/policy/index?kind=${e.currentTarget.dataset.kind}`)
  },

  openCoach() {
    if (this.data.submitting) return
    navigateOnce(`/pages/coach-detail/index?id=${this.data.coachId}`)
  },

  openPackages() {
    if (this.data.submitting) return
    navigateOnce(`/pages/packages/index?lessonTypeId=${this.data.lessonTypeId}`)
  },

  /** The first problem on the page, checked top to bottom, or '' when there is none. */
  problem(): string {
    const { needName, needPhone, showAgreement, agreed } = this.data
    if (needName && !this.data.name.trim()) return '请填写姓名'
    if (needPhone && !/^1\d{10}$/.test(this.data.phone.trim())) return '请填写正确的手机号'
    if (showAgreement && !agreed) return '请先阅读并同意用户协议和隐私政策'
    return ''
  },

  /** Saves the name and phone the venue needs before the first booking. */
  async saveProfile() {
    const { needName, needPhone } = this.data
    if (!needName && !needPhone) return
    await api<StudentDto>('PUT', '/me', {
      ...(needName ? { name: this.data.name.trim() } : {}),
      ...(needPhone ? { phone: this.data.phone.trim() } : {}),
    })
    this.setData({ needName: false, needPhone: false })
  },

  // The links above stay put while submitting: the result redirects the top page, which would be
  // the linked page instead of this one.

  async submit() {
    if (this.data.submitting) return
    const problem = this.problem()
    if (problem) {
      wx.showToast({ title: problem, icon: 'none' })
      return
    }
    this.setData({ submitting: true })
    // Going back now would leave a booking made out of sight, so WeChat asks first.
    wx.enableAlertBeforeUnload({ message: '正在预约，确定离开吗？' })
    try {
      // Asked first, while the tap still counts as the user's action for WeChat. WeChat asks for
      // three at most: news the student cannot see coming goes first (cancels and moves usually
      // share one 课程变动 template), then the package running out when paying with one, and the
      // confirmation of what they see on screen only when there is room.
      await askForNotices(this.data.noticeTemplates, [
        'reminder',
        'cancelled',
        'moved',
        'feedback',
        ...(this.data.payWith === 'package' ? (['package'] as const) : []),
        'booked',
      ])
      // Consent comes before the contact details, which the API refuses without it.
      if (this.data.showAgreement) {
        await agreePolicies()
        this.setData({ showAgreement: false })
      }
      await this.saveProfile()
      // Gone back before the booking was sent: nothing is booked.
      if (this.left) return
      const res = await api<CreateBookingResponse>('POST', '/bookings', {
        ...this.target(),
        lessonTypeId: this.data.lessonTypeId,
        payWith: this.data.payWith,
        // Refused if the price changed since the page loaded, rather than charging another one.
        ...(this.data.payWith === 'wechat' ? { expectedPrice: this.data.price } : {}),
        // Likewise if the package shown was used up and another would be used.
        ...(this.data.payWith === 'package' && this.data.pkg
          ? { expectedPackageId: this.data.pkg.id }
          : {}),
        // And if the venue changed the cancel or move rules meanwhile.
        ...(this.terms ? { expectedTerms: this.terms } : {}),
      })
      if (res.status === 'pending_payment' && res.orderId) {
        // A failed or cancelled payment still lands on the booking, which can be paid from there.
        // So does backing out while it was booking: no cashier over the page they went back to.
        const paid = await payOrder(res.orderId, this.data.price, res.payment, () => !this.left)
          .then((result) => result === 'paid')
          .catch((e) => {
            showError(e)
            return false
          })
        this.finish(res.bookingId, '', paid ? '预约成功' : '已预约，请尽快支付')
        return
      }
      this.finish(res.bookingId, res.existing ? '你已预约这节课' : '', '预约成功')
    } catch (e) {
      // Gone back while it was booking: nothing here to reload or ask about.
      if (this.left) return
      if (e instanceof ApiError && e.code === 'price_changed') {
        const { payWith } = this.data
        await this.load()
        // Reloading picks the package again when there is one; keep the student's choice.
        if (payWith === 'wechat' && this.data.perClassEnabled) this.setData({ payWith })
        if (this.data.state === 'ready') {
          await wx.showModal({
            title: '价格已变动',
            content: `现价 ${this.data.priceText}，请确认后再支付`,
            showCancel: false,
          })
        }
        return
      }
      if (e instanceof ApiError && e.code === 'terms_changed') {
        const { payWith } = this.data
        await getCatalog(true).catch(() => undefined)
        await this.load()
        if (payWith === 'wechat' && this.data.perClassEnabled) this.setData({ payWith })
        if (this.data.state === 'ready') {
          await wx.showModal({
            title: '预约规则已变动',
            content: `${this.data.cancelRule}\n请确认后再预约。`,
            showCancel: false,
          })
        }
        return
      }
      if (e instanceof ApiError && (e.code === 'no_package' || e.code === 'package_changed')) {
        // Used up at the front desk or expired since the page loaded: quote again without it.
        await this.load()
        if (this.data.state === 'ready') {
          await wx.showModal({
            title: this.data.pkg ? '课时包已变动' : '课时包不可用',
            content: this.data.pkg
              ? `将使用${this.data.pkg.name}，请确认后再预约`
              : this.data.perClassEnabled
                ? `课时包已用完或已过期，可改用微信支付 ${this.data.priceText}`
                : '课时包已用完或已过期，请先购买课时包',
            showCancel: false,
          })
        }
        return
      }
      if (e instanceof ApiError && SLOT_GONE.includes(e.code)) {
        // A coach or lesson turned off: the time picker reloads with the venue's current list.
        if (e.code === 'not_found' || e.code === 'coach_not_teaching') {
          await getCatalog(true).catch(() => undefined)
        }
        await wx.showModal({ title: e.message, content: '请选择其他时间', showCancel: false })
        if (isTop(this)) {
          const { lessonTypeId, coachId } = this.data
          backOr(`/pages/book/index?lessonTypeId=${lessonTypeId}&coachId=${coachId}`)
        }
        return
      }
      showError(e)
    } finally {
      wx.disableAlertBeforeUnload()
      this.setData({ submitting: false })
    }
  },

  /**
   * Replaces this page with the booking, so going back lands on the time picker. If the student
   * left while it was booking, the booking opens on top of where they are now, and `away` says
   * what became of it in a toast in case it cannot open there. A toast is shown after the
   * switch, which would otherwise swallow it.
   */
  finish(bookingId: number, toast: string, away: string) {
    wx.disableAlertBeforeUnload()
    const url = `/pages/booking-detail/index?id=${bookingId}`
    const success = () => {
      if (toast) wx.showToast({ title: toast, icon: 'none' })
    }
    if (isTop(this)) wx.redirectTo({ url, success })
    else if (this.left) {
      wx.navigateTo({
        url,
        success,
        fail: () => wx.showToast({ title: toast || away, icon: 'none', duration: 2500 }),
      })
    }
  },

  onUnload() {
    this.left = true
  },

  retry() {
    this.setData({ state: 'loading' })
    this.load()
  },
})
