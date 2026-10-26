import { describe, expect, it } from 'vitest'
import { wechatPay } from './config'

const PEM = '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----'
const pay = {
  WECHAT_PAY_MCHID: '1900000001',
  WECHAT_PAY_API_V3_KEY: 'k'.repeat(32),
  WECHAT_PAY_MERCHANT_SERIAL: 'SERIAL',
  WECHAT_PAY_MERCHANT_PRIVATE_KEY: PEM,
  WECHAT_PAY_PUBLIC_KEY: PEM,
  WECHAT_PAY_PUBLIC_KEY_ID: 'PUB_KEY_ID_1',
}
const site = { WECHAT_APPID: 'wx123', PUBLIC_BASE_URL: 'https://test.example.com:444/' }

describe('wechatPay config', () => {
  it('uses the fake gateway on staging with an AppID and address but no pay lines', () => {
    expect(wechatPay(site)).toBeNull()
    expect(wechatPay({})).toBeNull()
  })

  it('refuses a partial pay setup', () => {
    expect(() => wechatPay({ ...site, WECHAT_PAY_MCHID: '1900000001' })).toThrow(
      /missing WECHAT_PAY_API_V3_KEY/,
    )
    expect(() => wechatPay(pay)).toThrow(/missing WECHAT_APPID, PUBLIC_BASE_URL/)
  })

  it('reads a full pay setup', () => {
    const config = wechatPay({ ...site, ...pay })
    expect(config?.appId).toBe('wx123')
    expect(config?.notifyBase).toBe('https://test.example.com:444')
    expect(config?.merchantPrivateKey).toContain('\nabc\n')
  })
})
