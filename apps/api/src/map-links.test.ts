import { describe, expect, it } from 'vitest'
import { setup } from './test/harness'

type Route = { status?: number; location?: string; body?: string }

/** A fetch that answers from a table of URLs, recording what was asked. */
function fakeFetch(routes: Record<string, Route>) {
  const asked: { url: string; ua: string | null; redirect?: string }[] = []
  const fn = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    asked.push({
      url,
      ua: new Headers(init?.headers).get('User-Agent'),
      redirect: init?.redirect,
    })
    const r = routes[url]
    if (!r) return new Response('not found', { status: 404 })
    return new Response(r.body ?? '', {
      status: r.status ?? (r.location ? 302 : 200),
      headers: r.location ? { Location: r.location } : {},
    })
  }) as typeof fetch
  return { fn, asked }
}

async function resolve(routes: Record<string, Route>, url: string) {
  const fake = fakeFetch(routes)
  const h = setup({ mapFetch: fake.fn })
  const admin = await h.admin()
  const res = await h.call('POST', '/admin/map/resolve', { url }, admin)
  return { ...res, asked: fake.asked }
}

describe('map share links', () => {
  it('reads a 高德 short link from its first redirect without opening 高德 pages', async () => {
    const res = await resolve(
      {
        'https://surl.amap.com/4mkKGuyJ2bz': {
          location:
            'https://wb.amap.com/?q=31.222811749011463%2C121.46840706467624%2C%E5%B7%A8%E9%B9%BF%E8%B7%AF&src=app_C3090',
        },
      },
      'https://surl.amap.com/4mkKGuyJ2bz',
    )
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ point: { lat: 31.222812, lng: 121.468407 }, source: 'amap' })
    expect(res.asked).toHaveLength(1)
    expect(res.asked[0]).toMatchObject({ redirect: 'manual' })
    expect(res.asked[0]?.ua).toContain('iPhone')
  })

  it('reads a 百度 short link from the phone page it leads to, in GCJ-02', async () => {
    const page =
      'https://map.baidu.com/mobile/webapp/search/search/qt=inf&uid=435d7aea036e54355abbbcc8/newmap=1&vt=map&da_from=weixin&openna=1'
    const res = await resolve(
      {
        'https://j.map.baidu.com/BkmBk': { location: page },
        [page]: {
          body: '<script>window._OLR={"ipGeo":"1|11590057.96,4489812.75","content":{"loc":{"lng":116.308106,"lat":40.057051}}}</script>',
        },
      },
      'https://j.map.baidu.com/BkmBk',
    )
    expect(res.json).toEqual({ point: { lat: 40.050909, lng: 116.301676 }, source: 'baidu' })
  })

  it('tries the other 百度 phone page when the first one is empty', async () => {
    const uid = 'ecdb75e513cf93e16fa3ccc0'
    const detail = `https://map.baidu.com/mobile/webapp/place/detail/qt=inf&uid=${uid}/shareurl=1&da_from=weixin&openna=1`
    const index = `https://map.baidu.com/mobile/webapp/index/index/qt=inf&uid=${uid}/shareurl=1&da_from=weixin&openna=1`
    const search = `https://map.baidu.com/mobile/webapp/search/search/qt=inf&uid=${uid}/newmap=1&vt=map&da_from=weixin&openna=1`
    const res = await resolve(
      {
        'https://j.map.baidu.com/YwUSO': { location: detail },
        [detail]: { location: index },
        [index]: { body: '{"ipGeo":"1|11590057.96,4489812.75"}' },
        [search]: { body: '{"content":{"point":{"x":13392211,"y":3619117}}}' },
      },
      'https://j.map.baidu.com/YwUSO',
    )
    expect(res.json).toEqual({ point: { lat: 31.060708, lng: 120.296394 }, source: 'baidu' })
  })

  it('says so when a 百度 link leads nowhere, without leaving the map hosts', async () => {
    const res = await resolve(
      { 'https://j.map.baidu.com/x/abc': { location: 'https://wappass.baidu.com/captcha' } },
      'https://j.map.baidu.com/x/abc',
    )
    expect(res.status).toBe(422)
    expect(res.json.error.message).toContain('百度地图')
    expect(res.asked.map((a) => a.url)).toEqual(['https://j.map.baidu.com/x/abc'])
  })

  it('names the app whose link had the point, and tries 百度 pages only for 百度 links', async () => {
    const res = await resolve(
      {
        'https://map.qq.com/s/abc?uid=ecdb75e513cf93e16fa3ccc0': {
          location: 'https://wb.amap.com/?q=39.908692,116.397477',
        },
      },
      'https://map.qq.com/s/abc?uid=ecdb75e513cf93e16fa3ccc0',
    )
    expect(res.json).toEqual({ point: { lat: 39.908692, lng: 116.397477 }, source: 'amap' })
    const none = await resolve({}, 'https://map.qq.com/s/abc?uid=ecdb75e513cf93e16fa3ccc0')
    expect(none.status).toBe(422)
    expect(none.asked.map((a) => a.url)).toEqual([
      'https://map.qq.com/s/abc?uid=ecdb75e513cf93e16fa3ccc0',
    ])
  })

  it('does not follow a redirect off the map hosts or to another port', async () => {
    const res = await resolve(
      {
        'https://surl.amap.com/a': { location: 'https://surl.amap.com:8787/b' },
        'https://surl.amap.com/c': { location: 'https://map.qq.com@127.0.0.1/d' },
      },
      'https://surl.amap.com/a',
    )
    expect(res.status).toBe(422)
    expect(res.asked.map((a) => a.url)).toEqual(['https://surl.amap.com/a'])
    const other = await resolve(
      { 'https://surl.amap.com/c': { location: 'https://map.qq.com@127.0.0.1/d' } },
      'https://surl.amap.com/c',
    )
    expect(other.asked.map((a) => a.url)).toEqual(['https://surl.amap.com/c'])
  })

  it('treats a broken redirect as unreadable', async () => {
    const res = await resolve(
      { 'https://surl.amap.com/bad': { location: 'http://[bad' } },
      'https://surl.amap.com/bad',
    )
    expect(res.status).toBe(422)
  })

  it('reports a page that stops halfway as a network failure', async () => {
    const h = setup({
      mapFetch: (async () =>
        new Response(
          new ReadableStream({
            pull(c) {
              c.error(new Error('reset'))
            },
          }),
        )) as typeof fetch,
    })
    const res = await h.call(
      'POST',
      '/admin/map/resolve',
      {
        url: 'https://map.baidu.com/mobile/webapp/place/detail/qt=inf&uid=ecdb75e513cf93e16fa3ccc0/shareurl=1',
      },
      await h.admin(),
    )
    expect(res.status).toBe(502)
  })

  it('refuses other sites and 高德 place pages without opening them', async () => {
    const other = await resolve({}, 'http://127.0.0.1:8787/api/health')
    expect(other.status).toBe(400)
    expect(other.asked).toEqual([])
    const place = await resolve({}, 'https://www.amap.com/place/B000A83M61')
    expect(place.status).toBe(422)
    expect(place.json.error.message).toContain('高德地图')
    expect(place.asked).toEqual([])
  })

  it('answers a link with coordinates in it without opening it', async () => {
    const res = await resolve(
      {},
      'https://apis.map.qq.com/uri/v1/marker?marker=coord:39.908692,116.397477;title:x&referer=x',
    )
    expect(res.json).toEqual({ point: { lat: 39.908692, lng: 116.397477 }, source: 'tencent' })
    expect(res.asked).toEqual([])
  })

  it('reports a network failure', async () => {
    const h = setup({
      mapFetch: (async () => {
        throw new TypeError('fetch failed')
      }) as typeof fetch,
    })
    const res = await h.call(
      'POST',
      '/admin/map/resolve',
      { url: 'https://surl.amap.com/abc' },
      await h.admin(),
    )
    expect(res.status).toBe(502)
  })

  it('is for staff who manage settings, and hands out the picker key', async () => {
    const h = setup({ tencentMapKey: 'KEY-1' })
    expect((await h.call('POST', '/admin/map/resolve', { url: 'x' })).status).toBe(401)
    const admin = await h.admin()
    expect((await h.call('GET', '/admin/map', undefined, admin)).json).toEqual({
      tencentKey: 'KEY-1',
    })
  })
})
