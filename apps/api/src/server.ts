import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { createApp } from './app'
import { config } from './config'
import { openDb } from './db/client'
import { runMigrations } from './db/migrate'
import type { Deps } from './deps'
import { FakeGateway } from './pay/fake'
import { WechatPayGateway } from './pay/wechat'
import { startSweeper } from './sweeper'
import { devLogin, wechatLogin } from './wx'
import { wechatNotifier } from './wx-notify'

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
  notifier:
    config.wechatAppId && config.wechatAppSecret
      ? wechatNotifier({
          appId: config.wechatAppId,
          secret: config.wechatAppSecret,
          ...config.notices,
        })
      : undefined,
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
  const swept = Promise.race([stopSweeper(), new Promise((resolve) => setTimeout(resolve, 4000))])
  Promise.all([closed, swept]).then(() => {
    db.$client.close()
    process.exit(0)
  })
})
