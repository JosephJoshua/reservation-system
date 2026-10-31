import {
  type BookingDto,
  COACH_CANCEL_PREFIX,
  cancellationOutcome,
  DISRUPTION_TEXT,
  type HomeDto,
} from '../../lib/shared'
import {
  ApiError,
  api,
  assetUrl,
  errorMessage,
  publicApi,
  serverNow,
  showError,
} from '../../utils/api'
import { addLessonToCalendar } from '../../utils/calendar'
import { scanToCheckIn } from '../../utils/check-in'
import { cancelRuleText, getCatalog } from '../../utils/data'
import { dateTime, lessonTime, yuan } from '../../utils/format'
import { INVOICE_STATE, invoiceAction, openInvoice } from '../../utils/invoice'
import { refundBack, refundStatus, settled } from '../../utils/labels'
import { navigateOnce } from '../../utils/nav'
import { PAY_PENDING, PAY_REFUNDED, PAY_UNCLEAR, payOrder } from '../../utils/pay'
import { previewPhotos } from '../../utils/photos'
import { ask, openOnce } from '../../utils/tap'
import { modalDangerColor } from '../../utils/theme'

const STATUS: Record<BookingDto['status'], { title: string; icon: string; tone: string }> = {
  pending_payment: { title: '待支付', icon: 'time-filled', tone: 'hint' },
  confirmed: { title: '预约成功', icon: 'check-circle-filled', tone: 'brand' },
  completed: { title: '已完成', icon: 'check-circle-filled', tone: 'muted' },
  cancelled: { title: '已取消', icon: 'close-circle-filled', tone: 'muted' },
  expired: { title: '已失效', icon: 'close-circle-filled', tone: 'muted' },
}

/** A booked lesson the venue cannot give as booked: not to be travelled to. */
const DISRUPTED = { title: '课程有变', icon: 'error-circle-filled', tone: 'hint' }

/** Whether the student is told to come for it: booked, and nothing in the way. */
function onAsBooked(b: BookingDto): boolean {
  return b.status === 'confirmed' && !b.disruption
}

function subtitle(b: BookingDto, now: number): string {
  switch (b.status) {
    case 'pending_payment': {
      // Payment is refused for a lesson the venue cannot give; only cancelling is left.
      if (b.disruption) return `${DISRUPTION_TEXT[b.disruption]}，请取消后重新预约`
      const left = b.payBy ? Math.max(0, Date.parse(b.payBy) - now) : 0
      const mm = String(Math.floor(left / 60000)).padStart(2, '0')
      const ss = String(Math.floor((left % 60000) / 1000)).padStart(2, '0')
      return left > 0 ? `请在 ${mm}:${ss} 内完成支付，超时将自动取消` : '支付已超时'
    }
    case 'confirmed':
      // Paid or on a package, but the venue cannot give it: the student should not come. Once it
      // has started it can no longer be cancelled here.
      if (b.disruption) {
        const next = !b.canCancel
          ? '如有疑问请联系前台'
          : b.canMove
            ? '请取消或改约'
            : '请取消后重新预约'
        return `${DISRUPTION_TEXT[b.disruption]}，${next}`
      }
      return '请按时到场上课'
    case 'completed':
      // Counted like an attended lesson: no refund and the package lesson is used.
      return b.attendance === 'no_show' ? '缺席，照常计课' : '课程已结束'
    case 'cancelled':
      return b.cancelledBy === 'venue'
        ? b.cancelReason
          ? b.cancelReason.startsWith(COACH_CANCEL_PREFIX)
            ? `教练已取消：${b.cancelReason.slice(COACH_CANCEL_PREFIX.length)}`
            : `场馆已取消：${b.cancelReason}`
          : '场馆已取消本节课'
        : b.late
          ? '已过免费取消时间'
          : '你已取消本节课'
    case 'expired': {
      if (b.paymentIssue === 'open') return '付款异常，场馆会联系你处理'
      if (b.paymentIssue === 'handled') return '付款异常，场馆已处理'
      // Paid, but the lesson could not be confirmed (stopped by the venue, or the time was taken
      // after the hold ran out): the server refunded it, and says why as recorded then.
      if (b.refund)
        return `${b.expiredWhy || '这节课无法上课'}，${refundBack(b.refund, b.paidOffline)}`
      // Unpaid: what stands in the way of the lesson while it is still ahead.
      return b.disruption ? `${DISRUPTION_TEXT[b.disruption]}，预约已失效` : '未在规定时间内支付'
    }
  }
}

Page({
  data: {
    state: 'loading' as 'loading' | 'ready' | 'error',
    error: '',
    errorIcon: { name: 'error-circle', size: '112rpx' },
    booking: null as BookingDto | null,
    statusTitle: '',
    statusIcon: '',
    statusTone: '',
    statusText: '',
    when: '',
    movedFrom: '',
    payment: '',
    deadline: '',
    refund: '',
    invoice: '',
    invoiceTappable: false,
    attendance: '',
    address: '',
    canAddToCalendar: false,
    cancelRule: '',
    feedback: null as { title: string; text: string; photos: string[] } | null,
    busy: false,
  },

  id: 0,
  /** Set once the student has gone back from this page. */
  left: false,
  cancelChecking: false,
  /** Bumped by every `show`, so a fetch that a newer answer overtook is dropped. */
  shown: 0,
  timer: 0 as number,
  venue: null as HomeDto['venue'] | null,

  onLoad(query: Record<string, string | undefined>) {
    this.id = Number(query.id)
    this.load()
  },

  onShow() {
    // Back from the background or another page: the lesson may have been paid, cancelled or
    // moved meanwhile, here or on another phone.
    if (this.data.state === 'ready' && !this.data.busy) this.refresh()
    else if (this.data.booking?.status === 'pending_payment') this.startTimer()
  },

  onHide() {
    this.stopTimer()
  },

  onUnload() {
    this.left = true
    this.stopTimer()
  },

  onPullDownRefresh() {
    this.refresh(true).finally(() => wx.stopPullDownRefresh())
  },

  async load() {
    const shown = this.shown
    try {
      const [booking, home] = await Promise.all([
        api<BookingDto>('GET', `/bookings/${this.id}`),
        publicApi<HomeDto>('GET', '/home'),
      ])
      this.venue = home.venue
      if (shown !== this.shown) return
      this.show(booking)
    } catch (e) {
      if (shown !== this.shown) return
      this.setData({ state: 'error', error: errorMessage(e) })
    }
  },

  /**
   * Fetches the booking shown again. A failure keeps it on screen, said out loud when `loud`,
   * unless the booking is gone.
   */
  async refresh(loud = false): Promise<boolean> {
    if (!this.data.booking) {
      await this.load()
      return this.data.state === 'ready'
    }
    const shown = this.shown
    try {
      const booking = await api<BookingDto>('GET', `/bookings/${this.id}`)
      // A newer answer is on screen already.
      if (shown === this.shown) this.show(booking)
      return true
    } catch (e) {
      if (shown !== this.shown) return true
      if (e instanceof ApiError && e.status === 404) {
        this.setData({ state: 'error', error: errorMessage(e) })
        return false
      }
      if (loud) showError(e)
      if (this.data.booking?.status === 'pending_payment') this.startTimer()
      return false
    }
  },

  show(fetched: BookingDto) {
    this.shown++
    const b = settled(fetched, serverNow())
    // An unpaid one too: it can no longer be paid, only cancelled.
    const status =
      (b.status === 'confirmed' || b.status === 'pending_payment') && b.disruption
        ? DISRUPTED
        : STATUS[b.status]
    this.setData({
      state: 'ready',
      booking: b,
      statusTitle: status.title,
      statusIcon: status.icon,
      statusTone: status.tone,
      statusText: subtitle(b, serverNow()),
      when: lessonTime(b.startsAt, b.endsAt),
      movedFrom: b.movedFrom ? dateTime(b.movedFrom) : '',
      payment:
        b.paidWith === 'package'
          ? `课时包 · ${b.packageName ?? ''}`
          : b.price > 0
            ? `${b.paidOffline ? '前台付款' : '微信支付'} · ${yuan(b.price)}`
            : '免费',
      deadline: `${dateTime(b.cancelDeadline)}${Date.parse(b.cancelDeadline) <= serverNow() ? '（已过）' : ''}`,
      refund: b.refund ? `${yuan(b.refund.amount)} · ${refundStatus(b.refund, b.paidOffline)}` : '',
      // A refunded lesson has nothing to invoice, and the 退款 row already says so.
      invoice:
        b.invoice &&
        !(b.refund && (b.invoice.state === 'refunded' || b.invoice.state === 'refunding'))
          ? invoiceAction(b.invoice) === 'request'
            ? b.invoice.state === 'rejected'
              ? '未通过，重新申请'
              : '申请开票'
            : invoiceAction(b.invoice) === 'view'
              ? '查看发票'
              : INVOICE_STATE[b.invoice.state]
          : '',
      invoiceTappable: !!invoiceAction(b.invoice),
      // Nothing to check in to while the venue cannot give the lesson.
      attendance: b.canCheckIn
        ? b.disruption
          ? ''
          : '扫码签到'
        : b.attendance === 'attended'
          ? '已签到'
          : b.attendance === 'no_show'
            ? '缺席'
            : '',
      address: this.venue?.address ?? '',
      canAddToCalendar: onAsBooked(b) && Date.parse(b.startsAt) > serverNow(),
      cancelRule:
        // The venue cannot give it as booked, or moved it after the usual deadline: free until
        // it starts.
        (b.disruption
          ? `${DISRUPTION_TEXT[b.disruption]}，开课前可免费取消。`
          : b.movedLate
            ? '课程时间已调整，开课前可免费取消。'
            : cancelRuleText(b.terms.cancelDeadlineHours, b.terms.lateCancel)) +
        (b.canMove
          ? // Moving closes with free cancelling, which for such a lesson is when it starts.
            Date.parse(b.cancelDeadline) >= Date.parse(b.startsAt)
            ? `开课前还可以改约 ${b.movesLeft} 次。`
            : `在免费取消截止前，还可以改约 ${b.movesLeft} 次。`
          : b.status === 'confirmed' && b.movedFrom && b.movesLeft === 0
            ? '改约次数已用完。'
            : ''),
      feedback: b.feedback
        ? {
            title: `${b.coach.name}的课后点评`,
            text: b.feedback.text,
            photos: b.feedback.photos.map(assetUrl),
          }
        : null,
    })
    if (b.status === 'pending_payment') this.startTimer()
    else this.stopTimer()
  },

  startTimer() {
    this.stopTimer()
    this.timer = setInterval(() => {
      const b = this.data.booking
      if (b?.status !== 'pending_payment') return this.stopTimer()
      if (b.payBy && Date.parse(b.payBy) <= serverNow()) return this.show(b)
      // No countdown for one that can no longer be paid; it still shows as lapsed at payBy.
      if (!b.disruption) this.setData({ statusText: subtitle(b, serverNow()) })
    }, 1000) as unknown as number
  },

  stopTimer() {
    if (this.timer) clearInterval(this.timer)
    this.timer = 0
  },

  async pay() {
    const b = this.data.booking
    if (!b?.orderId || this.data.busy) return
    this.setData({ busy: true })
    try {
      const result = await payOrder(b.orderId, b.price, null, () => !this.left)
      // A paid 体验课 is no longer one to pay on the other pages.
      if (b.lessonType.isTrial) getCatalog(true).catch(() => undefined)
      if (this.left) return
      await this.refresh()
      if (result === 'pending' && this.data.booking?.status === 'pending_payment') {
        wx.showToast({ title: PAY_PENDING, icon: 'none', duration: 2500 })
      } else if (result === 'unclear') {
        wx.showToast({ title: PAY_UNCLEAR, icon: 'none', duration: 2500 })
      } else if (result === 'refunded') {
        wx.showToast({ title: PAY_REFUNDED, icon: 'none', duration: 2500 })
      }
    } catch (e) {
      if (this.left) return
      showError(e)
      await this.refresh()
    } finally {
      this.setData({ busy: false })
    }
  },

  /**
   * Spells out what cancelling now costs before asking, and whether that is a late cancel. The
   * server refuses a late cancel the student did not see coming.
   */
  cancelQuote(b: BookingDto): { message: string; late: boolean } {
    if (b.status === 'pending_payment') {
      return { message: '取消后，这个时段会释放给其他学员。', late: false }
    }
    const outcome = cancellationOutcome({
      startsAt: new Date(b.startsAt),
      endsAt: new Date(b.endsAt),
      now: new Date(serverNow()),
      cancelledBy: 'student',
      paidWith: b.paidWith,
      amountPaid: b.price,
      // The cancel rules it was booked under.
      rules: b.terms,
      deadline: new Date(b.cancelDeadline),
    })
    if (typeof outcome === 'string') return { message: '课程已开始，无法取消。', late: false }
    const { late } = outcome
    if (b.paidWith === 'package') {
      return {
        late,
        message: outcome.returnLesson
          ? '取消后课时将退回课时包。'
          : '已过免费取消时间，取消后这节课的课时不会退回。',
      }
    }
    if (b.price === 0) return { message: '确定取消这节课吗？', late }
    // Paid at the front desk, so the money is handed back there.
    const back = b.paidOffline ? '到店退还' : '将原路退回'
    if (!late) return { message: `取消后 ${yuan(outcome.refund)} ${back}。`, late }
    return {
      late,
      message:
        outcome.refund > 0
          ? `已过免费取消时间，取消后 ${yuan(outcome.refund)} ${back}。`
          : '已过免费取消时间，取消后不退款。',
    }
  },

  async cancel() {
    if (!this.data.booking || this.data.busy || this.cancelChecking) return
    // Cancelled or changed on another phone since this page loaded: show that, not a refund
    // that will not happen. The modal is asked right after, which keeps it inside the tap.
    this.cancelChecking = true
    let fresh = false
    try {
      fresh = await this.refresh(true)
    } finally {
      this.cancelChecking = false
    }
    const b = this.data.booking
    if (!fresh) return
    if (!b?.canCancel || this.data.busy) return
    const quote = this.cancelQuote(b)
    const answer = await ask({
      title: '取消预约',
      content: quote.message,
      confirmText: '确认取消',
      confirmColor: modalDangerColor(),
      cancelText: '再想想',
    })
    if (!answer?.confirm || this.data.busy) return
    this.setData({ busy: true })
    try {
      const updated = await api<BookingDto>('POST', `/bookings/${b.id}/cancel`, {
        acceptLate: quote.late,
      })
      // An early cancel gives the 体验课 back, which the other pages offer again.
      if (updated.lessonType.isTrial) getCatalog(true).catch(() => undefined)
      this.show(updated)
    } catch (e) {
      showError(e)
      await this.refresh()
    } finally {
      this.setData({ busy: false })
    }
  },

  async checkIn() {
    const b = this.data.booking
    if (!b?.canCheckIn || b.disruption) return
    if (await scanToCheckIn()) await this.refresh()
  },

  openInvoice() {
    openInvoice(this.data.booking?.invoice ?? null)
  },

  move() {
    const b = this.data.booking
    if (!b?.canMove || this.data.busy) return
    navigateOnce(`/pages/move/index?id=${b.id}`, {
      moved: (updated: BookingDto) => this.show(updated),
      // The move was refused because the lesson changed: show it as it is now.
      stale: () => this.refresh(),
    })
  },

  addToCalendar() {
    const b = this.data.booking
    if (!b || !onAsBooked(b)) return
    // The page may have stayed open until the lesson began.
    if (Date.parse(b.startsAt) <= serverNow()) {
      this.setData({ canAddToCalendar: false })
      wx.showToast({ title: '课程已开始', icon: 'none' })
      return
    }
    addLessonToCalendar(b, this.venue)
  },

  previewPhoto(e: WechatMiniprogram.TouchEvent) {
    previewPhotos(this.data.feedback?.photos ?? [], e.currentTarget.dataset.index)
  },

  rebook() {
    const b = this.data.booking
    if (!b) return
    navigateOnce(`/pages/book/index?lessonTypeId=${b.lessonType.id}&coachId=${b.coach.id}`)
  },

  openMap() {
    const venue = this.venue
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

  retry() {
    this.setData({ state: 'loading' })
    this.load()
  },
})
