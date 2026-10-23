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
  /** Refunds settle immediately unless set to 'processing'. */
  refundMode: 'succeeded' | 'processing' | 'fail' = 'succeeded'
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

  /** Marks the order paid, as a successful wx.requestPayment would. */
  pay(outTradeNo: string, now = new Date()): PaymentNotification {
    const order = this.orders.get(outTradeNo)
    if (!order) throw new GatewayError('order not found', 'ORDER_NOT_EXIST', 404)
    if (order.state.state === 'closed') throw new GatewayError('order closed', 'ORDER_CLOSED', 400)
    if (order.state.state === 'pending') {
      order.state = {
        state: 'paid',
        transactionId: `fake_txn_${++this.seq}`,
        paidAt: now,
        amount: order.amount,
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
    if (!order) return 'closed' as const
    if (order.state.state === 'paid') return 'paid' as const
    order.state = { state: 'closed' }
    return 'closed' as const
  }

  async refund(input: RefundInput): Promise<RefundState> {
    const existing = this.refunds.get(input.outRefundNo)
    if (existing) return existing.state
    const order = this.orders.get(input.outTradeNo)
    if (order?.state.state !== 'paid') {
      throw new GatewayError('order not paid', 'INVALID_REQUEST', 400)
    }
    const state: RefundState =
      this.refundMode === 'fail'
        ? { status: 'failed', reason: 'fake failure' }
        : { status: this.refundMode, refundId: `fake_refund_${++this.seq}` }
    this.refunds.set(input.outRefundNo, { ...input, state })
    return state
  }

  /** Settles a refund left processing. */
  settleRefund(outRefundNo: string): RefundNotification {
    const refund = this.refunds.get(outRefundNo)
    if (!refund) throw new GatewayError('refund not found', 'RESOURCE_NOT_EXISTS', 404)
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
