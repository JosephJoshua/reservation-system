import type {
  CreateOrderInput,
  OrderState,
  PaymentGateway,
  PaymentNotification,
  RefundInput,
  RefundNotification,
  RefundState,
} from './gateway'
import { GatewayError } from './gateway'

export const fakeRefundModes = ['succeeded', 'processing', 'fail', 'abnormal', 'unknown'] as const
export type FakeRefundMode = (typeof fakeRefundModes)[number]

/** A payment as WeChat Pay should never report it, for QA of how the API copes. */
export type FakePayOddity = 'mismatch' | 'refunded'

interface FakeOrder extends CreateOrderInput {
  state: OrderState
}

/**
 * In-memory stand-in for WeChat Pay, used in development, tests and QA. Payments are completed by
 * calling `pay`, which the dev route exposes to the mini program.
 */
export class FakeGateway implements PaymentGateway {
  readonly fake = true
  readonly orders = new Map<string, FakeOrder>()
  readonly refunds = new Map<string, RefundInput & { state: RefundState }>()
  /**
   * How the next refunds go. They settle at once by default. `abnormal` is WeChat Pay's ABNORMAL
   * (the card could not take the money back); `unknown` takes the refund but answers with an
   * error, as when WeChat Pay's answer cannot be verified.
   */
  refundMode: FakeRefundMode = 'succeeded'
  failCreate = false
  private seq = 0

  async createOrder(input: CreateOrderInput) {
    if (this.failCreate) throw new GatewayError('fake create failure', 'SYSTEM_ERROR', 500)
    if (!this.orders.has(input.outTradeNo)) {
      this.orders.set(input.outTradeNo, { ...input, state: { state: 'pending' } })
    }
    return `fake_prepay_${input.outTradeNo}`
  }

  paymentParams(prepayId: string) {
    return {
      timeStamp: String(Math.floor(Date.now() / 1000)),
      nonceStr: 'fake',
      package: `prepay_id=${prepayId}`,
      signType: 'RSA' as const,
      paySign: 'fake',
      fake: true as const,
    }
  }

  /**
   * Marks the order paid, as a successful wx.requestPayment would. With `oddity`, the payment is
   * reported with another amount (`mismatch`) or as already refunded (`refunded`).
   */
  pay(outTradeNo: string, now = new Date(), oddity?: FakePayOddity): PaymentNotification {
    const order = this.orders.get(outTradeNo)
    if (!order) throw new GatewayError('order not found', 'ORDER_NOT_EXIST', 404)
    if (order.state.state === 'closed') throw new GatewayError('order closed', 'ORDER_CLOSED', 400)
    if (order.state.state === 'pending') {
      order.state = {
        state: 'paid',
        transactionId: `fake_txn_${++this.seq}`,
        paidAt: now,
        amount: oddity === 'mismatch' ? order.amount + 1 : order.amount,
        ...(oddity === 'refunded' ? { refunded: true as const } : {}),
      }
    }
    return { outTradeNo, order: order.state }
  }

  async queryOrder(outTradeNo: string): Promise<OrderState> {
    const order = this.orders.get(outTradeNo)
    if (!order) throw new GatewayError('order not found', 'ORDER_NOT_EXIST', 404)
    return order.state
  }

  async closeOrder(outTradeNo: string) {
    const order = this.orders.get(outTradeNo)
    if (!order) return { state: 'closed' as const }
    if (order.state.state === 'paid') return order.state
    order.state = { state: 'closed' }
    return order.state
  }

  async refund(input: RefundInput): Promise<RefundState> {
    const existing = this.refunds.get(input.outRefundNo)
    if (existing) return existing.state
    const order = this.orders.get(input.outTradeNo)
    if (order?.state.state !== 'paid') {
      throw new GatewayError('order not paid', 'INVALID_REQUEST', 400)
    }
    const refundId = `fake_refund_${++this.seq}`
    const state: RefundState =
      this.refundMode === 'fail'
        ? { status: 'failed', reason: 'fake failure' }
        : this.refundMode === 'abnormal'
          ? { status: 'processing', refundId, abnormal: true }
          : this.refundMode === 'processing'
            ? { status: 'processing', refundId }
            : { status: 'succeeded', refundId }
    this.refunds.set(input.outRefundNo, { ...input, state })
    if (this.refundMode === 'unknown') {
      throw new GatewayError('fake unreadable response', 'BAD_RESPONSE', 200)
    }
    return state
  }

  /** Settles a refund left processing. */
  settleRefund(outRefundNo: string): RefundNotification {
    const refund = this.refunds.get(outRefundNo)
    if (!refund) throw new GatewayError('refund not found', 'RESOURCE_NOT_EXISTS', 404)
    // An ABNORMAL one settles too, as when staff handle it on the merchant platform.
    if (refund.state.status === 'processing') {
      refund.state = { status: 'succeeded', refundId: refund.state.refundId }
    }
    return { outRefundNo, refund: refund.state }
  }

  async queryRefund(outRefundNo: string): Promise<RefundState> {
    const refund = this.refunds.get(outRefundNo)
    if (!refund) throw new GatewayError('refund not found', 'RESOURCE_NOT_EXISTS', 404)
    return refund.state
  }

  parsePaymentNotification(): PaymentNotification {
    throw new GatewayError('the fake gateway sends no callbacks', 'NOT_SUPPORTED')
  }

  parseRefundNotification(): RefundNotification {
    throw new GatewayError('the fake gateway sends no callbacks', 'NOT_SUPPORTED')
  }
}
