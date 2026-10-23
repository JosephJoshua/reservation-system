import type { OrderStatusDto, PaymentParamsDto } from '../lib/shared'
import { ApiError, api } from './api'
import { yuan } from './format'

export type PayResult = 'paid' | 'cancelled' | 'pending'

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

/** Opens the cashier for an order and waits for the server to confirm it. */
export async function payOrder(
  orderId: number,
  amount: number,
  params?: PaymentParamsDto | null,
): Promise<PayResult> {
  const payment = params ?? (await api<PaymentParamsDto>('POST', `/orders/${orderId}/payment`))
  const outcome = payment.fake ? await fakePayment(orderId, amount) : await requestPayment(payment)
  if (outcome === 'cancelled') return 'cancelled'
  const order = await waitForOrder(orderId)
  return order?.status === 'paid' ? 'paid' : 'pending'
}
