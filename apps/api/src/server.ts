import { serve } from '@hono/node-server'
import { createApp } from './app'
import { config } from './config'
import { openDb } from './db/client'
import { runMigrations } from './db/migrate'
import type { Deps } from './deps'
import { FakeGateway } from './pay/fake'
import { WechatPayGateway } from './pay/wechat'
import { startSweeper } from './sweeper'
import { devLogin, wechatLogin } from './wx'

const db = openDb(config.databasePath)
runMigrations(db)

const deps: Deps = {
  db,
  gateway: config.wechatPay ? new WechatPayGateway(config.wechatPay) : new FakeGateway(),
  now: () => new Date(),
  wxLogin:
    config.wechatAppId && config.wechatAppSecret
      ? wechatLogin(config.wechatAppId, config.wechatAppSecret)
      : devLogin,
  adminPassword: config.adminPassword,
  uploadsDir: config.uploadsDir,
  log: (message, detail) => console.error(`[api] ${message}`, detail ?? ''),
}

if (deps.gateway.fake) console.warn('[api] WeChat Pay not configured: using the fake gateway')
startSweeper(deps)

serve({ fetch: createApp(deps).fetch, port: config.port }, (info) => {
  console.log(`api listening on http://localhost:${info.port}`)
})
