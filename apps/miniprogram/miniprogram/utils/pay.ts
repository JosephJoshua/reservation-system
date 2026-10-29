import type { OrderStatusDto, PaymentParamsDto } from '../lib/shared'
import { ApiError, api } from './api'
import { yuan } from './format'

/**
 * Paid; paid, but the lesson could not be confirmed (the venue stopped or called it off, or the
 * hold ran out and the time was taken) so the money goes back; not paid (cancelled at the cashier); paid at the
 * cashier but not confirmed yet; or paid at the cashier while the server has the order closed,
 * which staff have to sort out.
 */
export type PayResult = 'paid' | 'refunded' | 'cancelled' | 'pending' | 'unclear'

/** Said when a payment went through at the cashier but the server has not confirmed it yet. */
export const PAY_PENDING = '支付结果确认中，请稍后下拉刷新'

/**
 * Said when the cashier took the payment but the server has the order closed. The money may have
 * been taken, so this never invites paying again.
 */
export const PAY_UNCLEAR = '支付结果确认中，如已扣款请联系场馆'

/** Said when a payment landed on a lesson that can no longer go ahead and is refunded. */
export const PAY_REFUNDED = '这节课无法上课，款项将原路退回'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function requestPayment(params: PaymentParamsDto): Promise<'ok' | 'cancelled'> {
  return new Promise((resolve, reject) => {
    wx.requestPayment({
      timeStamp: params.timeStamp,
      nonceStr: params.nonceStr,
      package: params.package,
      signType: params.signType,
      paySign: params.paySign,
      success: () => resolve('ok'),
      fail: (err) => {
        if (/cancel/.test(err.errMsg)) resolve('cancelled')
        else reject(new ApiError(0, 'pay_failed', '支付未完成，请稍后再试'))
      },
    })
  })
}

/** Without WeChat Pay credentials the API uses a fake gateway; this stands in for the cashier. */
async function fakePayment(orderId: number, amount: number): Promise<'ok' | 'cancelled'> {
  const { confirm } = await wx.showModal({
    title: '模拟支付',
    content: `开发环境未接入微信支付，确认模拟支付 ${yuan(amount)}？`,
    confirmText: '支付',
  })
  if (!confirm) return 'cancelled'
  await api('POST', `/dev/fake-pay/${orderId}`)
  return 'ok'
}

/**
 * Waits for the server to see the payment. Only the WeChat Pay callback (or the server's own
 * query) marks an order paid, so the client asks the server rather than trusting requestPayment.
 */
export async function waitForOrder(orderId: number): Promise<OrderStatusDto | null> {
  wx.showLoading({ title: '确认支付结果', mask: true })
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      const order = await api<OrderStatusDto>('GET', `/orders/${orderId}`).catch(() => null)
      if (order && order.status !== 'pending') return order
      await sleep(attempt < 3 ? 800 : 1500)
    }
    return null
  } finally {
    wx.hideLoading()
  }
}

/**
 * A paid order's result: its lesson booking was not confirmed (expired, or cancelled by the venue
 * for a session it called off), so the money goes back.
 */
function paidAs(order: OrderStatusDto): 'paid' | 'refunded' {
  return order.bookingStatus === 'expired' || order.bookingStatus === 'cancelled'
    ? 'refunded'
    : 'paid'
}

/** The paid order's result, asking the server once; null when unpaid or it cannot be reached. */
function paidNow(orderId: number): Promise<'paid' | 'refunded' | null> {
  return api<OrderStatusDto>('GET', `/orders/${orderId}`)
    .then((order) => (order.status === 'paid' ? paidAs(order) : null))
    .catch(() => null)
}

/**
 * Opens the cashier for an order and waits for the server to confirm it. An order paid already,
 * say before the app was closed or on another phone, comes back as paid without a cashier.
 * `stillHere` is asked right before the cashier opens: a student who went back while the order
 * was on its way gets 'cancelled' and no cashier over the page they went back to.
 */
export async function payOrder(
  orderId: number,
  amount: number,
  params: PaymentParamsDto | null | undefined,
  stillHere: () => boolean,
): Promise<PayResult> {
  let payment: PaymentParamsDto
  try {
    payment = params ?? (await api<PaymentParamsDto>('POST', `/orders/${orderId}/payment`))
  } catch (e) {
    // Paid already; the lesson may have been refunded since. Said as paid if that cannot be told.
    if (e instanceof ApiError && e.code === 'order_paid') return (await paidNow(orderId)) ?? 'paid'
    throw e
  }
  if (!stillHere()) return 'cancelled'
  let outcome: 'ok' | 'cancelled'
  try {
    outcome = payment.fake ? await fakePayment(orderId, amount) : await requestPayment(payment)
  } catch (e) {
    // WeChat also fails an order that was paid meanwhile, so ask the server before saying so.
    const paid = await paidNow(orderId)
    if (paid) return paid
    throw e
  }
  // The server has the last word, even on a cancel.
  if (outcome === 'cancelled') return (await paidNow(orderId)) ?? 'cancelled'
  const order = await waitForOrder(orderId)
  // The cashier said paid, so a closed order is not "nothing paid": the payment may land on it
  // later, or need a refund by staff.
  if (order?.status === 'closed') return 'unclear'
  return order?.status === 'paid' ? paidAs(order) : 'pending'
}
