import {
  createCipheriv,
  createSign,
  createVerify,
  generateKeyPairSync,
  randomBytes,
} from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { GatewayError, UNKNOWN_OUTCOME } from './gateway'
import { rfc3339, WechatPayGateway } from './wechat'

const pair = () =>
  generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
const merchant = pair()
const platform = pair()
const API_V3_KEY = 'abcdefghijklmnopqrstuvwxyz012345'
const NOW = new Date('2026-10-23T02:00:00Z')
const nowS = String(Math.floor(NOW.getTime() / 1000))

function signedHeaders(body: string, timestamp = nowS, key = platform.privateKey) {
  const nonce = randomBytes(8).toString('hex')
  const signature = createSign('RSA-SHA256')
    .update(`${timestamp}\n${nonce}\n${body}\n`)
    .sign(key, 'base64')
  return new Headers({
    'Wechatpay-Timestamp': timestamp,
    'Wechatpay-Nonce': nonce,
    'Wechatpay-Signature': signature,
    'Wechatpay-Serial': 'PUB_KEY_ID_TEST',
  })
}

function encrypt(plain: object, aad = 'transaction') {
  const nonce = 'abcdefghijkl'
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(API_V3_KEY), Buffer.from(nonce))
  cipher.setAAD(Buffer.from(aad))
  const data = Buffer.concat([
    cipher.update(JSON.stringify(plain)),
    cipher.final(),
    cipher.getAuthTag(),
  ])
  return {
    algorithm: 'AEAD_AES_256_GCM',
    ciphertext: data.toString('base64'),
    associated_data: aad,
    nonce,
  }
}

interface Seen {
  method: string
  path: string
  body: string
}

/** A fake WeChat Pay server that checks our request signature and signs its answers. */
function server(handler: (req: Seen) => { status: number; body?: object }) {
  const seen: Seen[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const u = new URL(url)
    const path = u.pathname + u.search
    const body = (init.body as string | undefined) ?? ''
    const auth = (init.headers as Record<string, string>).Authorization ?? ''
    const fields = Object.fromEntries(
      [...auth.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]),
    )
    const message = `${init.method}\n${path}\n${fields.timestamp}\n${fields.nonce_str}\n${body}\n`
    const ok = createVerify('RSA-SHA256')
      .update(message)
      .verify(merchant.publicKey, fields.signature ?? '', 'base64')
    if (!ok || fields.mchid !== '1900000001' || fields.serial_no !== 'MERCHANT_SERIAL') {
      return new Response(JSON.stringify({ code: 'SIGN_ERROR', message: 'bad sign' }), {
        status: 401,
      })
    }
    const req = { method: init.method ?? 'GET', path, body }
    seen.push(req)
    const res = handler(req)
    const text = res.body ? JSON.stringify(res.body) : ''
    return new Response(text || null, {
      status: res.status,
      headers: text ? signedHeaders(text) : undefined,
    })
  }) as unknown as typeof fetch
  const gateway = new WechatPayGateway({
    appId: 'wx1234567890',
    mchId: '1900000001',
    apiV3Key: API_V3_KEY,
    merchantSerial: 'MERCHANT_SERIAL',
    merchantPrivateKey: merchant.privateKey,
    platformPublicKey: platform.publicKey,
    platformPublicKeyId: 'PUB_KEY_ID_TEST',
    notifyBase: 'https://example.com',
    fetch: fetchImpl,
    now: () => NOW,
  })
  return { gateway, seen }
}

describe('WechatPayGateway', () => {
  it('places a JSAPI order with a signed request', async () => {
    const { gateway, seen } = server(() => ({ status: 200, body: { prepay_id: 'wx_prepay_1' } }))
    const prepay = await gateway.createOrder({
      outTradeNo: 'RS1',
      description: '一对一私教',
      amount: 20000,
      openid: 'o_student',
      expiresAt: new Date('2026-10-23T02:10:00Z'),
    })
    expect(prepay).toBe('wx_prepay_1')
    expect(seen[0]?.path).toBe('/v3/pay/transactions/jsapi')
    expect(JSON.parse(seen[0]?.body ?? '')).toEqual({
      appid: 'wx1234567890',
      mchid: '1900000001',
      description: '一对一私教',
      out_trade_no: 'RS1',
      time_expire: '2026-10-23T10:10:00+08:00',
      notify_url: 'https://example.com/api/pay/wechat/notify',
      amount: { total: 20000, currency: 'CNY' },
      payer: { openid: 'o_student' },
    })
  })

  it('signs wx.requestPayment parameters with the merchant key', () => {
    const { gateway } = server(() => ({ status: 500 }))
    const p = gateway.paymentParams('wx_prepay_1')
    expect(p.package).toBe('prepay_id=wx_prepay_1')
    const message = `wx1234567890\n${p.timeStamp}\n${p.nonceStr}\n${p.package}\n`
    expect(
      createVerify('RSA-SHA256').update(message).verify(merchant.publicKey, p.paySign, 'base64'),
    ).toBe(true)
  })

  it('maps order states, treating an unknown order as closed', async () => {
    const states: Record<string, object> = {
      RS_PAID: {
        trade_state: 'SUCCESS',
        transaction_id: 'T1',
        success_time: '2026-10-23T10:05:00+08:00',
        amount: { total: 20000 },
      },
      RS_OPEN: { trade_state: 'NOTPAY' },
      RS_GONE: { trade_state: 'CLOSED' },
    }
    const { gateway } = server((req) => {
      const no = /out-trade-no\/(\w+)/.exec(req.path)?.[1] ?? ''
      return states[no]
        ? { status: 200, body: states[no] }
        : { status: 404, body: { code: 'ORDER_NOT_EXIST', message: '订单不存在' } }
    })
    expect(await gateway.queryOrder('RS_PAID')).toEqual({
      state: 'paid',
      transactionId: 'T1',
      paidAt: new Date('2026-10-23T02:05:00Z'),
      amount: 20000,
    })
    expect(await gateway.queryOrder('RS_OPEN')).toEqual({ state: 'pending' })
    expect(await gateway.queryOrder('RS_GONE')).toEqual({ state: 'closed' })
    expect(await gateway.queryOrder('RS_NONE')).toEqual({ state: 'closed' })
  })

  it('reports paid instead of closing a paid order', async () => {
    const { gateway, seen } = server(() => ({
      status: 200,
      body: { trade_state: 'SUCCESS', transaction_id: 'T' },
    }))
    expect((await gateway.closeOrder('RS1')).state).toBe('paid')
    expect(seen.some((r) => r.path.endsWith('/close'))).toBe(false)
  })

  it('closes an unpaid order', async () => {
    const { gateway, seen } = server((req) =>
      req.path.endsWith('/close')
        ? { status: 204 }
        : { status: 200, body: { trade_state: 'NOTPAY' } },
    )
    expect((await gateway.closeOrder('RS1')).state).toBe('closed')
    expect(JSON.parse(seen.at(-1)?.body ?? '')).toEqual({ mchid: '1900000001' })
  })

  it('submits refunds and maps their status', async () => {
    const { gateway, seen } = server(() => ({
      status: 200,
      body: { refund_id: 'R1', status: 'PROCESSING' },
    }))
    const res = await gateway.refund({
      outTradeNo: 'RS1',
      outRefundNo: 'RF1',
      amount: 5000,
      total: 20000,
      reason: '取消预约',
    })
    expect(res).toEqual({ status: 'processing', refundId: 'R1' })
    expect(JSON.parse(seen[0]?.body ?? '')).toMatchObject({
      out_trade_no: 'RS1',
      out_refund_no: 'RF1',
      notify_url: 'https://example.com/api/pay/wechat/refund-notify',
      amount: { refund: 5000, total: 20000, currency: 'CNY' },
    })
  })

  it('surfaces API errors with their code', async () => {
    const { gateway } = server(() => ({
      status: 403,
      body: { code: 'NOT_ENOUGH', message: '基本账户余额不足' },
    }))
    const err = await gateway
      .refund({ outTradeNo: 'RS1', outRefundNo: 'RF1', amount: 1, total: 1, reason: 'x' })
      .catch((e) => e)
    expect(err).toBeInstanceOf(GatewayError)
    expect(err).toMatchObject({ code: 'NOT_ENOUGH', status: 403 })
  })

  it('rejects a response with a bad signature', async () => {
    const { gateway } = server(() => ({ status: 200, body: { prepay_id: 'x' } }))
    // Replace the platform key so every response signature fails.
    ;(gateway as unknown as { config: { platformPublicKey: string } }).config.platformPublicKey =
      pair().publicKey
    // WeChat Pay took the request, so the outcome is unknown rather than a refusal.
    await expect(gateway.queryOrder('RS1')).rejects.toMatchObject({
      code: 'BAD_RESPONSE',
      message: expect.stringMatching(/bad signature/),
    })
  })

  it('reports a refund whose answer cannot be verified as unknown, not failed', async () => {
    const { gateway } = server(() => ({
      status: 200,
      body: { refund_id: 'R1', status: 'SUCCESS' },
    }))
    ;(gateway as unknown as { config: { platformPublicKey: string } }).config.platformPublicKey =
      pair().publicKey
    const err = await gateway
      .refund({ outTradeNo: 'RS1', outRefundNo: 'RF1', amount: 1, total: 1, reason: 'x' })
      .catch((e) => e)
    expect(err).toMatchObject({ code: 'BAD_RESPONSE', status: 200 })
    expect(UNKNOWN_OUTCOME.has(err.code)).toBe(true)
  })

  it('maps refund states: only CLOSED is a failure', async () => {
    const statuses: Record<string, string> = {
      RF_OK: 'SUCCESS',
      RF_WAIT: 'PROCESSING',
      RF_CLOSED: 'CLOSED',
      RF_ABNORMAL: 'ABNORMAL',
      RF_NEW: 'SOMETHING_NEW',
    }
    const { gateway } = server((req) => {
      const no = /refunds\/(\w+)/.exec(req.path)?.[1] ?? ''
      return { status: 200, body: { refund_id: `id_${no}`, status: statuses[no] } }
    })
    expect(await gateway.queryRefund('RF_OK')).toEqual({
      status: 'succeeded',
      refundId: 'id_RF_OK',
    })
    expect(await gateway.queryRefund('RF_WAIT')).toEqual({
      status: 'processing',
      refundId: 'id_RF_WAIT',
    })
    expect(await gateway.queryRefund('RF_CLOSED')).toEqual({ status: 'failed', reason: 'CLOSED' })
    expect(await gateway.queryRefund('RF_ABNORMAL')).toEqual({
      status: 'processing',
      refundId: 'id_RF_ABNORMAL',
      abnormal: true,
    })
    expect(await gateway.queryRefund('RF_NEW')).toEqual({
      status: 'processing',
      refundId: 'id_RF_NEW',
    })
  })

  it('verifies and decrypts a payment callback', () => {
    const { gateway } = server(() => ({ status: 500 }))
    const body = JSON.stringify({
      id: 'EV1',
      event_type: 'TRANSACTION.SUCCESS',
      resource_type: 'encrypt-resource',
      resource: encrypt({
        appid: 'wx1234567890',
        mchid: '1900000001',
        out_trade_no: 'RS1',
        trade_state: 'SUCCESS',
        transaction_id: 'T9',
        success_time: '2026-10-23T10:01:00+08:00',
        amount: { total: 20000 },
      }),
    })
    expect(gateway.parsePaymentNotification(signedHeaders(body), body)).toEqual({
      outTradeNo: 'RS1',
      order: {
        state: 'paid',
        transactionId: 'T9',
        paidAt: new Date('2026-10-23T02:01:00Z'),
        amount: 20000,
      },
    })
  })

  it('refuses a payment callback for another app or merchant', () => {
    const { gateway } = server(() => ({ status: 500 }))
    for (const ids of [
      { appid: 'wx_other', mchid: '1900000001' },
      { appid: 'wx1234567890', mchid: '1900000999' },
      {},
    ]) {
      const body = JSON.stringify({
        resource: encrypt({ ...ids, out_trade_no: 'RS1', trade_state: 'SUCCESS' }),
      })
      expect(() => gateway.parsePaymentNotification(signedHeaders(body), body)).toThrow(
        expect.objectContaining({ code: 'FOREIGN_NOTIFICATION' }),
      )
    }
  })

  it('marks an order refunded at WeChat Pay as such', () => {
    const { gateway } = server(() => ({ status: 500 }))
    const body = JSON.stringify({
      resource: encrypt({
        appid: 'wx1234567890',
        mchid: '1900000001',
        out_trade_no: 'RS1',
        trade_state: 'REFUND',
        transaction_id: 'T9',
        amount: { total: 20000 },
      }),
    })
    expect(gateway.parsePaymentNotification(signedHeaders(body), body).order).toMatchObject({
      state: 'paid',
      refunded: true,
    })
  })

  it('refuses forged, stale or tampered callbacks', () => {
    const { gateway } = server(() => ({ status: 500 }))
    const body = JSON.stringify({
      resource: encrypt({ out_trade_no: 'RS1', trade_state: 'SUCCESS' }),
    })
    expect(() =>
      gateway.parsePaymentNotification(signedHeaders(body, nowS, pair().privateKey), body),
    ).toThrow(/bad signature/)
    const old = String(Number(nowS) - 600)
    expect(() => gateway.parsePaymentNotification(signedHeaders(body, old), body)).toThrow(/stale/)
    const resource = encrypt({ out_trade_no: 'RS1', trade_state: 'SUCCESS' })
    resource.associated_data = 'other'
    const tampered = JSON.stringify({ resource })
    expect(() => gateway.parsePaymentNotification(signedHeaders(tampered), tampered)).toThrow(
      /decrypt/,
    )
  })

  it('decrypts a refund callback', () => {
    const { gateway } = server(() => ({ status: 500 }))
    const body = JSON.stringify({
      event_type: 'REFUND.SUCCESS',
      resource: encrypt(
        { out_refund_no: 'RF1', refund_id: 'R1', refund_status: 'SUCCESS' },
        'refund',
      ),
    })
    expect(gateway.parseRefundNotification(signedHeaders(body), body)).toEqual({
      outRefundNo: 'RF1',
      refund: { status: 'succeeded', refundId: 'R1' },
    })
  })
})

describe('rfc3339', () => {
  it('formats in China Standard Time', () => {
    expect(rfc3339(new Date('2026-10-23T16:30:00Z'))).toBe('2026-10-24T00:30:00+08:00')
  })
})
