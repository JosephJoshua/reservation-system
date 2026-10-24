import { CHECK_IN_EARLY_MINUTES, type VenueSettings } from '@rs/shared'
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
import { attempt, newKey, useApi } from '../hooks'
import { PreviewDialog } from '../preview/EditorWithPreview'
import { coordValid, VenueLocation } from '../VenueLocation'

export function Settings() {
  const { data, error, reload } = useApi<VenueSettings>('/admin/settings')
  const [s, setS] = useState<VenueSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [coord, setCoord] = useState({ lat: '', lng: '' })
  // One per loaded version, so a retry after a lost response is not saved twice.
  const [key, setKey] = useState(newKey)
  const [previewing, setPreviewing] = useState(false)

  useEffect(() => {
    if (!data) return
    setS(structuredClone(data))
    setKey(newKey())
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
    const lat = coord.lat.trim()
    const lng = coord.lng.trim()
    if (!coordValid(lat, 90) || !coordValid(lng, 180) || !lat !== !lng) {
      void MessagePlugin.warning('请填写完整、有效的经纬度，或都留空')
      return
    }
    const body = structuredClone(s)
    body.venue.latitude = lat ? Number(lat) : null
    body.venue.longitude = lng ? Number(lng) : null
    setSaving(true)
    if (await attempt(() => api('PUT', '/admin/settings', body, { ifMatch: data, key }), '已保存'))
      await reload()
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
              placeholder="如：09:00-21:00"
              onChange={(v) =>
                set((d) => {
                  d.venue.openingHours = String(v)
                })
              }
            />
          </Field>
          <Field
            label="地图坐标"
            help="在高德、腾讯或百度地图里打开场馆，点“分享”并复制链接，粘贴到上面即可。学员点场馆地址时，会按这个位置导航。"
          >
            <VenueLocation value={coord} onChange={setCoord} venueName={s.venue.name} />
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
          <Field label="学员改约" help="免费取消截止前，每节课学员可自行改约的次数，0 为不允许">
            <InputNumber
              theme="normal"
              value={s.booking.studentMoves}
              min={0}
              max={5}
              suffix="次"
              onChange={(v) =>
                set((d) => {
                  d.booking.studentMoves = Number(v) || 0
                })
              }
            />
          </Field>
          <Field label="球台数" help="同一时间最多能上几节课，留空则不限">
            <InputNumber
              theme="normal"
              value={s.booking.tables ?? undefined}
              min={1}
              max={99}
              placeholder="不限"
              suffix="张"
              onChange={(v) =>
                set((d) => {
                  // Empty is no limit; any number is kept to 1 to 99 tables.
                  const n = Math.floor(Number(v))
                  d.booking.tables =
                    v === '' || v === undefined || Number.isNaN(n)
                      ? null
                      : Math.min(Math.max(n, 1), 99)
                })
              }
            />
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
                单次付费和课时包都关闭后，学员只能用已有的课时包预约
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
          <Field label="支付时限" help="下单后超过这个时间仍未支付，订单会自动取消并释放时段">
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

      <Card
        title="首页公告"
        bordered
        actions={
          <Button variant="outline" onClick={() => setPreviewing(true)}>
            预览首页
          </Button>
        }
      >
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

      {previewing && (
        <PreviewDialog
          title="预览首页"
          draft={{
            kind: 'home',
            id: null,
            venue: s.venue,
            notice: s.notice,
            payment: s.payment,
          }}
          onClose={() => setPreviewing(false)}
        />
      )}

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
          <Field label="用户协议" help="留空则使用内置的协议。学员首次预约或购买前需要同意">
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

      <Card title="签到" bordered>
        <div className="fields form-narrow">
          <Field
            label="学员扫码签到"
            help={`学员课前 ${CHECK_IN_EARLY_MINUTES} 分钟起，可以用小程序扫前台的签到码签到`}
          >
            <Switch
              value={s.attendance.selfCheckIn}
              onChange={(v) =>
                set((d) => {
                  d.attendance.selfCheckIn = v
                })
              }
            />
          </Field>
          <Field label="教练点名" help="教练在小程序里记录学员到课或缺席">
            <Switch
              value={s.attendance.coachMarks}
              onChange={(v) =>
                set((d) => {
                  d.attendance.coachMarks = v
                })
              }
            />
          </Field>
          <Field>
            <span className="muted">
              前台随时可以在前台签到页签到和更正。签到不会影响扣课和收款，课时包的课时在预约时就已扣除。
            </span>
          </Field>
        </div>
      </Card>

      <Card title="课时费" bordered>
        <div className="fields form-narrow">
          <Field label="学员缺席" help="课程结束时学员仍未到场，是否给教练计课时费">
            <Switch
              value={s.pay.noShows}
              onChange={(v) =>
                set((d) => {
                  d.pay.noShows = v
                })
              }
            />
          </Field>
          <Field label="学员逾时取消" help="学员过了免费取消时限才取消，是否给教练计课时费">
            <Switch
              value={s.pay.lateCancels}
              onChange={(v) =>
                set((d) => {
                  d.pay.lateCancels = v
                })
              }
            />
          </Field>
          <Field>
            <span className="muted">
              已结束的课程照常计入，场馆取消的课不计入。课时费标准在课程与教练的教练类别里设置。
            </span>
          </Field>
        </div>
      </Card>

      <Card title="运营主体" bordered>
        <div className="fields form-narrow">
          <Field
            label="主体名称"
            help="需要与小程序后台登记的主体一致，会写入隐私政策。留空则使用场馆名称"
          >
            <Input
              value={s.legal.operator}
              maxlength={60}
              onChange={(v) =>
                set((d) => {
                  d.legal.operator = String(v)
                })
              }
            />
          </Field>
          <Field label="隐私联系方式" help="用于处理个人信息问题的电话或邮箱。留空则使用场馆电话">
            <Input
              value={s.legal.contact}
              maxlength={60}
              onChange={(v) =>
                set((d) => {
                  d.legal.contact = String(v)
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
