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

/** WeChat Pay settings, or null for the fake gateway when no WECHAT_PAY_* key is set. */
export function wechatPay(env: NodeJS.ProcessEnv): WechatPayConfig | null {
  const keys = [
    'WECHAT_PAY_MCHID',
    'WECHAT_PAY_API_V3_KEY',
    'WECHAT_PAY_MERCHANT_SERIAL',
    'WECHAT_PAY_MERCHANT_PRIVATE_KEY',
    'WECHAT_PAY_PUBLIC_KEY',
    'WECHAT_PAY_PUBLIC_KEY_ID',
  ] as const
  // Staging sets the AppID and its address without a merchant account, so they don't count here.
  if (keys.every((k) => !env[k])) return null
  const missing = [...keys, 'WECHAT_APPID', 'PUBLIC_BASE_URL'].filter((k) => !env[k])
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

/** Only used to create the first staff login, `admin`, on an empty database. */
function adminPassword() {
  return env.ADMIN_PASSWORD || (production ? undefined : 'admin')
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
      coach_moved: parseTemplate(env.WECHAT_NOTICE_COACH_MOVED),
      student_booked: parseTemplate(env.WECHAT_NOTICE_STUDENT_BOOKED),
      student_cancelled: parseTemplate(env.WECHAT_NOTICE_STUDENT_CANCELLED),
      student_reminder: parseTemplate(env.WECHAT_NOTICE_STUDENT_REMINDER),
      student_moved: parseTemplate(env.WECHAT_NOTICE_STUDENT_MOVED),
      student_feedback: parseTemplate(env.WECHAT_NOTICE_STUDENT_FEEDBACK),
      student_package: parseTemplate(env.WECHAT_NOTICE_STUDENT_PACKAGE),
    },
  }
}

function linkCheck(value: string | undefined) {
  const m = /^([\w-]+\.txt)=(\S+)$/.exec(value?.trim() ?? '')
  return m ? { name: m[1] as string, content: m[2] as string } : null
}

export const config = {
  production,
  port: Number(env.PORT ?? 8787),
  databasePath: env.DATABASE_PATH ?? 'data/dev.db',
  uploadsDir: env.UPLOADS_DIR ?? 'data/uploads',
  /** Built admin app to serve at /admin/; unset in development, where Vite serves it. */
  adminDir: env.ADMIN_DIR,
  /** Built 使用手册 (apps/docs) to serve at /help/; unset in development, where VitePress serves it. */
  helpDir: env.HELP_DIR,
  adminPassword: adminPassword(),
  wechatAppId: env.WECHAT_APPID,
  wechatAppSecret: env.WECHAT_APP_SECRET,
  /**
   * The check file WeChat asks for before 扫普通链接二维码打开小程序 opens the mini program from the
   * venue's 签到码, as `name.txt=content`.
   */
  wechatLinkCheck: linkCheck(env.WECHAT_LINK_CHECK),
  /** 腾讯位置服务 key for the admin's map picker; without it admins paste links or coordinates. */
  tencentMapKey: env.TENCENT_MAP_KEY || undefined,
  wechatPay: wechatPay(env),
  notices: notices(),
  /** WeCom group robot told when backups stop; production only, as staging is not backed up. */
  alertWebhook: env.ALERT_WEBHOOK || undefined,
}

if (production && (!config.wechatPay || !config.wechatAppSecret)) {
  throw new Error('WeChat login and WeChat Pay must be configured in production')
}
