import {
  CHECK_IN_EARLY_MINUTES,
  ownRuleLabels,
  ruleLabels,
  VENUE_PHONE_MESSAGE,
  type VenueSettings,
  venuePhoneValid,
  venueSettings,
} from '@rs/shared'
import { useEffect, useRef, useState } from 'react'
import {
  Button,
  Card,
  Input,
  InputNumber,
  Loading,
  MessagePlugin,
  Radio,
  Space,
  Switch,
  Textarea,
} from 'tdesign-react'
import { DefaultRuleFields } from '../BookingRules'
import { Field } from '../Field'
import { typedNumber } from '../format'
import { useApi } from '../hooks'
import { NumberBox } from '../NumberBox'
import { SaveBar, StaleNotice } from '../SaveBar'
import { SectionNav, useSections } from '../SectionNav'
import { useSettingsDraft } from '../settingsDraft'
import type { LessonType } from '../types'
import { coordValid, VenueLocation } from '../VenueLocation'
import { Closures } from './CoachDialogs'

/** The parts of 设置, in the order of the page, with the settings each one holds. */
export const sections = [
  { key: 'venue', label: '场馆', pick: (v: VenueSettings) => v.venue },
  {
    key: 'booking',
    label: '默认预约规则',
    pick: ({
      booking: { startGrid: _g, bufferMinutes: _b, coachEditsHours: _c, ...rules },
    }: VenueSettings) => rules,
  },
  {
    key: 'schedule',
    label: '排班',
    pick: ({ booking: b }: VenueSettings) => [b.startGrid, b.bufferMinutes, b.coachEditsHours],
  },
  // Saved as soon as each one is added, so never left unsaved.
  { key: 'closures', label: '闭馆', pick: () => null },
  { key: 'payment', label: '支付', pick: (v: VenueSettings) => v.payment },
  { key: 'attendance', label: '签到', pick: (v: VenueSettings) => v.attendance },
  { key: 'pay', label: '课时费', pick: (v: VenueSettings) => v.pay },
  {
    key: 'legal',
    label: '协议与隐私',
    pick: (v: VenueSettings) => [v.policies.agreement, v.legal],
  },
] as const

type SettingsSection = (typeof sections)[number]['key']

// What the fields that can be wrong are called on the page, by their path in the settings.
const fieldLabels: Record<string, string> = {
  'venue.name': '场馆名称',
  'venue.address': '地址',
  'venue.phone': '电话',
  'venue.openingHours': '营业时间',
  ...Object.fromEntries(Object.entries(ruleLabels).map(([k, v]) => [`booking.${k}`, v])),
  'booking.lateCancel.percent': '退款比例',
  'booking.tables': '球台数',
  'booking.bufferMinutes': '课间休息',
  'payment.timeoutMinutes': '支付时限',
  'payment.trialLimitPerStudent': '每人体验课次数',
  'policies.agreement': '用户协议',
  'legal.operator': '主体名称',
  'legal.contact': '隐私联系方式',
}

/**
 * Why the settings can't be saved, checked here with the API's own schema so a field shown red
 * is named before saving instead of the server answering with a general error.
 */
function settingsProblem(
  body: VenueSettings,
): { message: string; section: SettingsSection } | null {
  if (!body.venue.name.trim()) return { message: '请填写场馆名称', section: 'venue' }
  const result = venueSettings.safeParse(body)
  if (result.success) return null
  const issue = result.error.issues[0]
  if (!issue) return null
  const path = issue.path.filter((p) => typeof p === 'string').join('.')
  const label = fieldLabels[path] ?? fieldLabels[path.split('.').slice(0, 2).join('.')] ?? '设置'
  const top = path.split('.')[0]
  const section: SettingsSection =
    top === 'booking'
      ? path === 'booking.bufferMinutes'
        ? 'schedule'
        : 'booking'
      : top === 'policies'
        ? 'legal'
        : sectionKeys.includes(top as SettingsSection)
          ? (top as SettingsSection)
          : 'venue'
  const message =
    // Checks of their own say what is wrong in words.
    issue.code === 'custom'
      ? issue.message
      : issue.code === 'too_big' && issue.origin === 'string'
        ? `${label}太长`
        : issue.code === 'too_small' || issue.code === 'too_big'
          ? `${label}超出允许范围`
          : issue.code === 'invalid_type' && issue.expected === 'int'
            ? `${label}需为整数`
            : issue.code === 'not_multiple_of'
              ? `${label}需为 ${issue.divisor} 的倍数`
              : `${label}格式不对`
  return { message, section }
}
const sectionKeys = sections.map((x) => x.key)

export function Settings() {
  const {
    data,
    error,
    s,
    set,
    reset: resetDraft,
    save: saveDraft,
    saving,
    stale,
    isSaving,
    changed,
  } = useSettingsDraft()
  const types = useApi<LessonType[]>('/admin/lesson-types')
  const [coord, setCoord] = useState({ lat: '', lng: '' })
  // The coordinates as saved, so ones typed while saving are kept, as the hook keeps the rest.
  const sentCoord = useRef<typeof coord | null>(null)
  const nav = useSections(sectionKeys, !!s)

  const loadedCoord = {
    lat: data?.venue.latitude?.toString() ?? '',
    lng: data?.venue.longitude?.toString() ?? '',
  }
  const reset = () => {
    resetDraft()
    setCoord(loadedCoord)
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when new settings arrive
  useEffect(() => {
    if (!data) return
    const typed = sentCoord.current
    sentCoord.current = null
    setCoord((prev) =>
      typed && (prev.lat !== typed.lat || prev.lng !== typed.lng) ? prev : loadedCoord,
    )
  }, [data])

  if (!s) return error ? <p className="muted">{error}</p> : <Loading size="small" />

  const coordChanged = coord.lat !== loadedCoord.lat || coord.lng !== loadedCoord.lng
  // 首页内容 edits the rest of the settings; they are never changed here.
  const dirtySections = new Set<SettingsSection>(
    sections
      .filter((x) => changed(x.pick) || (x.key === 'venue' && coordChanged))
      .map((x) => x.key),
  )
  const dirty = dirtySections.size > 0
  // Checked once changed, so a phone saved before the check does not block the rest.
  const phoneWrong = s.venue.phone !== data?.venue.phone && !venuePhoneValid(s.venue.phone)

  const save = async () => {
    if (isSaving()) return
    if (!s.venue.name.trim()) {
      void MessagePlugin.warning('请填写场馆名称')
      nav.scrollTo('venue')
      return
    }
    const lat = coord.lat.trim()
    const lng = coord.lng.trim()
    if (!coordValid(lat, 90) || !coordValid(lng, 180) || !lat !== !lng) {
      void MessagePlugin.warning('请填写完整、有效的经纬度，或都留空')
      nav.scrollTo('venue')
      return
    }
    const body = structuredClone(s)
    body.venue.latitude = lat ? Number(lat) : null
    body.venue.longitude = lng ? Number(lng) : null
    if (phoneWrong) {
      void MessagePlugin.warning(VENUE_PHONE_MESSAGE)
      nav.scrollTo('venue')
      return
    }
    const problem = settingsProblem(body)
    if (problem) {
      void MessagePlugin.warning(problem.message)
      nav.scrollTo(problem.section)
      return
    }
    sentCoord.current = coord
    if (!(await saveDraft(body))) sentCoord.current = null
  }

  // Lessons on offer only: one taken off sale changes nothing students get.
  const customized = (types.data ?? []).filter((t) => t.active && ownRuleLabels(t.rules).length > 0)
  const noneSelling = !s.payment.perClassEnabled && !s.payment.packagesEnabled

  return (
    <Space direction="vertical" size={16} className="settings-layout" style={{ width: '100%' }}>
      <SectionNav sections={sections} nav={nav} dirty={dirtySections} />
      {stale && <StaleNotice what="设置" onLoad={reset} />}
      <Card title="场馆信息" bordered ref={nav.refs.venue}>
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
          <Field label="电话" help={phoneWrong ? VENUE_PHONE_MESSAGE : undefined}>
            <Input
              value={s.venue.phone}
              maxlength={60}
              status={phoneWrong ? 'error' : 'default'}
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

      <Card title="默认预约规则" bordered ref={nav.refs.booking}>
        <div className="fields form-narrow">
          <div className="card-intro muted">
            <div>课程可以单独设置这些规则，没有单独设置的规则都按这里的默认值。</div>
            {types.error && (
              <div className="field-error">
                课程没有加载出来，看不到哪些课程单独设置了规则。
                <Button variant="text" theme="primary" size="small" onClick={types.reload}>
                  重试
                </Button>
              </div>
            )}
            {customized.length > 0 && (
              <div>
                已单独设置的课程：
                {customized
                  .map((t) => `${t.name}（${ownRuleLabels(t.rules).join('、')}）`)
                  .join('，')}
                <a className="card-intro-link" href="#/courses">
                  去修改
                </a>
              </div>
            )}
          </div>
          <DefaultRuleFields
            value={s.booking}
            onChange={(patch) =>
              set((d) => {
                Object.assign(d.booking, patch)
              })
            }
          />
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

      <Card title="排班" bordered ref={nav.refs.schedule}>
        <div className="fields form-narrow">
          <Field label="开始时间间隔" help="学员可选的上课开始时间，从整点起每隔多久一个">
            <Radio.Group
              variant="default-filled"
              value={s.booking.startGrid}
              onChange={(v) =>
                set((d) => {
                  d.booking.startGrid = Number(v) as 15 | 30 | 60
                })
              }
            >
              <Radio.Button value={15}>15 分钟</Radio.Button>
              <Radio.Button value={30}>30 分钟</Radio.Button>
              <Radio.Button value={60}>1 小时</Radio.Button>
            </Radio.Group>
          </Field>
          <Field label="课间休息" help="同一教练两节课之间至少空出的时间">
            <InputNumber
              theme="normal"
              value={s.booking.bufferMinutes}
              min={0}
              max={60}
              step={5}
              suffix="分钟"
              onChange={(v) =>
                set((d) => {
                  const n = Math.round((Number(v) || 0) / 5) * 5
                  d.booking.bufferMinutes = Math.min(Math.max(n, 0), 60)
                })
              }
            />
          </Field>
          <Field label="教练自己排班" help="关闭后教练只能查看排班，请假和改时间由前台操作">
            <Switch
              value={s.booking.coachEditsHours}
              onChange={(v) =>
                set((d) => {
                  d.booking.coachEditsHours = Boolean(v)
                })
              }
            />
          </Field>
        </div>
      </Card>

      <Card title="闭馆" bordered ref={nav.refs.closures}>
        <Closures />
      </Card>

      <Card title="支付" bordered ref={nav.refs.payment}>
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
            <NumberBox
              theme="normal"
              value={s.payment.trialLimitPerStudent}
              min={1}
              max={10}
              suffix="次"
              onChange={(v) => {
                const n = typedNumber(v)
                if (n !== null) {
                  set((d) => {
                    d.payment.trialLimitPerStudent = Math.floor(n)
                  })
                }
              }}
            />
          </Field>
          <Field label="支付时限" help="下单后超过这个时间仍未支付，订单会自动取消并释放时段">
            <NumberBox
              theme="normal"
              value={s.payment.timeoutMinutes}
              min={5}
              max={30}
              suffix="分钟"
              onChange={(v) => {
                const n = typedNumber(v)
                if (n !== null) {
                  set((d) => {
                    d.payment.timeoutMinutes = Math.floor(n)
                  })
                }
              }}
            />
          </Field>
        </div>
      </Card>

      <Card title="签到" bordered ref={nav.refs.attendance}>
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
              前台随时可以在“今日”页签到和更正。签到不会影响扣课和收款，课时包的课时在预约时就已扣除。
            </span>
          </Field>
        </div>
      </Card>

      <Card title="课时费" bordered ref={nav.refs.pay}>
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
              已结束的课程照常计入，场馆取消的课不计入。课时费标准在教练页的教练类别里设置。
            </span>
          </Field>
        </div>
      </Card>

      <Card title="协议与隐私" bordered ref={nav.refs.legal}>
        <div className="fields form-narrow">
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
      <SaveBar
        dirty={dirty}
        saving={saving}
        onSave={save}
        onReset={reset}
        note={stale ? '已被其他人修改' : undefined}
      />
    </Space>
  )
}
