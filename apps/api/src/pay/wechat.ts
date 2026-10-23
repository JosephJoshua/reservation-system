import { createDecipheriv, createSign, createVerify, randomBytes } from 'node:crypto'
import type {
  CreateOrderInput,
  OrderState,
  PaymentGateway,
  PaymentNotification,
  PaymentParams,
  RefundInput,
  RefundNotification,
  RefundState,
} from './gateway'
import { GatewayError } from './gateway'

export interface WechatPayConfig {
  appId: string
  mchId: string
  /** APIv3 key, 32 characters, used to decrypt callbacks. */
  apiV3Key: string
  /** Serial number of the merchant API certificate. */
  merchantSerial: string
  /** Merchant API private key (apiclient_key.pem). */
  merchantPrivateKey: string
  /** WeChat Pay public key (pub_key.pem) and its id (PUB_KEY_ID_...). */
  platformPublicKey: string
  platformPublicKeyId: string
  /** Public HTTPS base of the API, e.g. https://example.com, for callback URLs. */
  notifyBase: string
  baseUrl?: string
  fetch?: typeof fetch
  now?: () => Date
}

const MAX_CLOCK_SKEW_S = 5 * 60

interface EncryptedResource {
  algorithm: string
  ciphertext: string
  associated_data?: string
  nonce: string
}

/** WeChat Pay APIv3 for mini program payments, in WeChat Pay public key mode. */
export class WechatPayGateway implements PaymentGateway {
  readonly fake = false
  private readonly baseUrl: string
  private readonly fetch: typeof fetch
  private readonly now: () => Date

  constructor(private readonly config: WechatPayConfig) {
    if (Buffer.byteLength(config.apiV3Key) !== 32) {
      throw new Error('WeChat Pay APIv3 key must be 32 bytes')
    }
    this.baseUrl = config.baseUrl ?? 'https://api.mch.weixin.qq.com'
    this.fetch = config.fetch ?? fetch
    this.now = config.now ?? (() => new Date())
  }

  async createOrder(input: CreateOrderInput) {
    const res = await this.request<{ prepay_id: string }>('POST', '/v3/pay/transactions/jsapi', {
      appid: this.config.appId,
      mchid: this.config.mchId,
      description: input.description.slice(0, 127),
      out_trade_no: input.outTradeNo,
      time_expire: rfc3339(input.expiresAt),
      notify_url: `${this.config.notifyBase}/api/pay/wechat/notify`,
      amount: { total: input.amount, currency: 'CNY' },
      payer: { openid: input.openid },
    })
    return res.prepay_id
  }

  paymentParams(prepayId: string): PaymentParams {
    const timeStamp = String(Math.floor(this.now().getTime() / 1000))
    const nonceStr = nonce()
    const pkg = `prepay_id=${prepayId}`
    const paySign = this.sign([this.config.appId, timeStamp, nonceStr, pkg])
    return { timeStamp, nonceStr, package: pkg, signType: 'RSA', paySign }
  }

  async queryOrder(outTradeNo: string): Promise<OrderState> {
    try {
      const res = await this.request<{
        trade_state: string
        transaction_id?: string
        success_time?: string
        amount?: { total: number }
      }>(
        'GET',
        `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${this.config.mchId}`,
      )
      return mapTradeState(res)
    } catch (e) {
      // An order WeChat never accepted can never be paid.
      if (e instanceof GatewayError && e.code === 'ORDER_NOT_EXIST') return { state: 'closed' }
      throw e
    }
  }

  async closeOrder(outTradeNo: string) {
    const before = await this.queryOrder(outTradeNo)
    if (before.state === 'paid') return 'paid' as const
    if (before.state === 'closed') return 'closed' as const
    try {
      await this.request(
        'POST',
        `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}/close`,
        { mchid: this.config.mchId },
      )
      return 'closed' as const
    } catch (e) {
      // Paid between the query and the close.
      if ((await this.queryOrder(outTradeNo)).state === 'paid') return 'paid' as const
      throw e
    }
  }

  async refund(input: RefundInput): Promise<RefundState> {
    const res = await this.request<RefundResponse>('POST', '/v3/refund/domestic/refunds', {
      out_trade_no: input.outTradeNo,
      out_refund_no: input.outRefundNo,
      reason: input.reason.slice(0, 80),
      notify_url: `${this.config.notifyBase}/api/pay/wechat/refund-notify`,
      amount: { refund: input.amount, total: input.total, currency: 'CNY' },
    })
    return mapRefund(res)
  }

  async queryRefund(outRefundNo: string): Promise<RefundState> {
    const res = await this.request<RefundResponse>(
      'GET',
      `/v3/refund/domestic/refunds/${encodeURIComponent(outRefundNo)}`,
    )
    return mapRefund(res)
  }

  parsePaymentNotification(headers: Headers, body: string): PaymentNotification {
    const data = this.decryptNotification<{
      out_trade_no: string
      trade_state: string
      transaction_id?: string
      success_time?: string
      amount?: { total: number }
    }>(headers, body)
    return { outTradeNo: data.out_trade_no, order: mapTradeState(data) }
  }

  parseRefundNotification(headers: Headers, body: string): RefundNotification {
    const data = this.decryptNotification<{
      out_refund_no: string
      refund_id: string
      refund_status: string
    }>(headers, body)
    return {
      outRefundNo: data.out_refund_no,
      refund: mapRefund({ refund_id: data.refund_id, status: data.refund_status }),
    }
  }

  private decryptNotification<T>(headers: Headers, body: string): T {
    this.verify(headers, body)
    const event = JSON.parse(body) as { resource?: EncryptedResource }
    if (event.resource?.algorithm !== 'AEAD_AES_256_GCM') {
      throw new GatewayError('unexpected callback body', 'BAD_NOTIFICATION', 400)
    }
    return JSON.parse(decryptResource(event.resource, this.config.apiV3Key)) as T
  }

  /** Checks a WeChat Pay signature on a response or callback. */
  private verify(headers: Headers, body: string) {
    const timestamp = headers.get('wechatpay-timestamp')
    const nonceStr = headers.get('wechatpay-nonce')
    const signature = headers.get('wechatpay-signature')
    const serial = headers.get('wechatpay-serial')
    if (!timestamp || !nonceStr || !signature || !serial) {
      throw new GatewayError('missing signature headers', 'BAD_SIGNATURE', 401)
    }
    if (serial !== this.config.platformPublicKeyId) {
      throw new GatewayError(`unknown key ${serial}`, 'BAD_SIGNATURE', 401)
    }
    const age = Math.abs(this.now().getTime() / 1000 - Number(timestamp))
    if (!Number.isFinite(age) || age > MAX_CLOCK_SKEW_S) {
      throw new GatewayError('stale signature', 'BAD_SIGNATURE', 401)
    }
    const ok = createVerify('RSA-SHA256')
      .update(`${timestamp}\n${nonceStr}\n${body}\n`)
      .verify(this.config.platformPublicKey, signature, 'base64')
    if (!ok) throw new GatewayError('bad signature', 'BAD_SIGNATURE', 401)
  }

  private sign(lines: string[]) {
    return createSign('RSA-SHA256')
      .update(`${lines.join('\n')}\n`)
      .sign(this.config.merchantPrivateKey, 'base64')
  }

  private async request<T>(method: 'GET' | 'POST', path: string, payload?: unknown): Promise<T> {
    const body = payload === undefined ? '' : JSON.stringify(payload)
    const timestamp = String(Math.floor(this.now().getTime() / 1000))
    const nonceStr = nonce()
    const signature = this.sign([method, path, timestamp, nonceStr, body])
    const authorization =
      `WECHATPAY2-SHA256-RSA2048 mchid="${this.config.mchId}",nonce_str="${nonceStr}",` +
      `signature="${signature}",timestamp="${timestamp}",serial_no="${this.config.merchantSerial}"`
    let res: Response
    try {
      res = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: authorization,
          'Wechatpay-Serial': this.config.platformPublicKeyId,
        },
        body: method === 'GET' ? undefined : body,
      })
    } catch (e) {
      throw new GatewayError(`network error: ${(e as Error).message}`, 'NETWORK', 0)
    }
    const text = await res.text()
    if (!res.ok) {
      let code = 'HTTP_ERROR'
      let message = text
      try {
        const err = JSON.parse(text) as { code?: string; message?: string }
        code = err.code ?? code
        message = err.message ?? message
      } catch {}
      throw new GatewayError(message, code, res.status)
    }
    if (text === '') return undefined as T
    this.verify(res.headers, text)
    return JSON.parse(text) as T
  }
}

interface RefundResponse {
  refund_id?: string
  status: string
}

function mapTradeState(res: {
  trade_state: string
  transaction_id?: string
  success_time?: string
  amount?: { total: number }
}): OrderState {
  switch (res.trade_state) {
    // REFUND means it was paid and later refunded, which our own refund rows track.
    case 'SUCCESS':
    case 'REFUND':
      return {
        state: 'paid',
        transactionId: res.transaction_id ?? '',
        paidAt: res.success_time ? new Date(res.success_time) : new Date(),
        amount: res.amount?.total ?? 0,
      }
    case 'CLOSED':
    case 'REVOKED':
      return { state: 'closed' }
    default:
      // NOTPAY, USERPAYING, PAYERROR: still open until it expires.
      return { state: 'pending' }
  }
}

function mapRefund(res: RefundResponse): RefundState {
  switch (res.status) {
    case 'SUCCESS':
      return { status: 'succeeded', refundId: res.refund_id ?? '' }
    case 'PROCESSING':
      return { status: 'processing', refundId: res.refund_id ?? '' }
    default:
      return { status: 'failed', reason: res.status }
  }
}

export function decryptResource(resource: EncryptedResource, apiV3Key: string): string {
  const data = Buffer.from(resource.ciphertext, 'base64')
  const tag = data.subarray(data.length - 16)
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(apiV3Key),
    Buffer.from(resource.nonce),
  )
  decipher.setAuthTag(tag)
  decipher.setAAD(Buffer.from(resource.associated_data ?? ''))
  try {
    return Buffer.concat([
      decipher.update(data.subarray(0, data.length - 16)),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    throw new GatewayError('cannot decrypt callback', 'BAD_NOTIFICATION', 400)
  }
}

/** RFC 3339 in China Standard Time, as WeChat Pay expects for time_expire. */
export function rfc3339(instant: Date): string {
  const local = new Date(instant.getTime() + 8 * 3600_000).toISOString().slice(0, 19)
  return `${local}+08:00`
}

function nonce() {
  return randomBytes(16).toString('hex')
}
