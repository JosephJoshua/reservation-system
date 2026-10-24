import {
  type BookingQuoteDto,
  type CreateBookingResponse,
  type MeDto,
  minCheckHours,
  type StudentDto,
} from '../../lib/shared'
import { ApiError, api, assetUrl, errorMessage, showError } from '../../utils/api'
import { agreePolicies, askForNotices, cancelRuleText, getCatalog, getMe } from '../../utils/data'
import { lessonTime, yuan } from '../../utils/format'
import { isTop, navigateOnce } from '../../utils/nav'
import { payOrder } from '../../utils/pay'

type PayWith = 'package' | 'wechat'

/**
 * Booking errors that mean this time cannot be booked any more, so the student should pick another:
 * taken, closed, deleted, too close, or its coach or lesson no longer offered.
 */
const SLOT_GONE = [
  'slot_taken',
  'tables_full',
  'slot_closed',
  'started',
  'too_soon',
  'too_far',
  'not_found',
  'coach_not_teaching',
]

Page({
  data: {
    state: 'loading' as 'loading' | 'ready' | 'error',
    error: '',
    errorIcon: { name: 'error-circle', size: '112rpx' },
    slotId: 0,
    lessonTypeId: 0,
    coachId: 0,
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

  onLoad(query: Record<string, string | undefined>) {
    this.setData({
      slotId: Number(query.slotId),
      lessonTypeId: Number(query.lessonTypeId),
      coachId: Number(query.coachId),
      when: lessonTime(
        decodeURIComponent(query.startsAt ?? ''),
        decodeURIComponent(query.endsAt ?? ''),
      ),
    })
    this.load()
  },

  async load() {
    try {
      const { slotId, lessonTypeId } = this.data
      const [catalog, quote, me] = await Promise.all([
        getCatalog(),
        // The API says which package it will use and what it will charge.
        api<BookingQuoteDto>(
          'GET',
          `/bookings/quote?slotId=${slotId}&lessonTypeId=${lessonTypeId}`,
        ),
        getMe(),
      ])
      const lessonType = catalog.lessonTypes.find((t) => t.id === lessonTypeId)
      const coach = catalog.coaches.find((c) => c.id === this.data.coachId)
      if (!lessonType || !coach) {
        this.setData({ state: 'error', error: '该课程暂不可预约' })
        return
      }
      const { price, package: pkg, perClassEnabled } = quote
      this.setData({
        state: 'ready',
        lessonName: lessonType.name,
        isTrial: lessonType.isTrial,
        duration: lessonType.durationMinutes,
        groupNote:
          lessonType.capacity > 1
            ? `小班课，多人同上${
                lessonType.minStudents
                  ? `；课前 ${minCheckHours(catalog.booking)} 小时报名不足 ${lessonType.minStudents} 人将自动取消，退款或退回课时`
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
        cancelRule: cancelRuleText(catalog.booking.cancelDeadlineHours, catalog.booking.lateCancel),
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
      const res = await api<CreateBookingResponse>('POST', '/bookings', {
        slotId: this.data.slotId,
        lessonTypeId: this.data.lessonTypeId,
        payWith: this.data.payWith,
        // Refused if the price changed since the page loaded, rather than charging another one.
        ...(this.data.payWith === 'wechat' ? { expectedPrice: this.data.price } : {}),
      })
      if (res.status === 'pending_payment' && res.orderId) {
        // A failed or cancelled payment still lands on the booking, which can be paid from there.
        await payOrder(res.orderId, this.data.price, res.payment).catch(showError)
        this.finish(res.bookingId)
        return
      }
      this.finish(res.bookingId, res.existing ? '你已预约这节课' : '')
    } catch (e) {
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
      if (e instanceof ApiError && e.code === 'no_package') {
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
        if (isTop(this)) wx.navigateBack()
        return
      }
      showError(e)
    } finally {
      this.setData({ submitting: false })
    }
  },

  /**
   * Replaces this page with the booking, so going back lands on the time picker. If the student
   * left while it was booking, the booking opens on top of where they are now. A toast is shown
   * after the switch, which would otherwise swallow it.
   */
  finish(bookingId: number, toast = '') {
    const url = `/pages/booking-detail/index?id=${bookingId}`
    const success = () => {
      if (toast) wx.showToast({ title: toast, icon: 'none' })
    }
    if (isTop(this)) wx.redirectTo({ url, success })
    else if (this.left) wx.navigateTo({ url, success })
  },

  onUnload() {
    this.left = true
  },

  retry() {
    this.setData({ state: 'loading' })
    this.load()
  },
})
