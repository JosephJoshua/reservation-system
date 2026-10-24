import type { Db } from './db/client'
import type { PaymentGateway } from './pay/gateway'
import type { MiniCode } from './wx'
import type { Notifier } from './wx-notify'

export interface Deps {
  db: Db
  gateway: PaymentGateway
  now: () => Date
  /** Exchanges a wx.login code for the student's openid. */
  wxLogin: (code: string) => Promise<string>
  uploadsDir: string
  log: (message: string, detail?: unknown) => void
  /** Subscription messages to coaches and students; left out when WeChat is not configured. */
  notifier?: Notifier
  /** Mini program codes for the front desk to show; left out when WeChat is not configured. */
  miniCode?: MiniCode
  /** Opens map share links for the admin's 地图坐标; left out in tests that do not stub it. */
  mapFetch?: typeof fetch
  /** 腾讯位置服务 key for the admin's map picker. */
  tencentMapKey?: string
}
