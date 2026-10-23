import { readFileSync } from 'node:fs'
import type { WechatPayConfig } from './pay/wechat'
import { parseTemplate } from './wx-notify'

const env = process.env
const production = env.NODE_ENV === 'production'

/** Reads a PEM given inline or as a file path. */
function pem(value: string | undefined) {
  if (!value) return undefined
  return value.includes('-----BEGIN') ? value.replace(/\\n/g, '\n') : readFileSync(value, 'utf8')
}

function wechatPay(): WechatPayConfig | null {
  const keys = [
    'WECHAT_APPID',
    'WECHAT_PAY_MCHID',
    'WECHAT_PAY_API_V3_KEY',
    'WECHAT_PAY_MERCHANT_SERIAL',
    'WECHAT_PAY_MERCHANT_PRIVATE_KEY',
    'WECHAT_PAY_PUBLIC_KEY',
    'WECHAT_PAY_PUBLIC_KEY_ID',
    'PUBLIC_BASE_URL',
  ] as const
  const missing = keys.filter((k) => !env[k])
  if (missing.length === keys.length) return null
  if (missing.length > 0)
    throw new Error(`WeChat Pay config incomplete, missing ${missing.join(', ')}`)
  return {
    appId: env.WECHAT_APPID as string,
    mchId: env.WECHAT_PAY_MCHID as string,
    apiV3Key: env.WECHAT_PAY_API_V3_KEY as string,
    merchantSerial: env.WECHAT_PAY_MERCHANT_SERIAL as string,
    merchantPrivateKey: pem(env.WECHAT_PAY_MERCHANT_PRIVATE_KEY) as string,
    platformPublicKey: pem(env.WECHAT_PAY_PUBLIC_KEY) as string,
    platformPublicKeyId: env.WECHAT_PAY_PUBLIC_KEY_ID as string,
    notifyBase: (env.PUBLIC_BASE_URL as string).replace(/\/$/, ''),
  }
}

function adminPassword() {
  if (env.ADMIN_PASSWORD) return env.ADMIN_PASSWORD
  if (production) throw new Error('ADMIN_PASSWORD is required in production')
  return 'admin'
}

function notices() {
  // Which build of the mini program a tapped message opens.
  const states = ['developer', 'trial', 'formal'] as const
  const state = states.find((s) => s === (env.WECHAT_MINIPROGRAM_STATE ?? 'formal'))
  if (!state) throw new Error('WECHAT_MINIPROGRAM_STATE must be developer, trial or formal')
  return {
    state,
    templates: {
      coach_booked: parseTemplate(env.WECHAT_NOTICE_COACH_BOOKED),
      coach_cancelled: parseTemplate(env.WECHAT_NOTICE_COACH_CANCELLED),
      student_booked: parseTemplate(env.WECHAT_NOTICE_STUDENT_BOOKED),
      student_cancelled: parseTemplate(env.WECHAT_NOTICE_STUDENT_CANCELLED),
      student_reminder: parseTemplate(env.WECHAT_NOTICE_STUDENT_REMINDER),
      student_moved: parseTemplate(env.WECHAT_NOTICE_STUDENT_MOVED),
      student_feedback: parseTemplate(env.WECHAT_NOTICE_STUDENT_FEEDBACK),
    },
  }
}

export const config = {
  production,
  port: Number(env.PORT ?? 8787),
  databasePath: env.DATABASE_PATH ?? 'data/dev.db',
  uploadsDir: env.UPLOADS_DIR ?? 'data/uploads',
  /** Built admin app to serve at /admin/; unset in development, where Vite serves it. */
  adminDir: env.ADMIN_DIR,
  adminPassword: adminPassword(),
  wechatAppId: env.WECHAT_APPID,
  wechatAppSecret: env.WECHAT_APP_SECRET,
  wechatPay: wechatPay(),
  notices: notices(),
}

if (production && (!config.wechatPay || !config.wechatAppSecret)) {
  throw new Error('WeChat login and WeChat Pay must be configured in production')
}
