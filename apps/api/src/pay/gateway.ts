/** What the mini program passes to wx.requestPayment. */
export interface PaymentParams {
  timeStamp: string
  nonceStr: string
  package: string
  signType: 'RSA'
  paySign: string
  /** Set by the fake gateway: the mini program confirms through /api/dev/fake-pay instead. */
  fake?: true
}

export interface CreateOrderInput {
  outTradeNo: string
  description: string
  amount: number
  openid: string
  expiresAt: Date
}

export type OrderState =
  | { state: 'paid'; transactionId: string; paidAt: Date; amount: number }
  | { state: 'pending' }
  | { state: 'closed' }

export type RefundState =
  | { status: 'succeeded'; refundId: string }
  | { status: 'processing'; refundId: string }
  | { status: 'failed'; reason: string }

export interface PaymentNotification {
  outTradeNo: string
  order: OrderState
}

export interface RefundNotification {
  outRefundNo: string
  refund: RefundState
}

export interface RefundInput {
  outTradeNo: string
  outRefundNo: string
  amount: number
  total: number
  reason: string
}

/** WeChat Pay as the API uses it. Every method throws GatewayError on a failure it cannot map. */
export interface PaymentGateway {
  readonly fake: boolean
  /** Places the order and returns the prepay id. Safe to repeat with the same outTradeNo. */
  createOrder(input: CreateOrderInput): Promise<string>
  /** Signs the parameters for wx.requestPayment from a prepay id. */
  paymentParams(prepayId: string): PaymentParams
  queryOrder(outTradeNo: string): Promise<OrderState>
  /** Closes an unpaid order. Resolves with the payment instead when it was paid meanwhile. */
  closeOrder(outTradeNo: string): Promise<Exclude<OrderState, { state: 'pending' }>>
  refund(input: RefundInput): Promise<RefundState>
  queryRefund(outRefundNo: string): Promise<RefundState>
  /** Verifies and decrypts a payment callback. Throws on a bad signature. */
  parsePaymentNotification(headers: Headers, body: string): PaymentNotification
  parseRefundNotification(headers: Headers, body: string): RefundNotification
}

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'GatewayError'
  }
}
