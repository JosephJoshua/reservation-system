import {
  type BookingDto,
  type CatalogDto,
  cancellationOutcome,
  type HomeDto,
} from '../../lib/shared'
import { api, errorMessage, publicApi, showError } from '../../utils/api'
import { cancelRuleText, getCatalog } from '../../utils/data'
import { dateTime, lessonTime, yuan } from '../../utils/format'
import { REFUND_STATUS } from '../../utils/labels'
import { payOrder } from '../../utils/pay'

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
    payment: '',
    deadline: '',
    refund: '',
    address: '',
    cancelRule: '',
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

  show(b: BookingDto) {
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
      payment:
        b.paidWith === 'package'
          ? `课时包 · ${b.packageName ?? ''}`
          : b.price > 0
            ? `微信支付 · ${yuan(b.price)}`
            : '免费',
      deadline: dateTime(b.cancelDeadline),
      refund: b.refund ? `${yuan(b.refund.amount)} · ${REFUND_STATUS[b.refund.status]}` : '',
      address: this.venue?.address ?? '',
      cancelRule: booking ? cancelRuleText(booking.cancelDeadlineHours, booking.lateCancel) : '',
    })
    if (b.status === 'pending_payment') this.startTimer()
    else this.stopTimer()
  },

  startTimer() {
    this.stopTimer()
    this.timer = setInterval(() => {
      const b = this.data.booking
      if (b?.status !== 'pending_payment') return this.stopTimer()
      if (b.payBy && Date.parse(b.payBy) <= Date.now()) {
        this.stopTimer()
        this.load()
        return
      }
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

  /** Spells out what cancelling now costs before asking. */
  cancelMessage(b: BookingDto): string {
    if (b.status === 'pending_payment') return '取消后该时段将释放给其他学员。'
    const rules = this.catalog?.booking
    if (!rules) return '确定取消这节课吗？'
    const outcome = cancellationOutcome({
      startsAt: new Date(b.startsAt),
      endsAt: new Date(b.endsAt),
      now: new Date(),
      cancelledBy: 'student',
      paidWith: b.paidWith,
      amountPaid: b.price,
      rules,
    })
    if (typeof outcome === 'string') return '课程已开始，无法取消。'
    if (b.paidWith === 'package') {
      return outcome.returnLesson
        ? '取消后课时将退回课时包。'
        : '已过免费取消时间，取消后本节课时不退回。'
    }
    if (b.price === 0) return '确定取消这节课吗？'
    if (!outcome.late) return `取消后 ${yuan(outcome.refund)} 将原路退回。`
    return outcome.refund > 0
      ? `已过免费取消时间，取消后退还 ${yuan(outcome.refund)}。`
      : '已过免费取消时间，取消后不退款。'
  },

  async cancel() {
    const b = this.data.booking
    if (!b || this.data.busy) return
    const { confirm } = await wx.showModal({
      title: '取消预约',
      content: this.cancelMessage(b),
      confirmText: '确认取消',
      confirmColor: '#d54941',
      cancelText: '再想想',
    })
    if (!confirm) return
    this.setData({ busy: true })
    try {
      const updated = await api<BookingDto>('POST', `/bookings/${b.id}/cancel`)
      this.show(updated)
    } catch (e) {
      showError(e)
      await this.load()
    } finally {
      this.setData({ busy: false })
    }
  },

  rebook() {
    const b = this.data.booking
    if (!b) return
    wx.navigateTo({
      url: `/pages/book/index?lessonTypeId=${b.lessonType.id}&coachId=${b.coach.id}`,
    })
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
