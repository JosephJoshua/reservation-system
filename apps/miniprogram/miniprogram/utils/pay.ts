import type { OrderStatusDto, PaymentParamsDto } from '../lib/shared'
import { ApiError, api } from './api'
import { yuan } from './format'

/** Paid; not paid (cancelled at the cashier); paid but not confirmed yet; or the order closed. */
export type PayResult = 'paid' | 'cancelled' | 'pending' | 'closed'

/** Said when a payment went through at the cashier but the server has not confirmed it yet. */
export const PAY_PENDING = '支付结果确认中，请稍后下拉刷新'

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

/** Whether the server has the order as paid, asking it once; false when it cannot be reached. */
function paidNow(orderId: number): Promise<boolean> {
  return api<OrderStatusDto>('GET', `/orders/${orderId}`)
    .then((order) => order.status === 'paid')
    .catch(() => false)
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
    if (e instanceof ApiError && e.code === 'order_paid') return 'paid'
    throw e
  }
  if (!stillHere()) return 'cancelled'
  let outcome: 'ok' | 'cancelled'
  try {
    outcome = payment.fake ? await fakePayment(orderId, amount) : await requestPayment(payment)
  } catch (e) {
    // WeChat also fails an order that was paid meanwhile, so ask the server before saying so.
    if (await paidNow(orderId)) return 'paid'
    throw e
  }
  // The server has the last word, even on a cancel.
  if (outcome === 'cancelled') return (await paidNow(orderId)) ? 'paid' : 'cancelled'
  const order = await waitForOrder(orderId)
  if (order?.status === 'closed') return 'closed'
  return order?.status === 'paid' ? 'paid' : 'pending'
}
