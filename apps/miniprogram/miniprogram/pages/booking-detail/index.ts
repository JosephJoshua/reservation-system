import {
  type BookingDto,
  type CatalogDto,
  cancellationOutcome,
  type HomeDto,
} from '../../lib/shared'
import { api, assetUrl, errorMessage, publicApi, showError } from '../../utils/api'
import { addLessonToCalendar } from '../../utils/calendar'
import { cancelRuleText, getCatalog } from '../../utils/data'
import { dateTime, lessonTime, yuan } from '../../utils/format'
import { INVOICE_STATE, invoiceAction, openInvoice } from '../../utils/invoice'
import { refundStatus } from '../../utils/labels'
import { navigateOnce } from '../../utils/nav'
import { payOrder } from '../../utils/pay'
import { previewPhotos } from '../../utils/photos'
import { ask } from '../../utils/tap'
import { modalDangerColor } from '../../utils/theme'

const STATUS: Record<BookingDto['status'], { title: string; icon: string; tone: string }> = {
  pending_payment: { title: '待支付', icon: 'time-filled', tone: 'hint' },
  confirmed: { title: '预约成功', icon: 'check-circle-filled', tone: 'brand' },
  completed: { title: '已完成', icon: 'check-circle-filled', tone: 'muted' },
  cancelled: { title: '已取消', icon: 'close-circle-filled', tone: 'muted' },
  expired: { title: '已失效', icon: 'close-circle-filled', tone: 'muted' },
}

function subtitle(b: BookingDto, now: number): string {
  switch (b.status) {
    case 'pending_payment': {
      const left = b.payBy ? Math.max(0, Date.parse(b.payBy) - now) : 0
      const mm = String(Math.floor(left / 60000)).padStart(2, '0')
      const ss = String(Math.floor((left % 60000) / 1000)).padStart(2, '0')
      return left > 0 ? `请在 ${mm}:${ss} 内完成支付，超时将自动取消` : '支付已超时'
    }
    case 'confirmed':
      return '请按时到场上课'
    case 'completed':
      return '课程已结束'
    case 'cancelled':
      return b.cancelledBy === 'venue'
        ? '场馆已取消本节课'
        : b.late
          ? '已过免费取消时间'
          : '你已取消本节课'
    case 'expired':
      return '未在规定时间内支付'
  }
}

/** The server sweeps unpaid holds a little after payBy; show them as expired from payBy on. */
function settled(b: BookingDto, now: number): BookingDto {
  return b.status === 'pending_payment' && b.payBy && Date.parse(b.payBy) <= now
    ? { ...b, status: 'expired', canCancel: false }
    : b
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
    address: '',
    canAddToCalendar: false,
    cancelRule: '',
    feedback: null as { title: string; text: string; photos: string[] } | null,
    busy: false,
  },

  id: 0,
  timer: 0 as number,
  catalog: null as CatalogDto | null,
  venue: null as HomeDto['venue'] | null,

  onLoad(query: Record<string, string | undefined>) {
    this.id = Number(query.id)
    this.load()
  },

  onShow() {
    if (this.data.booking?.status === 'pending_payment') this.startTimer()
  },

  onHide() {
    this.stopTimer()
  },

  onUnload() {
    this.stopTimer()
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh())
  },

  async load() {
    try {
      const [booking, catalog, home] = await Promise.all([
        api<BookingDto>('GET', `/bookings/${this.id}`),
        getCatalog(),
        publicApi<HomeDto>('GET', '/home'),
      ])
      this.catalog = catalog
      this.venue = home.venue
      this.show(booking)
    } catch (e) {
      this.setData({ state: 'error', error: errorMessage(e) })
    }
  },

  show(fetched: BookingDto) {
    const b = settled(fetched, Date.now())
    const status = STATUS[b.status]
    const { booking } = this.catalog ?? { booking: null }
    this.setData({
      state: 'ready',
      booking: b,
      statusTitle: status.title,
      statusIcon: status.icon,
      statusTone: status.tone,
      statusText: subtitle(b, Date.now()),
      when: lessonTime(b.startsAt, b.endsAt),
      movedFrom: b.movedFrom ? dateTime(b.movedFrom) : '',
      payment:
        b.paidWith === 'package'
          ? `课时包 · ${b.packageName ?? ''}`
          : b.price > 0
            ? `${b.paidOffline ? '前台付款' : '微信支付'} · ${yuan(b.price)}`
            : '免费',
      deadline: `${dateTime(b.cancelDeadline)}${Date.parse(b.cancelDeadline) <= Date.now() ? '（已过）' : ''}`,
      refund: b.refund
        ? `${yuan(b.refund.amount)} · ${refundStatus(b.refund.status, b.paidOffline)}`
        : '',
      invoice: b.invoice
        ? invoiceAction(b.invoice) === 'request'
          ? b.invoice.state === 'rejected'
            ? '未通过，重新申请'
            : '申请开票'
          : invoiceAction(b.invoice) === 'view'
            ? '查看发票'
            : INVOICE_STATE[b.invoice.state]
        : '',
      invoiceTappable: !!invoiceAction(b.invoice),
      address: this.venue?.address ?? '',
      canAddToCalendar: b.status === 'confirmed' && Date.parse(b.startsAt) > Date.now(),
      cancelRule: booking
        ? // Moved by the venue or coach after the usual deadline: free until it starts.
          (b.movedLate
            ? '课程时间已调整，开课前可免费取消。'
            : cancelRuleText(booking.cancelDeadlineHours, booking.lateCancel)) +
          (b.canMove ? `免费取消截止前可改约 ${b.movesLeft} 次。` : '')
        : '',
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
      if (b.payBy && Date.parse(b.payBy) <= Date.now()) return this.show(b)
      this.setData({ statusText: subtitle(b, Date.now()) })
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
      await payOrder(b.orderId, b.price)
      await this.load()
    } catch (e) {
      showError(e)
      await this.load()
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
      return { message: '取消后该时段将释放给其他学员。', late: false }
    }
    const rules = this.catalog?.booking
    if (!rules) return { message: '确定取消这节课吗？', late: false }
    const outcome = cancellationOutcome({
      startsAt: new Date(b.startsAt),
      endsAt: new Date(b.endsAt),
      now: new Date(),
      cancelledBy: 'student',
      paidWith: b.paidWith,
      amountPaid: b.price,
      rules,
      deadline: new Date(b.cancelDeadline),
    })
    if (typeof outcome === 'string') return { message: '课程已开始，无法取消。', late: false }
    const { late } = outcome
    if (b.paidWith === 'package') {
      return {
        late,
        message: outcome.returnLesson
          ? '取消后课时将退回课时包。'
          : '已过免费取消时间，取消后本节课时不退回。',
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
    const b = this.data.booking
    if (!b || this.data.busy) return
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
      this.show(updated)
    } catch (e) {
      showError(e)
      await this.load()
    } finally {
      this.setData({ busy: false })
    }
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
      stale: () => this.load(),
    })
  },

  addToCalendar() {
    const b = this.data.booking
    if (!b) return
    // The page may have stayed open until the lesson began.
    if (Date.parse(b.startsAt) <= Date.now()) {
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

  retry() {
    this.setData({ state: 'loading' })
    this.load()
  },
})
