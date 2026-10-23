import type { Db } from './db/client'
import type { PaymentGateway } from './pay/gateway'

export interface Deps {
  db: Db
  gateway: PaymentGateway
  now: () => Date
  /** Exchanges a wx.login code for the student's openid. */
  wxLogin: (code: string) => Promise<string>
  adminPassword: string
  uploadsDir: string
  log: (message: string, detail?: unknown) => void
}
