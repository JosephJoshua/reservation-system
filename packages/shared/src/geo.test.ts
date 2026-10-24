import { describe, expect, it } from 'vitest'
import {
  amapMarkerUrl,
  bd09mcToBd09,
  bd09ToGcj02,
  type LatLng,
  parseMapLink,
  parseMapText,
  pointInBaiduPage,
  wgs84ToGcj02,
} from './geo'

/** Within about 1 m of the expected point. */
function near(actual: LatLng | null | undefined, lat: number, lng: number) {
  expect(actual).toBeTruthy()
  expect(Math.abs((actual as LatLng).lat - lat)).toBeLessThan(0.00001)
  expect(Math.abs((actual as LatLng).lng - lng)).toBeLessThan(0.00001)
}

function pointOf(text: string) {
  const r = parseMapText(text)
  if (r?.kind !== 'point') throw new Error(`no point in ${text}: ${JSON.stringify(r)}`)
  return r
}

// Expected values from the gcoord library.
describe('coordinate systems', () => {
  it('converts WGS-84 to GCJ-02', () => {
    near(wgs84ToGcj02({ lat: 39.908692, lng: 116.397477 }), 39.910095, 116.403721)
  })

  it('leaves WGS-84 outside China as it is', () => {
    expect(wgs84ToGcj02({ lat: 48.8584, lng: 2.2945 })).toEqual({ lat: 48.8584, lng: 2.2945 })
  })

  it('converts BD-09 to GCJ-02', () => {
    near(bd09ToGcj02({ lat: 40.057051, lng: 116.308106 }), 40.050909, 116.301676)
  })

  it('converts Baidu Mercator to GCJ-02 in each band', () => {
    near(bd09ToGcj02(bd09mcToBd09(12958160.97, 4825923.77)), 39.908657, 116.397501)
    near(bd09ToGcj02(bd09mcToBd09(13225312.44, 3749806.99)), 32.065173, 118.797287)
    near(bd09ToGcj02(bd09mcToBd09(12711001.38, 2530657.04)), 22.289614, 114.177079)
  })
})

describe('高德 links', () => {
  it('reads the redirect of an app short link, q=lat,lng,name', () => {
    const r = pointOf(
      'https://wb.amap.com/?commonBizInfo=%7B%22share_from%22%3A%22com.autonavi.map.search.fragment.SearchCQDetailPage%22%7D&q=31.222811749011463%2C121.46840706467624%2C%E4%B8%8A%E6%B5%B7%E5%B8%82%E9%BB%84%E6%B5%A6%E5%8C%BA%E5%B7%A8%E9%B9%BF%E8%B7%AF15-17%E5%8F%B7&src=app_C3090',
    )
    expect(r).toEqual({ kind: 'point', point: { lat: 31.222812, lng: 121.468407 }, source: 'amap' })
  })

  it('reads p=poiid,lat,lng,name', () => {
    near(
      pointOf(
        'https://wb.amap.com/?p=B0FFG5ZQ3L%2C39.908692%2C116.397477%2C%E5%A4%A9%E5%AE%89%E9%97%A8',
      ).point,
      39.908692,
      116.397477,
    )
  })

  it('reads web links: regeo lat/lng and uri position=lng,lat', () => {
    near(
      pointOf('https://www.amap.com/regeo?lng=121.46840706467624&lat=31.222811749011463&name=x')
        .point,
      31.222812,
      121.468407,
    )
    near(
      pointOf(amapMarkerUrl({ lat: 39.908692, lng: 116.397477 }, '球馆')).point,
      39.908692,
      116.397477,
    )
  })

  it('converts a uri link marked as WGS-84', () => {
    near(
      pointOf('https://uri.amap.com/marker?position=116.397477,39.908692&coordinate=wgs84').point,
      39.910095,
      116.403721,
    )
  })

  it('opens a short link from the app share text', () => {
    expect(
      parseMapText(
        '【高德地图】飞羽乒乓球馆\n北京市海淀区中关村大街59号\nhttps://surl.amap.com/4mkKGuyJ2bz',
      ),
    ).toEqual({ kind: 'open', url: 'https://surl.amap.com/4mkKGuyJ2bz', source: 'amap' })
  })

  it('cannot read a place page', () => {
    expect(parseMapText('https://www.amap.com/place/B000A83M61')).toEqual({
      kind: 'none',
      source: 'amap',
    })
  })

  it('ignores places outside China', () => {
    expect(
      parseMapLink('https://wb.amap.com/?p=P0JANYX6NL%2C45.8289525077221%2C1.266689300537103'),
    ).toEqual({ kind: 'none', source: 'amap' })
  })
})

describe('百度 links', () => {
  it('reads a place page /poi/名称/@x,y,zoom', () => {
    near(
      pointOf(
        'https://map.baidu.com/poi/%E5%8F%B0%E8%8F%B1%E5%A0%A4/@13225312.44,3749806.99,19z?uid=d544b3493ce1106c047ce855',
      ).point,
      32.065173,
      118.797287,
    )
  })

  it('reads a phone page sharegeo=x,y', () => {
    near(
      pointOf(
        'https://map.baidu.com/mobile/webapp/place/detail/qt=inf&uid=p8cdf0522067cf66173901fc9e4/act=read_share&vt=map&da_from=weixin&openna=1&sharegeo=13392211%2C3619117',
      ).point,
      31.060708,
      120.296394,
    )
  })

  it('reads the URI API location=lat,lng as BD-09', () => {
    near(
      pointOf('https://api.map.baidu.com/marker?location=40.057051,116.308106&title=x&output=html')
        .point,
      40.050909,
      116.301676,
    )
  })

  it('does not take a map view center as the place', () => {
    expect(parseMapLink('https://map.baidu.com/@13520653,3317203,13z')).toEqual({
      kind: 'none',
      source: 'baidu',
    })
  })

  it('opens short links and share pages', () => {
    for (const url of [
      'https://j.map.baidu.com/d7/RyTc',
      'https://map.baidu.com/?shareurl=1&poiShareUid=fef3b5922f87e66c63180999',
      'https://map.baidu.com/?newmap=1&s=inf%26uid%3D435d7aea036e54355abbbcc8&',
      'https://map.baidu.com/?poiShareId=p8cdf0522067cf66173901fc9e4',
    ]) {
      expect(parseMapLink(url)).toEqual({ kind: 'open', url, source: 'baidu' })
    }
  })

  it('reads the place from a phone page, not the viewer location', () => {
    const page = (inner: string) =>
      `{"ipGeo":"1|11590057.96,4489812.75","current_city":{"geo":"1|11590057.96,4489812.75"},${inner}}`
    near(
      pointInBaiduPage(
        page(
          '"content":{"loc":{"lng":116.308106,"lat":40.057051},"geo":"1|12947474.59,4846476.51"}',
        ),
      ),
      40.050909,
      116.301676,
    )
    near(
      pointInBaiduPage(
        page('"content":{"show_point":{"x":"1","y":"2"},"point":{"x":13392211,"y":3619117}}'),
      ),
      31.060708,
      120.296394,
    )
    expect(pointInBaiduPage('{"ipGeo":"1|11590057.96,4489812.75"}')).toBeNull()
  })
})

describe('腾讯地图 links', () => {
  it('reads marker=coord:lat,lng', () => {
    near(
      pointOf(
        'https://apis.map.qq.com/uri/v1/marker?marker=coord:39.908692,116.397477;title:球馆&referer=x',
      ).point,
      39.908692,
      116.397477,
    )
  })

  it('reads the desktop redirect pointx=lng&pointy=lat', () => {
    near(
      pointOf(
        'https://map.qq.com?isopeninfowin=1&markertype=1&name=test&pointx=116.397477&pointy=39.908692&type=marker',
      ).point,
      39.908692,
      116.397477,
    )
  })

  it('converts coord_type=1 from GPS', () => {
    near(
      pointOf(
        'https://apis.map.qq.com/uri/v1/marker?marker=coord:39.908692,116.397477&coord_type=1',
      ).point,
      39.910095,
      116.403721,
    )
  })

  it('opens other 腾讯 links', () => {
    expect(parseMapLink('https://map.qq.com/m/detail/poi/123')).toMatchObject({ kind: 'open' })
  })
})

describe('link edges', () => {
  it('refuses hosts that fetch would read differently', () => {
    expect(parseMapLink('https://127.0.0.1\\.map.qq.com/x')).toBeNull()
    expect(parseMapLink('https://map.qq.com@127.0.0.1/x')).toBeNull()
    expect(parseMapLink('https://evil.example/?q=map.qq.com')).toBeNull()
  })

  it('reads whole degrees in parameters', () => {
    expect(pointOf('https://map.qq.com/?pointx=116&pointy=40').point).toEqual({ lat: 40, lng: 116 })
  })

  it('drops a full stop after a link', () => {
    expect(parseMapText('see https://surl.amap.com/4mkKGuyJ2bz.')).toMatchObject({
      url: 'https://surl.amap.com/4mkKGuyJ2bz',
    })
  })

  it('does not take the viewer city on a 百度 page for the place', () => {
    expect(
      pointInBaiduPage(
        '{"ipGeo":"1|11590057.96,4489812.75","current_city":{"code":131,"geo":"1|12959238.56,4825347.47"}}',
      ),
    ).toBeNull()
    near(
      pointInBaiduPage(
        '{"current_city":{"geo":"1|12959238.56,4825347.47"},"content":{"geo":"1|13392211,3619117;"}}',
      ),
      31.060708,
      120.296394,
    )
  })
})

describe('plain text', () => {
  it('reads coordinates in either order, with Chinese or Latin commas', () => {
    expect(pointOf('39.908692, 116.397477').point).toEqual({ lat: 39.908692, lng: 116.397477 })
    expect(pointOf('116.397477，39.908692').point).toEqual({ lat: 39.908692, lng: 116.397477 })
    expect(pointOf('纬度 39.9087 经度 116.3975')).toBeTruthy()
  })

  it('refuses text with nothing usable', () => {
    expect(parseMapText('飞羽乒乓球馆')).toBeNull()
    expect(parseMapText('1.5, 2.5')).toBeNull()
    expect(parseMapText('https://example.com/?q=39.9,116.3')).toBeNull()
  })

  it('takes a point over a link it has to open', () => {
    expect(
      parseMapText('https://surl.amap.com/abc https://wb.amap.com/?q=39.908692,116.397477'),
    ).toMatchObject({ kind: 'point', source: 'amap' })
  })
})
