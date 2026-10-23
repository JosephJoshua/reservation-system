import type { CreateBookingResponse, PackageDto, PriceTag, StudentDto } from '../../lib/shared'
import { ApiError, api, assetUrl, errorMessage, showError } from '../../utils/api'
import {
  cancelRuleText,
  getCatalog,
  getMe,
  hasAgreed,
  setAgreed,
  usablePackage,
} from '../../utils/data'
import { lessonTime, yuan } from '../../utils/format'
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
    hasPolicies: false,
    showAgreement: false,
    agreed: false,
    submitting: false,
  },

  startsAt: '',

  onLoad(query: Record<string, string | undefined>) {
    this.startsAt = decodeURIComponent(query.startsAt ?? '')
    this.setData({
      slotId: Number(query.slotId),
      lessonTypeId: Number(query.lessonTypeId),
      coachId: Number(query.coachId),
      when: lessonTime(this.startsAt, decodeURIComponent(query.endsAt ?? '')),
    })
    this.load()
  },

  async load() {
    try {
      const [catalog, packages, me] = await Promise.all([
        getCatalog(),
        api<PackageDto[]>('GET', '/packages'),
        getMe(),
      ])
      const lessonType = catalog.lessonTypes.find((t) => t.id === this.data.lessonTypeId)
      const coach = catalog.coaches.find((c) => c.id === this.data.coachId)
      const price: PriceTag | undefined = coach?.lessons.find(
        (l) => l.lessonTypeId === this.data.lessonTypeId,
      )?.price
      if (!lessonType || !coach || !price) {
        this.setData({ state: 'error', error: '该课程暂不可预约' })
        return
      }
      const pkg = lessonType.isTrial
        ? null
        : usablePackage(packages, lessonType.id, coach.id, this.startsAt)
      const perClassEnabled = lessonType.isTrial || catalog.payment.perClassEnabled
      const hasPolicies = Boolean(catalog.policies.booking || catalog.policies.agreement)
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
        hasPolicies,
        showAgreement: hasPolicies && !hasAgreed(),
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

  toggleAgree() {
    this.setData({ agreed: !this.data.agreed })
  },

  openPolicy(e: WechatMiniprogram.TouchEvent) {
    wx.navigateTo({ url: `/pages/policy/index?kind=${e.currentTarget.dataset.kind}` })
  },

  openPackages() {
    wx.navigateTo({ url: `/pages/packages/index?lessonTypeId=${this.data.lessonTypeId}` })
  },

  /** The first problem on the page, checked top to bottom, or '' when there is none. */
  problem(): string {
    const { needName, needPhone, showAgreement, agreed } = this.data
    if (needName && !this.data.name.trim()) return '请填写姓名'
    if (needPhone && !/^1\d{10}$/.test(this.data.phone.trim())) return '请填写正确的手机号'
    if (showAgreement && !agreed) return '请先阅读并同意相关条款'
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

  async submit() {
    if (this.data.submitting) return
    const problem = this.problem()
    if (problem) {
      wx.showToast({ title: problem, icon: 'none' })
      return
    }
    this.setData({ submitting: true })
    try {
      await this.saveProfile()
      if (this.data.showAgreement) setAgreed()
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
