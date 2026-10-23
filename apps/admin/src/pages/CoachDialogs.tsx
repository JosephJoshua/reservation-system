import {
  type CoachHoursDto,
  type SlotSyncDto,
  type WeeklyHours,
  weeklyHoursError,
} from '@rs/shared'
import { useEffect, useState } from 'react'
import {
  Alert,
  Button,
  DatePicker,
  Dialog,
  MessagePlugin,
  Popconfirm,
  Select,
  Space,
  Tag,
  TimePicker,
} from 'tdesign-react'
import { api } from '../api'
import { DataTable } from '../DataTable'
import { fmtDateTime, today } from '../format'
import { attempt, useApi } from '../hooks'
import type { Coach } from '../types'

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]

const hhmm = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
const minutes = (v: string) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5))

/** One line on what a save did to the coach's slots. */
function syncMessage(r: SlotSyncDto, done: string) {
  const parts = [
    r.created ? `新增 ${r.created} 个时段` : '',
    r.removed ? `移除 ${r.removed} 个时段` : '',
    r.bookedOnDaysOff ? `休息日还有 ${r.bookedOnDaysOff} 节已预约的课，请联系学员或取消` : '',
  ].filter(Boolean)
  return [done, ...parts].join('，')
}

/** Shows the coach's WeChat binding and hands out bind codes. */
export function CoachBindingDialog({ coach, onClose }: { coach: Coach; onClose: () => void }) {
  const [current, setCurrent] = useState(coach)
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(
    coach.bindCode && coach.bindCodeExpiresAt
      ? { code: coach.bindCode, expiresAt: coach.bindCodeExpiresAt }
      : null,
  )

  const generate = () =>
    attempt(async () => {
      setCode(await api('POST', `/admin/coaches/${coach.id}/bind-code`))
    })

  const unbind = () =>
    attempt(async () => {
      await api('DELETE', `/admin/coaches/${coach.id}/binding`)
      setCurrent({ ...current, bound: false })
      setCode(null)
    }, '已解除绑定')

  return (
    <Dialog
      visible
      width={480}
      header={`${coach.name} 的微信绑定`}
      footer={false}
      onClose={onClose}
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <div>
          当前状态：
          {current.bound ? (
            <Tag theme="success" variant="light">
              已绑定
            </Tag>
          ) : (
            <Tag variant="light">未绑定</Tag>
          )}
        </div>
        {code ? (
          <div className="bind-code-box">
            <div className="bind-code">
              {code.code.slice(0, 4)} {code.code.slice(4)}
            </div>
            <div className="muted">有效期至 {fmtDateTime(code.expiresAt)}，只能使用一次</div>
          </div>
        ) : null}
        <div className="muted">
          教练在小程序「我的」页底部点「教练入口」，输入绑定码即可。
          {current.bound && '已绑定的教练用新微信绑定后，原微信会退出。'}
        </div>
        <Space>
          <Button onClick={generate}>{code ? '重新生成' : '生成绑定码'}</Button>
          {current.bound && (
            <Popconfirm
              theme="warning"
              content="解除后教练需重新绑定才能使用教练入口。"
              confirmBtn={{ content: '解除绑定', theme: 'danger' }}
              cancelBtn="返回"
              onConfirm={unbind}
            >
              <Button variant="outline" theme="danger">
                解除绑定
              </Button>
            </Popconfirm>
          )}
        </Space>
      </Space>
    </Dialog>
  )
}

/** Edits a coach's weekly hours and days off, the same ones the coach sets in the mini program. */
export function CoachHoursDialog({ coach, onClose }: { coach: Coach; onClose: () => void }) {
  const { data, error, reload } = useApi<CoachHoursDto>(`/admin/coaches/${coach.id}/hours`)
  const [hours, setHours] = useState<WeeklyHours[] | null>(null)
  const [dayOff, setDayOff] = useState('')

  useEffect(() => {
    if (data && hours === null) setHours(data.hours)
  }, [data, hours])

  const rows = (hours ?? []).map((h, i) => ({ ...h, key: i }))
  const lengths = data?.lessonMinutes ?? []
  const invalid = hours ? weeklyHoursError(hours) : null
  const update = (i: number, patch: Partial<WeeklyHours>) =>
    setHours((hours ?? []).map((h, j) => (j === i ? { ...h, ...patch } : h)))

  const save = async () => {
    if (!hours || invalid) return
    let result: SlotSyncDto | undefined
    const ok = await attempt(async () => {
      result = await api<SlotSyncDto>('PUT', `/admin/coaches/${coach.id}/hours`, { hours })
    })
    if (ok && result) {
      void MessagePlugin.success(syncMessage(result, '已保存'))
      onClose()
    }
  }

  const toggleDayOff = async (date: string, off: boolean) => {
    let result: SlotSyncDto | undefined
    const ok = await attempt(async () => {
      result = await api<SlotSyncDto>(
        off ? 'PUT' : 'DELETE',
        `/admin/coaches/${coach.id}/days-off/${date}`,
      )
    })
    if (ok && result) {
      void MessagePlugin.info(syncMessage(result, off ? `${date} 设为休息日` : `${date} 恢复接课`))
      setDayOff('')
      await reload()
    }
  }

  return (
    <Dialog
      visible
      width={760}
      header={`${coach.name} 的可约时间`}
      confirmBtn={{ content: '保存每周时间', disabled: !!invalid || !hours }}
      onConfirm={save}
      onClose={onClose}
    >
      {error && <Alert theme="error" message={error} />}
      {data && lengths.length === 0 && (
        <Alert theme="warning" message="该教练还没有启用中的课程，先在教练设置里勾选所教课程。" />
      )}
      {data && lengths.length > 0 && (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <DataTable
            rowKey="key"
            size="small"
            data={rows}
            empty="还没有每周时间"
            columns={[
              {
                colKey: 'weekday',
                title: '星期',
                width: 120,
                cell: ({ row }) => (
                  <Select
                    value={row.weekday}
                    options={WEEK_ORDER.map((d) => ({ label: WEEKDAYS[d], value: d }))}
                    onChange={(v) => update(row.key, { weekday: Number(v) })}
                  />
                ),
              },
              {
                colKey: 'time',
                title: '时间',
                width: 280,
                cell: ({ row }) => (
                  <Space align="center" size={4}>
                    <TimePicker
                      style={{ width: 112 }}
                      format="HH:mm"
                      steps={[1, 5]}
                      clearable={false}
                      value={hhmm(row.startMinute)}
                      onChange={(v) => update(row.key, { startMinute: minutes(String(v)) })}
                    />
                    至
                    <TimePicker
                      style={{ width: 112 }}
                      format="HH:mm"
                      steps={[1, 5]}
                      clearable={false}
                      value={hhmm(row.endMinute)}
                      onChange={(v) => update(row.key, { endMinute: minutes(String(v)) })}
                    />
                  </Space>
                ),
              },
              {
                colKey: 'lessonMinutes',
                title: '每节',
                width: 130,
                cell: ({ row }) => (
                  <Select
                    value={row.lessonMinutes}
                    options={lengths.map((m) => ({ label: `${m} 分钟`, value: m }))}
                    onChange={(v) => update(row.key, { lessonMinutes: Number(v) })}
                  />
                ),
              },
              {
                colKey: 'count',
                title: '节数',
                width: 64,
                cell: ({ row }) =>
                  Math.max(0, Math.floor((row.endMinute - row.startMinute) / row.lessonMinutes)),
              },
              {
                colKey: 'op',
                title: '',
                width: 64,
                cell: ({ row }) => (
                  <Button
                    variant="text"
                    theme="danger"
                    onClick={() => setHours((hours ?? []).filter((_, j) => j !== row.key))}
                  >
                    删除
                  </Button>
                ),
              },
            ]}
          />
          <Space align="center">
            <Button
              variant="outline"
              onClick={() =>
                setHours([
                  ...(hours ?? []),
                  {
                    weekday: 1,
                    startMinute: 9 * 60,
                    endMinute: 12 * 60,
                    lessonMinutes: lengths[0] ?? 60,
                  },
                ])
              }
            >
              添加时间段
            </Button>
            {invalid && <span className="danger-text">{invalid}</span>}
          </Space>
          <div className="muted">
            保存后自动生成未来 {data.advanceDays} 天的时段，每小时滚动补齐。已被预约的课程不受影响。
          </div>

          <div>
            <div className="subhead">休息日</div>
            <Space align="center" breakLine>
              {data.daysOff.map((d) => (
                <Tag key={d} closable onClose={() => toggleDayOff(d, false)}>
                  {d}
                </Tag>
              ))}
              <DatePicker
                value={dayOff}
                placeholder="添加休息日"
                allowInput
                disableDate={{ before: today() }}
                onChange={(v) => {
                  const date = String(v ?? '')
                  setDayOff(date)
                  if (date) void toggleDayOff(date, true)
                }}
              />
            </Space>
            <div className="muted" style={{ marginTop: 8 }}>
              休息日立即生效：当天空闲时段关闭，已预约的课程需单独取消。
            </div>
          </div>
        </Space>
      )}
    </Dialog>
  )
}
