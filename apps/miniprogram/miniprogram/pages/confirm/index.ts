import {
  type BookingQuoteDto,
  type BookingTerms,
  bookingTerms,
  type CreateBookingResponse,
  type MeDto,
  minCheckHours,
  type StudentDto,
} from '../../lib/shared'
import {
  ApiError,
  api,
  assetUrl,
  errorMessage,
  RESULT_UNKNOWN,
  serverNow,
  showError,
} from '../../utils/api'
import {
  agreementFor,
  agreePolicies,
  askForNotices,
  askToAgree,
  cancelRuleText,
  getCatalog,
  getMe,
  lateBookingText,
  needsAgreement,
  TRIAL_PENDING,
  trialBlock,
} from '../../utils/data'
import { lessonTime, yuan } from '../../utils/format'
import { backOr, isTop, navigateOnce, openUpcomingLessons } from '../../utils/nav'
import { PAY_PENDING, PAY_REFUNDED, PAY_UNCLEAR, payOrder } from '../../utils/pay'

type PayWith = 'package' | 'wechat'

/** When the booking's result is not known yet: the lessons list shows it if it was made. */
const CHECK_LESSONS = '请在“课程”中查看是否已预约成功'

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
    /** Booked inside the free-cancel window: what a cancel would then lose. */
    lateNote: '',
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
  /** The version of the policies the agreement row offers. */
  policyVersion: '',
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

  /** Opened with a lesson and a time to book: a session, or a coach and a start time. */
  complete(): boolean {
    const { slotId, lessonTypeId, coachId, startsAt } = this.data
    return lessonTypeId > 0 && coachId > 0 && (slotId > 0 || !Number.isNaN(Date.parse(startsAt)))
  },

  /** The page shows a lesson that can be booked, and a way to pay for it. */
  bookable(): boolean {
    return (
      this.data.state === 'ready' &&
      this.complete() &&
      (!!this.data.pkg || this.data.perClassEnabled)
    )
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
    const payWith: PayWith = usePackage ? 'package' : 'wechat'
    const switched = payWith !== this.data.payWith
    this.setData({
      price: price.price,
      priceText: yuan(price.price),
      originalText: price.originalPrice == null ? '' : yuan(price.originalPrice),
      pkg: pkg ? { id: pkg.id, name: pkg.name, remaining: pkg.lessonsRemaining } : null,
      perClassEnabled,
      payWith,
    })
    // Said out loud, so the way to pay never changes unseen.
    if (switched && perClassEnabled) {
      wx.showToast({
        title: payWith === 'package' ? '已改用课时包支付' : '课时包不可用，已改用微信支付',
        icon: 'none',
      })
    }
  },

  async load() {
    // A quote still on its way would show over this one.
    this.quotes++
    if (!this.complete()) {
      this.setData({ state: 'error', error: '这门课程暂时不能预约' })
      return
    }
    try {
      const { lessonTypeId } = this.data
      const [catalog, quote, me] = await Promise.all([getCatalog(), this.quote(), getMe()])
      const version = await agreementFor(me)
      this.policyVersion = version ?? ''
      const lessonType = catalog.lessonTypes.find((t) => t.id === lessonTypeId)
      const coach = catalog.coaches.find((c) => c.id === this.data.coachId)
      if (!lessonType || !coach) {
        this.setData({ state: 'error', error: '这门课程暂时不能预约' })
        return
      }
      const blocked = lessonType.isTrial ? trialBlock(catalog) : ''
      if (blocked) {
        this.setData({ state: 'error', error: blocked })
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
        lateNote: lateBookingText(
          this.data.startsAt,
          lessonType.rules.cancelDeadlineHours,
          lessonType.rules.lateCancel,
          serverNow(),
        ),
        needName: !me.name,
        needPhone: !me.phone,
        hasBookingPolicy: Boolean(catalog.policies.booking),
        showAgreement: version !== null,
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
    if (this.data.submitting || !this.bookable()) return
    const problem = this.problem()
    if (problem) {
      wx.showToast({ title: problem, icon: 'none' })
      return
    }
    this.setData({ submitting: true })
    // No native "leave?" guard while booking: its dialog can outlive the request and, confirmed
    // over 预约详情, would leave that page instead. Going back is safe as it is: before the booking
    // is sent nothing is booked, and once it is, finish() opens it over where the student went.
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
        await agreePolicies(this.policyVersion)
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
      // The 体验课 just taken counts against the allowance the other pages show.
      if (this.data.isTrial) getCatalog(true).catch(() => undefined)
      if (res.status === 'pending_payment' && res.orderId) {
        // A failed or cancelled payment still lands on the booking, which can be paid from there.
        // So does backing out while it was booking: no cashier over the page they went back to.
        // Why the cashier failed, said on the booking: a toast here would go with this page.
        let failure = ''
        const result = await payOrder(
          res.orderId,
          this.data.price,
          res.payment,
          () => !this.left,
        ).catch((e) => {
          failure = errorMessage(e)
          return 'failed' as const
        })
        // A paid 体验课 is no longer one to pay on the other pages.
        if (this.data.isTrial) getCatalog(true).catch(() => undefined)
        // Paid but not confirmed yet: say so, so the booking's 待支付 does not invite paying again.
        if (result === 'pending') {
          this.finish(res.bookingId, PAY_PENDING, PAY_PENDING)
          return
        }
        // Paid at the cashier on an order the server closed: never invite paying again.
        if (result === 'unclear') {
          this.finish(res.bookingId, PAY_UNCLEAR, PAY_UNCLEAR)
          return
        }
        // Paid, but the venue stopped the lesson meanwhile: the server refunds it.
        if (result === 'refunded') {
          this.finish(res.bookingId, PAY_REFUNDED, PAY_REFUNDED)
          return
        }
        this.finish(
          res.bookingId,
          failure,
          failure || (result === 'paid' ? '预约成功' : '已预约，请尽快支付'),
        )
        return
      }
      this.finish(res.bookingId, res.existing ? '你已预约这节课' : '', '预约成功')
    } catch (e) {
      const unknown =
        e instanceof ApiError && (e.code === 'in_progress' || e.code === RESULT_UNKNOWN)
      // Gone back while it was booking: nothing here to reload or ask about, but a booking that
      // may have been made is worth a word, over wherever they are now.
      if (this.left) {
        if (unknown) wx.showToast({ title: CHECK_LESSONS, icon: 'none', duration: 3000 })
        return
      }
      if (needsAgreement(e)) {
        this.setData({ showAgreement: true, agreed: false })
        this.policyVersion = (await askToAgree(true)) ?? this.policyVersion
        return
      }
      if (e instanceof ApiError && e.code === 'already_booked' && e.bookingId) {
        // Booked this session already, on other terms (unpaid at the old price, say): that
        // booking is where to pay or cancel it.
        this.finish(e.bookingId, e.message, e.message)
        return
      }
      if (e instanceof ApiError && e.code === 'trial_used') {
        // Taken meanwhile, on another phone or at the front desk: the pages stop offering it.
        // A trial still to pay is said as such: it is paid from 课程.
        const fresh = await getCatalog(true).catch(() => null)
        const pending = fresh !== null && trialBlock(fresh) === TRIAL_PENDING
        await wx.showModal({
          title: pending ? TRIAL_PENDING : e.message,
          content: pending ? '请在“课程”中支付或取消' : '可以预约其他课程',
          showCancel: false,
        })
        if (isTop(this)) backOr('/pages/booking/index')
        return
      }
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
      if (unknown) {
        // The booking may have been made: the lessons list shows it if so.
        await wx.showModal({
          title: '预约结果确认中',
          content: `${CHECK_LESSONS}，未成功可重新预约。`,
          showCancel: false,
        })
        if (isTop(this)) openUpcomingLessons()
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
      this.setData({ submitting: false })
    }
  },

  /**
   * Replaces this page with the booking, so going back lands on the time picker. If the student
   * left while it was booking, the booking opens on top of where they are now, and `away` says
   * what became of it in a toast, since they did not see it happen. A toast is shown after the
   * switch, which would otherwise swallow it.
   */
  finish(bookingId: number, toast: string, away: string) {
    // Once: the booking opens, and its toast shows, a single time however the page got here.
    if (this.finished) return
    const url = `/pages/booking-detail/index?id=${bookingId}`
    let said = false
    const say = (title: string) => {
      if (said || !title) return
      said = true
      wx.showToast({ title, icon: 'none', duration: 2500 })
    }
    if (isTop(this)) {
      this.finished = true
      wx.redirectTo({ url, success: () => say(toast) })
    } else if (this.left) {
      this.finished = true
      wx.navigateTo({ url, complete: () => say(toast || away) })
    }
  },

  onUnload() {
    this.left = true
  },

  /** Set once the booking has been opened, so it is not opened again. */
  finished: false,

  retry() {
    this.setData({ state: 'loading' })
    this.load()
  },
})
