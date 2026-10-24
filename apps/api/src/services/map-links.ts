import {
  type LatLng,
  type MapApp,
  mapAppLabels,
  mapAppOf,
  parseMapLink,
  pointInBaiduPage,
  splitLink,
} from '@rs/shared'
import { ApiError } from '../errors'

const MAX_HOPS = 6
const TIMEOUT_MS = 8000
const MAX_BODY = 2_000_000
// A phone browser: 百度 sends desktop browsers to a page that has no place in it.
const USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1'

async function readCapped(res: Response) {
  const reader = res.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  while (size < MAX_BODY) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.length
  }
  await reader.cancel().catch(() => {})
  return Buffer.concat(chunks).toString('utf8')
}

function unreadable(source: MapApp) {
  const app = mapAppLabels[source]
  return new ApiError(
    422,
    'map_link_unreadable',
    source === 'baidu'
      ? `没能从这个${app}链接读到位置，请改用高德地图的分享链接，或在地图上选点`
      : `没能从这个${app}链接读到位置，请在地图上选点，或直接粘贴坐标`,
  )
}

const failed = () =>
  new ApiError(502, 'map_link_failed', '暂时打不开这个链接，请稍后再试，或在地图上选点')

/** The place id in a 百度 link, in any of the forms its share links take. */
function baiduUid(url: string) {
  return /(?:uid|poiShareUid|poiShareId)(?:=|%3D)([0-9a-z]{20,30})/i.exec(url)?.[1]
}

/** 百度 phone pages for a place id. Which of them has the place in it varies by place. */
const baiduPages = (uid: string) => [
  `https://map.baidu.com/mobile/webapp/search/search/qt=inf&uid=${uid}/newmap=1&vt=map&da_from=weixin&openna=1`,
  `https://map.baidu.com/mobile/webapp/place/detail/qt=inf&uid=${uid}/shareurl=1&da_from=weixin&openna=1`,
]

/**
 * Follows a map share link that has no coordinates in it, one redirect at a time, until a
 * redirect or a 百度 place page gives them. Only map hosts are opened.
 */
export async function resolveMapLink(
  url: string,
  fetchFn: typeof fetch,
): Promise<{ point: LatLng; source: MapApp }> {
  const first = parseMapLink(url)
  if (!first) throw new ApiError(400, 'not_map_link', '请粘贴高德、腾讯或百度地图的链接')
  if (first.kind === 'point') return { point: first.point, source: first.source as MapApp }
  if (first.kind === 'none') throw unreadable(first.source)

  const source = first.source
  const deadline = AbortSignal.timeout(TIMEOUT_MS)
  const tried = new Set<string>()
  let uid = baiduUid(first.url)
  const found = await follow(first.url)
  if (found) return found
  // The redirects ended on a page without the place: try the other 百度 phone pages.
  for (const page of source === 'baidu' && uid ? baiduPages(uid) : []) {
    if (tried.has(page)) continue
    const point = await follow(page)
    if (point) return point
  }
  throw unreadable(source)

  async function follow(start: string): Promise<{ point: LatLng; source: MapApp } | null> {
    let current = start
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      tried.add(current)
      // Checked on the URL as fetch will read it, not only as the parser reads it.
      let target: URL
      try {
        target = new URL(current)
      } catch {
        break
      }
      const app = mapAppOf(target.hostname)
      const link = splitLink(current)
      if (!app || !link || link.host !== target.hostname || !/^https?:$/.test(target.protocol)) {
        break
      }
      if (target.port || target.username || target.password) break
      let res: Response
      try {
        res = await fetchFn(target.toString(), {
          redirect: 'manual',
          signal: deadline,
          headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,*/*' },
        })
      } catch {
        throw failed()
      }
      const location = res.headers.get('location')
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel().catch(() => {})
        current = new URL(location, current).toString()
        uid ??= baiduUid(current)
        const next = parseMapLink(current)
        if (next?.kind === 'point') return { point: next.point, source: next.source as MapApp }
        if (!next || next.kind === 'none') break
        continue
      }
      // Only 百度 phone pages hold the place itself; other map pages only show the viewer's area.
      if (res.ok && app === 'baidu' && link.path.startsWith('/mobile/webapp/')) {
        let body: string
        try {
          body = await readCapped(res)
        } catch {
          throw failed()
        }
        const point = pointInBaiduPage(body)
        if (point) return { point, source: 'baidu' }
      } else {
        await res.body?.cancel().catch(() => {})
      }
      break
    }
    return null
  }
}
