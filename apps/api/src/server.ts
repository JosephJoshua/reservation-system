import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { CHECK_IN_PATH } from '@rs/shared'
import { Hono } from 'hono'
import { createApp } from './app'
import { config } from './config'
import { openDb } from './db/client'
import { runMigrations } from './db/migrate'
import type { Deps } from './deps'
import { FakeGateway } from './pay/fake'
import { WechatPayGateway } from './pay/wechat'
import { ensureFirstStaff } from './services/staff'
import { startSweeper } from './sweeper'
import { devLogin, wechatAccessToken, wechatLogin, wechatMiniCode } from './wx'
import { logNotifier, wechatNotifier } from './wx-notify'

const db = openDb(config.databasePath)
runMigrations(db)
ensureFirstStaff(db, config.adminPassword)

const log = (message: string, detail?: unknown) => console.error(`[api] ${message}`, detail ?? '')

const wechat =
  config.wechatAppId && config.wechatAppSecret
    ? wechatAccessToken(config.wechatAppId, config.wechatAppSecret)
    : null

const deps: Deps = {
  db,
  gateway: config.wechatPay ? new WechatPayGateway(config.wechatPay) : new FakeGateway(),
  now: () => new Date(),
  wxLogin:
    config.wechatAppId && config.wechatAppSecret
      ? wechatLogin(config.wechatAppId, config.wechatAppSecret)
      : devLogin,
  uploadsDir: config.uploadsDir,
  log,
  notifier: wechat
    ? wechatNotifier({ accessToken: wechat, ...config.notices })
    : logNotifier(config.notices.templates, log),
  miniCode: wechat ? wechatMiniCode(wechat, config.notices.state) : undefined,
}

if (deps.gateway.fake) console.warn('[api] WeChat Pay not configured: using the fake gateway')
const stopSweeper = startSweeper(deps)

// In a deployment the API also serves the built admin app, so one container holds one environment.
const root = new Hono()
if (config.adminDir) {
  const adminDir = config.adminDir
  root.get('/admin', (c) => c.redirect('/admin/'))
  // Hashed bundles are cached for good; index.html is checked on every load.
  root.use(
    '/admin/*',
    serveStatic({
      root: adminDir,
      rewriteRequestPath: (path) => path.replace(/^\/admin/, ''),
      onFound: (path, c) =>
        c.header(
          'Cache-Control',
          path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
        ),
    }),
  )
  // Any other page path gets the app; a missing bundle (an old one after a deploy) stays a 404.
  const index = serveStatic({
    path: 'index.html',
    root: adminDir,
    onFound: (_path, c) => c.header('Cache-Control', 'no-cache'),
  })
  root.use('/admin/*', async (c, next) => {
    if (c.req.path.startsWith('/admin/assets/')) return c.notFound()
    return index(c, next)
  })
  root.get('/', (c) => c.redirect('/admin/'))
}
// The venue's printed 签到码 links here. WeChat opens the mini program for it once the link is set
// up under 扫普通链接二维码打开小程序; any other scanner lands on this note.
root.get(CHECK_IN_PATH, (c) =>
  c.html(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>签到</title><p style="font:17px/1.6 system-ui,sans-serif;text-align:center;margin-top:30vh;padding:0 16px">请打开微信小程序，在“课程”页点“扫码签到”</p>',
  ),
)
const check = config.wechatLinkCheck
if (check) root.get(`/${check.name}`, (c) => c.text(check.content))
const api = createApp(deps)
root.all('/api/*', (c) => api.fetch(c.req.raw, c.env))

const server = serve({ fetch: root.fetch, port: config.port }, (info) => {
  console.log(`api listening on http://localhost:${info.port}`)
})

// A deploy stops the container with SIGTERM: finish open requests and the sweep in progress (for
// at most a few seconds, since a sweep waits on WeChat), then close the database so SQLite folds
// its write-ahead log back into the file.
process.on('SIGTERM', () => {
  setTimeout(() => process.exit(1), 8000).unref()
  const closed = new Promise((resolve) => server.close(resolve))
  if ('closeIdleConnections' in server) server.closeIdleConnections()
  const swept = Promise.race([
    stopSweeper().then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 4000)),
  ]).then((done) => {
    if (!done) deps.log('shutdown: sweep still running, closing anyway')
  })
  Promise.all([closed, swept]).then(() => {
    db.$client.close()
    process.exit(0)
  })
})
