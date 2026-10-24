import {
  amapMarkerUrl,
  inChina,
  type LatLng,
  mapAppLabels,
  parseMapText,
  roundPoint,
} from '@rs/shared'
import { useEffect, useRef, useState } from 'react'
import { Button, Dialog, Input, Link, MessagePlugin, Space } from 'tdesign-react'
import { api } from './api'
import { useApi } from './hooks'

export interface CoordText {
  lat: string
  lng: string
}

export function coordValid(text: string, limit: number) {
  if (text.trim() === '') return true
  const n = Number(text)
  return Number.isFinite(n) && Math.abs(n) <= limit
}

function pointOf(c: CoordText): LatLng | null {
  if (!c.lat.trim() || !c.lng.trim()) return null
  const p = { lat: Number(c.lat), lng: Number(c.lng) }
  return coordValid(c.lat, 90) && coordValid(c.lng, 180) ? p : null
}

function asText(p: LatLng): CoordText {
  const r = roundPoint(p)
  return { lat: String(r.lat), lng: String(r.lng) }
}

interface PickedPlace {
  point: LatLng
  name: string
  address: string
}

/**
 * The venue's map point, in GCJ-02 for wx.openLocation: read from a pasted share link or
 * coordinates, picked on 腾讯地图 when a key is set, or typed in.
 */
export function VenueLocation({
  value,
  onChange,
  venueName,
}: {
  value: CoordText
  onChange: (next: CoordText) => void
  venueName: string
}) {
  const { data: map } = useApi<{ tencentKey: string | null }>('/admin/map')
  const key = map?.tencentKey ?? null
  const [pasted, setPasted] = useState('')
  const [reading, setReading] = useState(false)
  // Set at once, unlike the state, so a double press or a paste and Enter ask the server once.
  const busy = useRef(false)
  const [picking, setPicking] = useState(false)
  const point = pointOf(value)

  const read = async (text: string) => {
    if (!text.trim() || busy.current) return
    const parsed = parseMapText(text)
    if (!parsed) {
      void MessagePlugin.warning(
        '没有识别到位置，请粘贴高德、腾讯或百度地图的分享链接，或纬度和经度',
      )
      return
    }
    if (parsed.kind === 'point') {
      onChange(asText(parsed.point))
      setPasted('')
      void MessagePlugin.success(
        parsed.source === 'text' ? '已填入坐标' : `已从${mapAppLabels[parsed.source]}读取位置`,
      )
      return
    }
    busy.current = true
    if (parsed.kind === 'none') {
      void MessagePlugin.warning(
        `这个${mapAppLabels[parsed.source]}链接里没有位置，请在地图 App 里点“分享”并复制链接，或在地图上选点`,
      )
      return
    }
    setReading(true)
    try {
      const r = await api<{ point: LatLng; source: keyof typeof mapAppLabels }>(
        'POST',
        '/admin/map/resolve',
        { url: parsed.url },
      )
      onChange(asText(r.point))
      setPasted('')
      void MessagePlugin.success(`已从${mapAppLabels[r.source]}读取位置`)
    } catch (e) {
      void MessagePlugin.warning((e as Error).message)
    } finally {
      busy.current = false
      setReading(false)
    }
  }

  return (
    <div className="venue-location">
      <div className="venue-location-row">
        <Input
          className="venue-location-paste"
          placeholder="粘贴地图分享链接或坐标"
          value={pasted}
          disabled={reading}
          onChange={(v) => setPasted(String(v))}
          onPaste={({ e }) => {
            const text = e.clipboardData.getData('text')
            if (!text) return
            e.preventDefault()
            setPasted(text)
            void read(text)
          }}
          onEnter={() => void read(pasted)}
        />
        <Button variant="outline" loading={reading} onClick={() => void read(pasted)}>
          识别
        </Button>
        {key && (
          <Button variant="outline" onClick={() => setPicking(true)}>
            在地图上选点
          </Button>
        )}
      </div>
      <Space size={8} align="center" breakLine>
        <Input
          style={{ width: 160 }}
          placeholder="纬度，如：39.9087"
          value={value.lat}
          status={coordValid(value.lat, 90) ? 'default' : 'error'}
          onChange={(v) => onChange({ ...value, lat: String(v) })}
        />
        <Input
          style={{ width: 160 }}
          placeholder="经度，如：116.3975"
          value={value.lng}
          status={coordValid(value.lng, 180) ? 'default' : 'error'}
          onChange={(v) => onChange({ ...value, lng: String(v) })}
        />
        {point && (
          <a href={amapMarkerUrl(point, venueName)} target="_blank" rel="noreferrer">
            在高德地图中查看
          </a>
        )}
        {(value.lat || value.lng) && (
          <Link theme="default" onClick={() => onChange({ lat: '', lng: '' })}>
            清除
          </Link>
        )}
      </Space>
      {point && key && (
        <img
          className="venue-location-map"
          alt="场馆位置"
          src={staticMapUrl(point, key)}
          width={480}
          height={200}
        />
      )}
      {picking && key && (
        <PickerDialog
          tencentKey={key}
          start={point}
          onClose={() => setPicking(false)}
          onPick={(p) => {
            onChange(asText(p.point))
            setPicking(false)
            void MessagePlugin.success(`已选择${p.name || '该位置'}`)
          }}
        />
      )}
    </div>
  )
}

function staticMapUrl(p: LatLng, key: string) {
  const at = `${p.lat},${p.lng}`
  const q = [`center=${at}`, 'zoom=16', 'size=480*200', 'scale=2', `markers=size:large|${at}`]
  return `https://apis.map.qq.com/ws/staticmap/v2/?${q.join('&')}&key=${encodeURIComponent(key)}`
}

/** 腾讯地图's 位置选点 page, which posts the chosen place back to this window. */
function PickerDialog({
  tencentKey,
  start,
  onClose,
  onPick,
}: {
  tencentKey: string
  start: LatLng | null
  onClose: () => void
  onPick: (p: PickedPlace) => void
}) {
  const [picked, setPicked] = useState<PickedPlace | null>(null)
  const frame = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return
      const d = e.data as {
        module?: string
        latlng?: { lat: number; lng: number }
        poiname?: string
        poiaddress?: string
      } | null
      if (d?.module !== 'locationPicker' || !d.latlng || !inChina(d.latlng)) return
      const name = d.poiname === '我的位置' ? '' : (d.poiname ?? '')
      setPicked({ point: d.latlng, name, address: d.poiaddress ?? '' })
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  const q = [
    'search=1',
    'type=1',
    'policy=1',
    `key=${encodeURIComponent(tencentKey)}`,
    'referer=rs-admin',
  ]
  if (start) q.push(`coord=${start.lat},${start.lng}`)

  return (
    <Dialog
      visible
      header="在地图上选点"
      placement="center"
      width={760}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            返回
          </Button>
          <Button disabled={!picked} onClick={() => picked && onPick(picked)}>
            使用这个位置
          </Button>
        </>
      }
    >
      <iframe
        ref={frame}
        className="venue-location-picker"
        title="腾讯地图选点"
        src={`https://apis.map.qq.com/tools/locpicker?${q.join('&')}`}
      />
      <p className="muted venue-location-picked">
        {picked
          ? `已选：${[picked.name, picked.address].filter(Boolean).join('，') || `${picked.point.lat}, ${picked.point.lng}`}`
          : '搜索场馆名称或地址，在列表或地图上选中位置。'}
      </p>
    </Dialog>
  )
}
