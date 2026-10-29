import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import type { Hono, MiddlewareHandler } from 'hono'

/**
 * Headers for every response of a built site. No other site may show these pages in a frame, so
 * a page elsewhere cannot lay the admin under its own buttons; set here rather than in the reverse
 * proxy, so it holds behind any proxy.
 *
 * Pages are checked on every load, so a deploy is seen at once rather than a cached page asking
 * for bundles that are gone; hashed bundles are cached for good; anything else (the manual's
 * screenshots and videos) for an hour. Set after the file is read, since serveStatic builds its
 * response before any header a handler sets.
 */
const siteHeaders: MiddlewareHandler = async (c, next) => {
  await next()
  const headers = c.res.headers
  headers.set('X-Frame-Options', 'DENY')
  headers.set('Content-Security-Policy', "frame-ancestors 'none'")
  if (headers.get('Content-Type')?.startsWith('text/html')) {
    headers.set('Cache-Control', 'no-cache')
  } else if (c.res.status === 200) {
    headers.set(
      'Cache-Control',
      c.req.path.includes('/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=3600',
    )
  }
}

/** Serves a built site under `prefix`. */
function serveBuilt(root: Hono, prefix: string, dir: string) {
  root.use(prefix, siteHeaders)
  root.use(`${prefix}/*`, siteHeaders)
  root.get(prefix, (c) => c.redirect(`${prefix}/`))
  root.use(
    `${prefix}/*`,
    serveStatic({ root: dir, rewriteRequestPath: (path) => path.slice(prefix.length) }),
  )
}

/** The built admin app at /admin/ and the 使用手册 at /help/, for those that are given. */
export function serveSites(root: Hono, dirs: { adminDir?: string; helpDir?: string }) {
  const { adminDir, helpDir } = dirs
  if (adminDir) {
    serveBuilt(root, '/admin', adminDir)
    // Any other page path gets the app; a missing bundle (an old one after a deploy) stays a 404.
    const index = serveStatic({ path: 'index.html', root: adminDir })
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
