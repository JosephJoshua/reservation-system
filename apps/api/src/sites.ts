import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import type { Hono, MiddlewareHandler } from 'hono'

/**
 * No other site may show these pages in a frame, so a page elsewhere cannot lay the admin under
 * its own buttons. Set here rather than in the reverse proxy, so it holds behind any proxy.
 */
const noFraming: MiddlewareHandler = async (c, next) => {
  await next()
  c.res.headers.set('X-Frame-Options', 'DENY')
  c.res.headers.set('Content-Security-Policy', "frame-ancestors 'none'")
}

/**
 * Serves a built site under `prefix`. Hashed bundles are cached for good; pages are checked on
 * every load; anything else (the manual's screenshots and videos) for an hour.
 */
function serveBuilt(root: Hono, prefix: string, dir: string) {
  root.use(prefix, noFraming)
  root.use(`${prefix}/*`, noFraming)
  root.get(prefix, (c) => c.redirect(`${prefix}/`))
  root.use(
    `${prefix}/*`,
    serveStatic({
      root: dir,
      rewriteRequestPath: (path) => path.slice(prefix.length),
      onFound: (path, c) =>
        c.header(
          'Cache-Control',
          path.includes('/assets/')
            ? 'public, max-age=31536000, immutable'
            : path.endsWith('.html')
              ? 'no-cache'
              : 'public, max-age=3600',
        ),
    }),
  )
}

/** The built admin app at /admin/ and the 使用手册 at /help/, for those that are given. */
export function serveSites(root: Hono, dirs: { adminDir?: string; helpDir?: string }) {
  const { adminDir, helpDir } = dirs
  if (adminDir) {
    serveBuilt(root, '/admin', adminDir)
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
  // The 使用手册, a static VitePress site. Pages link to each other as .html files, so a missing
  // path gets the site's own 404 page.
  if (helpDir) {
    serveBuilt(root, '/help', helpDir)
    const notFoundFile = join(helpDir, '404.html')
    const notFound = existsSync(notFoundFile) ? readFileSync(notFoundFile, 'utf8') : null
    root.use('/help/*', async (c) => (notFound ? c.html(notFound, 404) : c.notFound()))
  }
}
