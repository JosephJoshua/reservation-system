/**
 * Venue coordinates from map share links. wx.openLocation takes GCJ-02, which 高德 and 腾讯地图
 * use. 百度地图 uses BD-09, and its links and pages often give Baidu Mercator (BD-09MC) instead.
 *
 * Link formats, checked against the apps' real share links in October 2026:
 * - 高德 app (iOS and Android): https://surl.amap.com/xxxx, whose first redirect goes to
 *   wb.amap.com/?q=lat,lng,name or wb.amap.com/?p=poiid,lat,lng,name. Web: www.amap.com/regeo?lng=&lat=,
 *   uri.amap.com/marker?position=lng,lat. Place pages (amap.com/place/B0…) carry no coordinates.
 * - 百度 app: https://j.map.baidu.com/xx/xxxx, which redirects to a place page by uid. A phone
 *   browser often, not always, gets that page with the place in it. Web: map.baidu.com/poi/名称/@x,y,zoom.
 * - 腾讯地图: apis.map.qq.com/uri/v1/marker?marker=coord:lat,lng, which redirects to
 *   map.qq.com/?pointx=lng&pointy=lat.
 */

export interface LatLng {
  lat: number
  lng: number
}

export type MapSource = 'amap' | 'tencent' | 'baidu' | 'text'
export type MapApp = Exclude<MapSource, 'text'>

/** What a map link gives. */
export type MapLinkParse =
  /** Coordinates, already in GCJ-02. */
  | { kind: 'point'; point: LatLng; source: MapApp }
  /** A link that leads to coordinates, such as a short link: the server opens it. */
  | { kind: 'open'; url: string; source: MapApp }
  /** A map link with no way to coordinates, such as a 高德 place page. */
  | { kind: 'none'; source: MapApp }

/** What pasted text gives: a map link's result, or plain coordinates. */
export type MapParse = MapLinkParse | { kind: 'point'; point: LatLng; source: 'text' }

export const mapAppLabels: Record<MapApp, string> = {
  amap: '高德地图',
  tencent: '腾讯地图',
  baidu: '百度地图',
}

/** A rough box around China. Latitudes and longitudes in it never overlap, so order is known. */
const isLat = (n: number) => n >= 3.8 && n <= 53.6
const isLng = (n: number) => n >= 73.5 && n <= 135.1

export function inChina(p: LatLng) {
  return isLat(p.lat) && isLng(p.lng)
}

// GCJ-02 offsets, as published with the eviltransform and gcoord libraries.
const A = 6378245
const EE = 0.006693421622965943

export function wgs84ToGcj02(p: LatLng): LatLng {
  if (!inChina(p)) return p
  const x = p.lng - 105
  const y = p.lat - 35
  let dLat =
    -100 +
    2 * x +
    3 * y +
    0.2 * y * y +
    0.1 * x * y +
    0.2 * Math.sqrt(Math.abs(x)) +
    ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3 +
    ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3 +
    ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) * 2) / 3
  let dLng =
    300 +
    x +
    2 * y +
    0.1 * x * x +
    0.1 * x * y +
    0.1 * Math.sqrt(Math.abs(x)) +
    ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3 +
    ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3 +
    ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) * 2) / 3
  const radLat = (p.lat / 180) * Math.PI
  const magic = 1 - EE * Math.sin(radLat) ** 2
  const sqrtMagic = Math.sqrt(magic)
  dLat = (dLat * 180) / (((A * (1 - EE)) / (magic * sqrtMagic)) * Math.PI)
  dLng = (dLng * 180) / ((A / sqrtMagic) * Math.cos(radLat) * Math.PI)
  return { lat: p.lat + dLat, lng: p.lng + dLng }
}

const BD_PI = (Math.PI * 3000) / 180

export function bd09ToGcj02(p: LatLng): LatLng {
  const x = p.lng - 0.0065
  const y = p.lat - 0.006
  const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * BD_PI)
  const theta = Math.atan2(y, x) - 0.000003 * Math.cos(x * BD_PI)
  return { lat: z * Math.sin(theta), lng: z * Math.cos(theta) }
}

// Baidu Mercator to BD-09, by latitude band, from Baidu's map API.
const MC_BANDS = [12890594.86, 8362377.87, 5591021, 3481989.83, 1678043.12, 0]
const MC_TO_LL = [
  [
    1.410526172116255e-8, 0.00000898305509648872, -1.9939833816331, 200.9824383106796,
    -187.2403703815547, 91.6087516669843, -23.38765649603339, 2.57121317296198, -0.03801003308653,
    17337981.2,
  ],
  [
    -7.435856389565537e-9, 0.000008983055097726239, -0.78625201886289, 96.32687599759846,
    -1.85204757529826, -59.36935905485877, 47.40033549296737, -16.50741931063887, 2.28786674699375,
    10260144.86,
  ],
  [
    -3.030883460898826e-8, 0.00000898305509983578, 0.30071316287616, 59.74293618442277,
    7.357984074871, -25.38371002664745, 13.45380521110908, -3.29883767235584, 0.32710905363475,
    6856817.37,
  ],
  [
    -1.981981304930552e-8, 0.000008983055099779535, 0.03278182852591, 40.31678527705744,
    0.65659298677277, -4.44255534477492, 0.85341911805263, 0.12923347998204, -0.04625736007561,
    4482777.06,
  ],
  [
    3.09191371068437e-9, 0.000008983055096812155, 0.00006995724062, 23.10934304144901,
    -0.00023663490511, -0.6321817810242, -0.00663494467273, 0.03430082397953, -0.00466043876332,
    2555164.4,
  ],
  [
    2.890871144776878e-9, 0.000008983055095805407, -3.068298e-8, 7.47137025468032,
    -0.00000353937994, -0.02145144861037, -0.00001234426596, 0.00010322952773, -0.00000323890364,
    826088.5,
  ],
]

/** Baidu Mercator x (east) and y (north) to BD-09. */
export function bd09mcToBd09(x: number, y: number): LatLng {
  const band = MC_BANDS.findIndex((b) => Math.abs(y) >= b)
  const c = MC_TO_LL[band] as number[]
  const t = Math.abs(y) / (c[9] as number)
  let lat = 0
  for (let i = 0; i <= 6; i++) lat += (c[2 + i] as number) * t ** i
  const lng = (c[0] as number) + (c[1] as number) * Math.abs(x)
  return { lat: lat * Math.sign(y), lng: lng * Math.sign(x) }
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6

/** Rounded to six decimals, about 0.1 m. */
export function roundPoint(p: LatLng): LatLng {
  return { lat: round6(p.lat), lng: round6(p.lng) }
}

/** Rounded, or null outside China. */
function inRange(p: LatLng | null): LatLng | null {
  if (!p) return null
  const point = roundPoint(p)
  return inChina(point) ? point : null
}

export function mapAppOf(host: string): MapApp | null {
  const h = host.toLowerCase()
  const under = (domain: string) => h === domain || h.endsWith(`.${domain}`)
  if (under('amap.com') || under('autonavi.com')) return 'amap'
  if (under('map.qq.com')) return 'tencent'
  if (under('map.baidu.com')) return 'baidu'
  return null
}

function decode(text: string) {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '))
  } catch {
    return text
  }
}

interface Link {
  host: string
  path: string
  params: Map<string, string>
}

/** Splits a link without URL, which the mini program bundle of this package has no use for. */
export function splitLink(raw: string): Link | null {
  // The host must end at a path, query or port, so userinfo (a@b) and backslash tricks fail.
  const m = /^(?:https?:)?\/\/([^/?#:\\@]+)(?::\d+)?(?=[/?#]|$)([^?#]*)(?:\?([^#]*))?/i.exec(
    raw.trim(),
  )
  if (!m) return null
  const params = new Map<string, string>()
  for (const part of (m[3] ?? '').split('&')) {
    const at = part.indexOf('=')
    if (at <= 0) continue
    const key = decode(part.slice(0, at))
    if (!params.has(key)) params.set(key, decode(part.slice(at + 1)))
  }
  return { host: (m[1] as string).toLowerCase(), path: decode(m[2] ?? ''), params }
}

const NUM = String.raw`-?\d{1,3}\.\d+`
// In link parameters whole degrees are fine too; in free text they are too easily something else.
const PARAM_NUM = String.raw`-?\d{1,3}(?:\.\d+)?`

/** A latitude and longitude pair at the start of a value, in either order. */
function pairAt(value: string | undefined, order: 'latlng' | 'lnglat' | 'any'): LatLng | null {
  if (!value) return null
  const m = new RegExp(`^\\s*(${PARAM_NUM})\\s*[,，\\s]\\s*(${PARAM_NUM})`).exec(value)
  if (!m) return null
  const a = Number(m[1])
  const b = Number(m[2])
  if (order !== 'lnglat' && isLat(a) && isLng(b)) return { lat: a, lng: b }
  if (order !== 'latlng' && isLng(a) && isLat(b)) return { lat: b, lng: a }
  return null
}

function numberParam(params: Map<string, string>, ...keys: string[]) {
  for (const k of keys) {
    const v = params.get(k)
    if (v != null && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  }
  return Number.NaN
}

function amapPoint({ params }: Link): LatLng | null {
  const p = params.get('p')?.split(',')
  const found =
    pairAt(params.get('q'), 'latlng') ??
    (p && p.length >= 3 ? pairAt(`${p[1]},${p[2]}`, 'latlng') : null) ??
    pairAt(params.get('position'), 'lnglat') ??
    pairAt(params.get('location'), 'lnglat') ??
    pairAt(params.get('lnglat'), 'lnglat') ??
    pairAt(`${numberParam(params, 'lat')},${numberParam(params, 'lng', 'lon')}`, 'latlng')
  if (!found) return null
  const wgs = params.get('coordinate') === 'wgs84' || params.get('dev') === '1'
  return wgs ? wgs84ToGcj02(found) : found
}

function tencentPoint({ params }: Link): LatLng | null {
  const marker = /coord:([^;]+)/.exec(params.get('marker') ?? '')?.[1]
  const found =
    pairAt(marker, 'latlng') ??
    pairAt(`${numberParam(params, 'pointy')},${numberParam(params, 'pointx')}`, 'latlng') ??
    pairAt(params.get('coord'), 'latlng') ??
    pairAt(params.get('latlng'), 'latlng') ??
    pairAt(`${numberParam(params, 'lat')},${numberParam(params, 'lng')}`, 'latlng')
  if (!found) return null
  // In the 腾讯 URI API, coord_type 1 is GPS (WGS-84); the default 2 is GCJ-02.
  return params.get('coord_type') === '1' ? wgs84ToGcj02(found) : found
}

const MC = String.raw`(\d{6,8}(?:\.\d+)?)`

function baiduPoint({ path, params }: Link): LatLng | null {
  // Mercator: a place page /poi/名称/@x,y,zoomz, or a phone page's sharegeo=x,y. Other pages'
  // @x,y is only where the map was looking.
  const mc =
    (path.startsWith('/poi/') ? new RegExp(`/@${MC},${MC}`).exec(path) : null) ??
    new RegExp(`^${MC},${MC}$`).exec(params.get('sharegeo') ?? '') ??
    // Phone pages keep their parameters in the path: /mobile/webapp/…/openna=1&sharegeo=x,y
    new RegExp(`[/&]sharegeo=${MC},${MC}`).exec(path)
  if (mc) return bd09ToGcj02(bd09mcToBd09(Number(mc[1]), Number(mc[2])))
  // The URI API: location=lat,lng, BD-09 unless coord_type says otherwise.
  const found = pairAt(params.get('location'), 'latlng')
  if (!found) return null
  const type = params.get('coord_type') ?? 'bd09ll'
  if (type === 'gcj02') return found
  if (type === 'wgs84') return wgs84ToGcj02(found)
  return bd09ToGcj02(found)
}

const POINT_OF: Record<MapApp, (link: Link) => LatLng | null> = {
  amap: amapPoint,
  tencent: tencentPoint,
  baidu: baiduPoint,
}

/** Whether the server can get coordinates by opening a link that has none in it. */
function worthOpening(source: MapApp, { host, path, params }: Link) {
  if (source === 'amap') return host === 'surl.amap.com'
  if (source === 'baidu') {
    return (
      host === 'j.map.baidu.com' ||
      params.has('poiShareUid') ||
      params.has('poiShareId') ||
      params.has('uid') ||
      /uid[=%]/.test(params.get('s') ?? '') ||
      path.startsWith('/mobile/webapp/')
    )
  }
  // No 腾讯 app short link format is known, so 腾讯 links are worth a look at their redirects,
  // except the URI API's routes and searches, which lead to no one place.
  return !/^\/uri\/v1\/(?!marker)/.test(path)
}

/** Coordinates in one map link, or what to do with it. Null when the link is not a map link. */
export function parseMapLink(raw: string): MapLinkParse | null {
  const link = splitLink(raw)
  const source = link && mapAppOf(link.host)
  if (!link || !source) return null
  const point = inRange(POINT_OF[source](link))
  if (point) return { kind: 'point', point, source }
  return worthOpening(source, link)
    ? { kind: 'open', url: raw.trim(), source }
    : { kind: 'none', source }
}

const URL_RE = /https?:\/\/[^\s"'<>，。、【】（）()]+/gi

/**
 * Reads what an admin pasted: share text or a link from 高德, 腾讯地图 or 百度地图, or plain
 * coordinates, taken as GCJ-02. Null when nothing usable is in it.
 */
export function parseMapText(text: string): MapParse | null {
  let fallback: MapParse | null = null
  for (const match of text.match(URL_RE) ?? []) {
    // A link at the end of a sentence keeps the sentence's full stop.
    const raw = match.replace(/[.,;:!?]+$/, '')
    const result = parseMapLink(raw)
    if (result?.kind === 'point') return result
    if (result && (!fallback || (fallback.kind === 'none' && result.kind === 'open'))) {
      fallback = result
    }
  }
  if (fallback?.kind === 'open') return fallback
  const rest = text.replace(URL_RE, ' ')
  const m = new RegExp(`(${NUM})[^\\d.-]{1,8}?(${NUM})`).exec(rest)
  const point = inRange(m ? pairAt(`${m[1]},${m[2]}`, 'any') : null)
  return point ? { kind: 'point', point, source: 'text' } : fallback
}

/**
 * The place in a 百度 phone page that a share link led to. The pages also hold the viewer's own
 * rough location, under ipGeo and current_city, which must not be taken for the place.
 */
export function pointInBaiduPage(body: string): LatLng | null {
  const loc = new RegExp(`"loc":\\{"lng":(${NUM}),"lat":(${NUM})\\}`).exec(body)
  if (loc) return inRange(bd09ToGcj02({ lat: Number(loc[2]), lng: Number(loc[1]) }))
  const viewer = new Set(
    [
      ...body.matchAll(new RegExp(`"ipGeo":"1\\|${MC},${MC}`, 'g')),
      ...body.matchAll(new RegExp(`"current_city":\\{[^}]*?"geo":"1\\|${MC},${MC}`, 'g')),
    ].map((m) => `${m[1]},${m[2]}`),
  )
  const point = [
    ...body.matchAll(new RegExp(`"point":\\{"x":"?${MC}"?,"y":"?${MC}"?\\}`, 'g')),
  ].find((m) => !viewer.has(`${m[1]},${m[2]}`))
  const geo = [...body.matchAll(new RegExp(`[{,]"geo":"1\\|${MC},${MC}`, 'g'))].find(
    (m) => !viewer.has(`${m[1]},${m[2]}`),
  )
  const mc = point ?? geo
  return mc ? inRange(bd09ToGcj02(bd09mcToBd09(Number(mc[1]), Number(mc[2])))) : null
}

/** Opens the point on 高德's web map, to check it. Needs no key. */
export function amapMarkerUrl(p: LatLng, name: string) {
  const q = [
    `position=${p.lng},${p.lat}`,
    `name=${encodeURIComponent(name || '场馆位置')}`,
    'coordinate=gaode',
    'callnative=0',
  ]
  return `https://uri.amap.com/marker?${q.join('&')}`
}
