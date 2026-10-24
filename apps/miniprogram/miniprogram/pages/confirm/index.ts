import type { BookingQuoteDto, CreateBookingResponse, MeDto, StudentDto } from '../../lib/shared'
import { ApiError, api, assetUrl, errorMessage, showError } from '../../utils/api'
import { agreePolicies, askForNotices, cancelRuleText, getCatalog, getMe } from '../../utils/data'
import { lessonTime, yuan } from '../../utils/format'
import { navigateOnce } from '../../utils/nav'
import { payOrder } from '../../utils/pay'

type PayWith = 'package' | 'wechat'

/** Booking errors that mean the slot is gone, so the student should pick another time. */
const SLOT_GONE = ['slot_taken', 'slot_closed', 'started', 'too_soon', 'too_far']

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
      // three at most: news the student cannot see coming goes first, and the confirmation of
      // what they see on screen only when a template for the others is missing.
      await askForNotices(this.data.noticeTemplates, ['reminder', 'cancelled', 'moved', 'booked'])
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
      })
      if (res.status === 'pending_payment' && res.orderId) {
        // A failed or cancelled payment still lands on the booking, which can be paid from there.
        await payOrder(res.orderId, this.data.price, res.payment).catch(showError)
        this.finish(res.bookingId)
        return
      }
      this.finish(res.bookingId)
    } catch (e) {
      if (e instanceof ApiError && SLOT_GONE.includes(e.code)) {
        await wx.showModal({ title: e.message, content: '请选择其他时间', showCancel: false })
        wx.navigateBack()
        return
      }
      showError(e)
    } finally {
      this.setData({ submitting: false })
    }
  },

  /** Replaces this page with the booking, so going back lands on the time picker. */
  finish(bookingId: number) {
    wx.redirectTo({ url: `/pages/booking-detail/index?id=${bookingId}` })
  },

  retry() {
    this.setData({ state: 'loading' })
    this.load()
  },
})
