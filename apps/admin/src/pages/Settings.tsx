import type { VenueSettings } from '@rs/shared'
import { useEffect, useState } from 'react'
import {
  Button,
  Card,
  DatePicker,
  Input,
  InputNumber,
  Loading,
  MessagePlugin,
  Radio,
  Space,
  Switch,
  Textarea,
} from 'tdesign-react'
import { api } from '../api'
import { Field } from '../Field'
import { isoToPicker, pickerToIso } from '../format'
import { attempt, useApi } from '../hooks'

function coordValid(text: string, limit: number) {
  if (text.trim() === '') return true
  const n = Number(text)
  return Number.isFinite(n) && Math.abs(n) <= limit
}

export function Settings() {
  const { data, error, reload } = useApi<VenueSettings>('/admin/settings')
  const [s, setS] = useState<VenueSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [coord, setCoord] = useState({ lat: '', lng: '' })

  useEffect(() => {
    if (!data) return
    setS(structuredClone(data))
    setCoord({
      lat: data.venue.latitude?.toString() ?? '',
      lng: data.venue.longitude?.toString() ?? '',
    })
  }, [data])

  if (!s) return error ? <p className="muted">{error}</p> : <Loading size="small" />

  const set = (fn: (draft: VenueSettings) => void) => {
    const next = structuredClone(s)
    fn(next)
    setS(next)
  }

  const save = async () => {
    if (!coordValid(coord.lat, 90) || !coordValid(coord.lng, 180) || !coord.lat !== !coord.lng) {
      void MessagePlugin.warning('请填写完整、有效的经纬度，或都留空')
      return
    }
    const body = structuredClone(s)
    body.venue.latitude = coord.lat ? Number(coord.lat) : null
    body.venue.longitude = coord.lng ? Number(coord.lng) : null
    setSaving(true)
    if (await attempt(() => api('PUT', '/admin/settings', body), '已保存')) await reload()
    setSaving(false)
  }

  const noneSelling = !s.payment.perClassEnabled && !s.payment.packagesEnabled

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card title="场馆信息" bordered>
        <div className="fields form-narrow">
          <Field label="名称">
            <Input
              value={s.venue.name}
              maxlength={40}
              onChange={(v) =>
                set((d) => {
                  d.venue.name = String(v)
                })
              }
            />
          </Field>
          <Field label="地址">
            <Input
              value={s.venue.address}
              maxlength={120}
              onChange={(v) =>
                set((d) => {
                  d.venue.address = String(v)
                })
              }
            />
          </Field>
          <Field label="电话">
            <Input
              value={s.venue.phone}
              maxlength={30}
              onChange={(v) =>
                set((d) => {
                  d.venue.phone = String(v)
                })
              }
            />
          </Field>
          <Field label="营业时间">
            <Input
              value={s.venue.openingHours}
              maxlength={60}
              placeholder="如 09:00-21:00"
              onChange={(v) =>
                set((d) => {
                  d.venue.openingHours = String(v)
                })
              }
            />
          </Field>
          <Field label="地图坐标" help="用于学员一键导航，可在腾讯地图坐标拾取器获取">
            <Space>
              <Input
                style={{ width: 160 }}
                placeholder="纬度，如 39.9087"
                value={coord.lat}
                status={coordValid(coord.lat, 90) ? 'default' : 'error'}
                onChange={(v) => setCoord({ ...coord, lat: String(v) })}
              />
              <Input
                style={{ width: 160 }}
                placeholder="经度，如 116.3975"
                value={coord.lng}
                status={coordValid(coord.lng, 180) ? 'default' : 'error'}
                onChange={(v) => setCoord({ ...coord, lng: String(v) })}
              />
            </Space>
          </Field>
        </div>
      </Card>

      <Card title="预约规则" bordered>
        <div className="fields form-narrow">
          <Field label="可提前预约" help="学员可以预约今天起多少天内的课程">
            <InputNumber
              theme="normal"
              value={s.booking.advanceDays}
              min={1}
              max={90}
              suffix="天"
              onChange={(v) =>
                set((d) => {
                  d.booking.advanceDays = Number(v) || 1
                })
              }
            />
          </Field>
          <Field label="最晚预约" help="课程开始前多久停止预约">
            <InputNumber
              theme="normal"
              value={s.booking.minNoticeMinutes / 60}
              min={0}
              max={168}
              decimalPlaces={1}
              suffix="小时"
              onChange={(v) =>
                set((d) => {
                  d.booking.minNoticeMinutes = Math.round((Number(v) || 0) * 60)
                })
              }
            />
          </Field>
          <Field label="免费取消" help="课程开始前多少小时以上取消，全额退款或退回课时">
            <InputNumber
              theme="normal"
              value={s.booking.cancelDeadlineHours}
              min={0}
              max={336}
              suffix="小时"
              onChange={(v) =>
                set((d) => {
                  d.booking.cancelDeadlineHours = Number(v) || 0
                })
              }
            />
          </Field>
          <Field label="之后取消">
            <Space direction="vertical">
              <Radio.Group
                value={s.booking.lateCancel.kind}
                onChange={(v) =>
                  set((d) => {
                    d.booking.lateCancel =
                      v === 'forfeit' ? { kind: 'forfeit' } : { kind: 'partial', percent: 50 }
                  })
                }
              >
                <Radio value="forfeit">视为已上课，不退款不退课时</Radio>
                <Radio value="partial">按比例退款</Radio>
              </Radio.Group>
              {s.booking.lateCancel.kind === 'partial' && (
                <InputNumber
                  theme="normal"
                  value={s.booking.lateCancel.percent}
                  min={0}
                  max={100}
                  suffix="%"
                  onChange={(v) =>
                    set((d) => {
                      d.booking.lateCancel = { kind: 'partial', percent: Number(v) || 0 }
                    })
                  }
                />
              )}
              {s.booking.lateCancel.kind === 'partial' && (
                <span className="muted">课时包预约只有在 100% 时才退回课时</span>
              )}
            </Space>
          </Field>
        </div>
      </Card>

      <Card title="支付" bordered>
        <div className="fields form-narrow">
          <Field label="单次付费">
            <Switch
              value={s.payment.perClassEnabled}
              onChange={(v) =>
                set((d) => {
                  d.payment.perClassEnabled = v
                })
              }
            />
          </Field>
          <Field label="课时包">
            <Switch
              value={s.payment.packagesEnabled}
              onChange={(v) =>
                set((d) => {
                  d.payment.packagesEnabled = v
                })
              }
            />
          </Field>
          {noneSelling && (
            <Field>
              <span style={{ color: 'var(--td-warning-color)' }}>
                单次付费和课时包都关闭后，学员只能用已有课时包预约
              </span>
            </Field>
          )}
          <Field label="体验课">
            <Switch
              value={s.payment.trialEnabled}
              onChange={(v) =>
                set((d) => {
                  d.payment.trialEnabled = v
                })
              }
            />
          </Field>
          <Field label="每人体验课次数">
            <InputNumber
              theme="normal"
              value={s.payment.trialLimitPerStudent}
              min={1}
              max={10}
              suffix="次"
              onChange={(v) =>
                set((d) => {
                  d.payment.trialLimitPerStudent = Number(v) || 1
                })
              }
            />
          </Field>
          <Field label="支付时限" help="下单后多久未支付自动取消，释放时段">
            <InputNumber
              theme="normal"
              value={s.payment.timeoutMinutes}
              min={5}
              max={30}
              suffix="分钟"
              onChange={(v) =>
                set((d) => {
                  d.payment.timeoutMinutes = Number(v) || 10
                })
              }
            />
          </Field>
        </div>
      </Card>

      <Card title="首页公告" bordered>
        <div className="fields form-narrow">
          <Field label="公告" help="一句话，留空则不显示">
            <Input
              value={s.notice.text}
              maxlength={60}
              onChange={(v) =>
                set((d) => {
                  d.notice.text = String(v)
                })
              }
            />
          </Field>
          <Field label="结束时间">
            <DatePicker
              enableTimePicker
              clearable
              value={isoToPicker(s.notice.endsAt)}
              onChange={(v) =>
                set((d) => {
                  d.notice.endsAt = pickerToIso(String(v || ''))
                })
              }
            />
          </Field>
        </div>
      </Card>

      <Card title="说明文字" bordered>
        <div className="fields form-narrow">
          <Field label="预约须知">
            <Textarea
              value={s.policies.booking}
              maxlength={2000}
              autosize={{ minRows: 3 }}
              onChange={(v) =>
                set((d) => {
                  d.policies.booking = String(v)
                })
              }
            />
          </Field>
          <Field label="用户协议" help="首次付款前展示">
            <Textarea
              value={s.policies.agreement}
              maxlength={5000}
              autosize={{ minRows: 4 }}
              onChange={(v) =>
                set((d) => {
                  d.policies.agreement = String(v)
                })
              }
            />
          </Field>
        </div>
      </Card>

      <div>
        <Button loading={saving} onClick={save}>
          保存设置
        </Button>
      </div>
    </Space>
  )
}
