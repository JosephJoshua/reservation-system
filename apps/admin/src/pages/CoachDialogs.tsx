import {
  type HoursPeriod,
  hoursOn,
  type ScheduleConflictDto,
  type ScheduleExceptionDto,
  type ScheduleViewDto,
  type WeeklyHours,
  weeklyHoursError,
} from '@rs/shared'
import { useEffect, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Checkbox,
  DatePicker,
  Dialog,
  Input,
  Popconfirm,
  Radio,
  Space,
  Tag,
  TimePicker,
} from 'tdesign-react'
import { api, RequestError } from '../api'
import { addDays, fmtDate, fmtDateTime, fmtTime, fmtWeekday, today, venueIso } from '../format'
import { attempt, newKey, onceKey, useActionKeys, useApi, useIsPhone } from '../hooks'
import type { Coach } from '../types'

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]

const hhmm = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
/** A picker's HH:mm as minutes; as an end time, 00:00 is the midnight that ends the day. */
const minutes = (v: string, end = false) => {
  const m = Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5))
  return end && m === 0 ? 24 * 60 : m
}

/** One line per weekday with hours. */
export function hoursSummary(hours: WeeklyHours[]) {
  const days = WEEK_ORDER.flatMap((d) => {
    const windows = hours
      .filter((h) => h.weekday === d)
      .sort((a, b) => a.startMinute - b.startMinute)
      .map((h) => `${hhmm(h.startMinute)}-${hhmm(h.endMinute)}`)
    return windows.length ? [`${WEEKDAYS[d]} ${windows.join('、')}`] : []
  })
  return days.length ? days.join('；') : '不接课'
}

/** 10-25 周日 09:00-12:00, or a span over several days. */
export function spanText(startsAt: string, endsAt: string) {
  const last = new Date(Date.parse(endsAt) - 1)
  const end = fmtTime(endsAt) === '00:00' ? '24:00' : fmtTime(endsAt)
  const day = (iso: string | Date) => `${fmtDate(iso).slice(5)} ${fmtWeekday(iso)}`
  if (fmtDate(startsAt) === fmtDate(last)) {
    return fmtTime(startsAt) === '00:00' && end === '24:00'
      ? `${day(startsAt)} 全天`
      : `${day(startsAt)} ${fmtTime(startsAt)}-${end}`
  }
  return fmtTime(startsAt) === '00:00' && end === '24:00'
    ? `${day(startsAt)} 至 ${day(last)}`
    : `${day(startsAt)} ${fmtTime(startsAt)} 至 ${day(endsAt)} ${fmtTime(endsAt)}`
}

/** Lessons a 排班 change left outside it or in 请假, for the desk to move or cancel. */
export function ConflictList({
  conflicts,
  what,
}: {
  conflicts: ScheduleConflictDto[]
  what: string
}) {
  if (!conflicts.length) return null
  return (
    <Alert
      theme="warning"
      message={
        <div>
          <div>
            有 {conflicts.length} 节课{what}，课程不会自动取消，请改约或取消：
          </div>
          {conflicts.slice(0, 8).map((c) => (
            <div key={`${c.slotId}-${c.bookingId}`}>
              {spanText(c.startsAt, c.endsAt)} {c.coachName} {c.title}
              {c.group && '（小班课）'}
            </div>
          ))}
          {conflicts.length > 8 && <div>等 {conflicts.length} 节</div>}
        </div>
      }
    />
  )
}

/** Shows the coach's WeChat binding and hands out bind codes. */
export function CoachBindingDialog({ coach, onClose }: { coach: Coach; onClose: () => void }) {
  const [current, setCurrent] = useState(coach)
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(
    coach.bindCode && coach.bindCodeExpiresAt
      ? { code: coach.bindCode, expiresAt: coach.bindCodeExpiresAt }
      : null,
  )

  const keys = useActionKeys()
  const generate = () =>
    attempt(async () => {
      setCode(
        await api('POST', `/admin/coaches/${coach.id}/bind-code`, undefined, {
          key: keys.get('bind-code'),
        }),
      )
      // 重新生成 later makes another code.
      keys.done('bind-code')
    })

  const unbind = () =>
    attempt(async () => {
      await api('DELETE', `/admin/coaches/${coach.id}/binding`, undefined, {
        key: keys.get('unbind'),
      })
      keys.done('unbind')
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
          {current.bound && '已绑定的教练用新的微信绑定后，原来的微信会退出登录。'}
        </div>
        <Space>
          <Button onClick={generate}>{code ? '重新生成' : '生成绑定码'}</Button>
          {current.bound && (
            <Popconfirm
              theme="warning"
              content="解除后，教练需要重新绑定才能使用教练入口。"
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

/**
 * A coach's 排班, the same one the coach keeps in the mini program: weekly hours from a date on,
 * and 请假 and 加班 on given days. 闭馆 is shown here and kept in the settings.
 */
export function CoachScheduleDialog({ coach, onClose }: { coach: Coach; onClose: () => void }) {
  const { data, error, reload } = useApi<ScheduleViewDto>(`/admin/coaches/${coach.id}/hours`)
  const [from, setFrom] = useState(today)
  const [hours, setHours] = useState<WeeklyHours[] | null>(null)
  const [dirty, setDirty] = useState(false)
  // Weekdays edited since the hours were loaded, kept when 生效日期 moves.
  const [touched, setTouched] = useState<Set<number>>(() => new Set())
  const touch = (...weekdays: number[]) => {
    setTouched(new Set([...touched, ...weekdays]))
    setDirty(true)
  }
  const timeWidth = useIsPhone() ? 88 : 104
  const [conflicts, setConflicts] = useState<{ list: ScheduleConflictDto[]; what: string } | null>(
    null,
  )
  // One per save, so a retry after a lost response is not saved twice.
  const [saveKey, setSaveKey] = useState(newKey)
  // Set when a save was refused over a newer change: the hours reloaded fill the days not edited.
  const merge = useRef(false)

  // Hours that only start later read as 不接课 today: open on the first week with hours.
  const [opened, setOpened] = useState(false)
  useEffect(() => {
    if (!data || opened) return
    setOpened(true)
    const next = data.periods.find((p) => p.hours.length)
    if (!hoursOn(data.periods, today()).length && next) setFrom(next.from)
  }, [data, opened])

  // The hours as they stand from the chosen date, until edited.
  useEffect(() => {
    if (data && !dirty) {
      setHours(hoursOn(data.periods, from))
      setTouched(new Set())
    }
  }, [data, from, dirty])

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when newer hours arrive
  useEffect(() => {
    if (!data || !merge.current) return
    merge.current = false
    if (dirty) {
      setHours([
        ...hoursOn(data.periods, from).filter((h) => !touched.has(h.weekday)),
        ...(hours ?? []).filter((h) => touched.has(h.weekday)),
      ])
    }
  }, [data])

  /** Moves 生效日期, keeping the days edited and taking the rest as they stand then. */
  const changeFrom = (next: string) => {
    if (dirty && data) {
      setHours([
        ...hoursOn(data.periods, next).filter((h) => !touched.has(h.weekday)),
        ...(hours ?? []).filter((h) => touched.has(h.weekday)),
      ])
    }
    setFrom(next)
  }

  const rows = (hours ?? []).map((h, i) => ({ ...h, key: i }))
  const invalid = hours ? weeklyHoursError(hours) : null
  const update = (i: number, patch: Partial<WeeklyHours>) => {
    setHours((hours ?? []).map((h, j) => (j === i ? { ...h, ...patch } : h)))
    touch((hours ?? [])[i]?.weekday ?? 0)
  }
  const planned = (data?.periods ?? []).filter((p: HoursPeriod) => p.from > today())
  // Saving from a date replaces the changes planned after it.
  const replaced = (data?.periods ?? []).filter((p: HoursPeriod) => p.from > from)
  /** A new time on a weekday: an hour after its last one, or 09:00-12:00 on a free day. */
  const addWindow = (weekday: number) => {
    const last = Math.max(0, ...rows.filter((r) => r.weekday === weekday).map((r) => r.endMinute))
    // An hour after the day's last window, or right after it late in the evening.
    const start = !last ? 9 * 60 : last <= 20 * 60 ? last + 60 : Math.min(last, 23 * 60)
    setHours([
      ...(hours ?? []),
      { weekday, startMinute: start, endMinute: Math.min(start + 3 * 60, 24 * 60) },
    ])
    touch(weekday)
  }

  const save = async () => {
    if (!hours || invalid) return
    let result: { conflicts: ScheduleConflictDto[] } | undefined
    const ok = await attempt(
      async () => {
        // Checked against the hours as loaded: the coach may have changed them meanwhile.
        result = await api<{ conflicts: ScheduleConflictDto[] }>(
          'PUT',
          `/admin/coaches/${coach.id}/hours`,
          { from, hours },
          { key: saveKey, ifMatch: data?.hoursVersion },
        ).catch((e) => {
          throw e instanceof RequestError && e.code === 'edited_elsewhere'
            ? new RequestError(
                e.status,
                e.code,
                '排班刚被其他人修改，已载入最新的时间，请核对后再保存',
              )
            : e
        })
      },
      '已保存每周时间',
      {
        stale: ['edited_elsewhere'],
        // Loads the newer hours, keeping the weekdays edited here.
        onStale: async () => {
          setSaveKey(newKey())
          merge.current = true
          await reload()
        },
      },
    )
    if (ok && result) {
      setSaveKey(newKey())
      setDirty(false)
      setConflicts({ list: result.conflicts, what: '不在新的排班里' })
      await reload()
    }
  }

  const remove = async (e: ScheduleExceptionDto) => {
    let result: { conflicts: ScheduleConflictDto[] } | undefined
    const ok = await attempt(
      async () => {
        result = await api('DELETE', `/admin/coaches/${coach.id}/exceptions/${e.id}`, undefined, {
          key: onceKey(`delete-exception-${e.id}`),
        })
      },
      e.kind === 'off' ? '已取消请假' : '已取消加班',
    )
    if (ok) {
      // Lessons booked in a 加班 stay, now outside 排班.
      if (result?.conflicts.length) setConflicts({ list: result.conflicts, what: '不在排班里' })
      await reload()
    }
  }

  return (
    <Dialog
      visible
      width={800}
      header={`${coach.name} 的排班`}
      confirmBtn={{ content: '保存每周时间', disabled: !!invalid || !hours || !dirty }}
      cancelBtn="关闭"
      onConfirm={save}
      onClose={onClose}
    >
      {error && <Alert theme="error" message={error} />}
      {data && (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          {conflicts && <ConflictList conflicts={conflicts.list} what={conflicts.what} />}
          <div>
            <div className="subhead">每周时间</div>
            <div className="week-hours">
              {WEEK_ORDER.map((d) => {
                const windows = rows.filter((r) => r.weekday === d)
                return (
                  <div key={d} className="week-day">
                    <span className="week-day-name">{WEEKDAYS[d]}</span>
                    <div className="week-day-windows">
                      {windows.length === 0 && <span className="muted">不接课</span>}
                      {windows.map((row) => (
                        <Space key={row.key} align="center" size={4}>
                          <TimePicker
                            style={{ width: timeWidth }}
                            format="HH:mm"
                            allowInput
                            steps={[1, 5]}
                            clearable={false}
                            value={hhmm(row.startMinute)}
                            onChange={(v) => update(row.key, { startMinute: minutes(String(v)) })}
                          />
                          至
                          <TimePicker
                            style={{ width: timeWidth }}
                            format="HH:mm"
                            allowInput
                            steps={[1, 5]}
                            clearable={false}
                            value={hhmm(row.endMinute % (24 * 60))}
                            onChange={(v) =>
                              update(row.key, { endMinute: minutes(String(v), true) })
                            }
                          />
                          <Button
                            variant="text"
                            theme="danger"
                            onClick={() => {
                              setHours((hours ?? []).filter((_, j) => j !== row.key))
                              touch(row.weekday)
                            }}
                          >
                            删除
                          </Button>
                        </Space>
                      ))}
                      <Button variant="text" theme="primary" onClick={() => addWindow(d)}>
                        添加
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
            <Space align="center" breakLine style={{ marginTop: 12 }}>
              <span>生效日期</span>
              <DatePicker
                value={from}
                clearable={false}
                disableDate={{ before: today(), after: addDays(today(), 366) }}
                onChange={(v) => changeFrom(String(v || today()))}
              />
              {invalid && <span className="danger-text">{invalid}</span>}
              {dirty && replaced.length > 0 && (
                <span className="warning-text">
                  保存后，{replaced.map((p) => p.from.slice(5)).join('、')} 起已安排的调整会被替换
                </span>
              )}
            </Space>
            <div className="muted" style={{ marginTop: 8 }}>
              学员可在这些时间里按课程时长预约，结束时间 00:00 为当天 24
              点。改动从生效日期起算，已约的课不受影响。
            </div>
          </div>

          {planned.length > 0 && (
            <div>
              <div className="subhead">已安排的调整</div>
              {planned.map((p) => (
                <div key={p.from}>
                  {p.from} 起：{hoursSummary(p.hours)}
                </div>
              ))}
              <div className="muted">从更早的日期保存每周时间，会替换之后已安排的调整。</div>
            </div>
          )}

          <div>
            <div className="subhead">请假和加班</div>
            {data.exceptions.length + data.closures.length === 0 ? (
              <div className="muted">没有请假和加班</div>
            ) : (
              <div className="exception-list">
                {[...data.exceptions, ...data.closures]
                  .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
                  .map((e) => (
                    <div key={e.id} className="exception-row">
                      <Tag
                        variant="light"
                        theme={
                          e.coachId === null ? 'default' : e.kind === 'off' ? 'warning' : 'primary'
                        }
                      >
                        {e.coachId === null ? '闭馆' : e.kind === 'off' ? '请假' : '加班'}
                      </Tag>
                      <span>{spanText(e.startsAt, e.endsAt)}</span>
                      <span className="muted">
                        {[e.note, e.byStaff === null ? '教练添加' : e.byStaff]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                      {e.coachId === null ? (
                        <span className="muted">在设置里管理</span>
                      ) : (
                        <Popconfirm
                          theme="warning"
                          content={
                            e.kind === 'off'
                              ? '取消后这段时间重新开放预约'
                              : '取消后这段时间不再开放预约，已约的课不受影响'
                          }
                          confirmBtn={{ content: '取消', theme: 'danger' }}
                          cancelBtn="保留"
                          onConfirm={() => remove(e)}
                        >
                          <Button variant="text" theme="danger" size="small">
                            {Date.parse(e.startsAt) <= Date.now() ? '提前结束' : '取消'}
                          </Button>
                        </Popconfirm>
                      )}
                    </div>
                  ))}
              </div>
            )}
            <ExceptionForm
              path={`/admin/coaches/${coach.id}/exceptions`}
              onAdded={async (list) => {
                setConflicts(list.length ? { list, what: '在请假时间里' } : null)
                await reload()
              }}
            />
          </div>
        </Space>
      )}
    </Dialog>
  )
}

/**
 * Adds a 请假 or 加班 for a coach, or 闭馆 for the venue (`closure`): whole days, or a time on one
 * day.
 */
export function ExceptionForm({
  path,
  closure = false,
  onAdded,
}: {
  path: string
  closure?: boolean
  onAdded: (conflicts: ScheduleConflictDto[], kind: 'off' | 'extra') => void | Promise<void>
}) {
  const [kind, setKind] = useState<'off' | 'extra'>('off')
  const [wholeDays, setWholeDays] = useState(true)
  const [range, setRange] = useState<[string, string]>([today(), today()])
  const [start, setStart] = useState('09:00')
  const [end, setEnd] = useState('12:00')
  const [note, setNote] = useState('')
  // One per addition, so a retry after a lost response does not add it twice.
  const [key, setKey] = useState(newKey)
  const whole = kind === 'off' && wholeDays
  // An end at or before the start on one date means past midnight.
  const timeError =
    whole || end === '00:00' || end > start
      ? null
      : kind === 'extra' && !closure
        ? '加班不能跨到第二天'
        : '结束时间需晚于开始时间'

  const add = async () => {
    if (timeError) return
    const [first, last] = range
    const body = whole
      ? {
          startsAt: venueIso(first, '00:00'),
          endsAt: venueIso(addDays(last, 1), '00:00'),
        }
      : {
          startsAt: venueIso(first, start),
          endsAt: end === '00:00' ? venueIso(addDays(first, 1), '00:00') : venueIso(first, end),
        }
    let result: { conflicts: ScheduleConflictDto[] } | undefined
    const ok = await attempt(
      async () => {
        result = await api('POST', path, { ...(closure ? {} : { kind }), ...body, note }, { key })
      },
      closure ? '已添加闭馆' : kind === 'off' ? '已添加请假' : '已添加加班',
    )
    if (ok && result) {
      setKey(newKey())
      setNote('')
      await onAdded(result.conflicts, kind)
    }
  }

  return (
    <div className="exception-form">
      {!closure && (
        <Radio.Group
          variant="default-filled"
          value={kind}
          onChange={(v) => setKind(v as 'off' | 'extra')}
        >
          <Radio.Button value="off">请假</Radio.Button>
          <Radio.Button value="extra">加班</Radio.Button>
        </Radio.Group>
      )}
      {kind === 'off' && (
        <Checkbox checked={wholeDays} onChange={(v) => setWholeDays(Boolean(v))}>
          全天
        </Checkbox>
      )}
      {whole ? (
        <Space align="center" breakLine size={8}>
          <DatePicker
            value={range[0]}
            clearable={false}
            disableDate={{ before: today() }}
            onChange={(v) => {
              const d = String(v || today())
              setRange([d, [d, range[1]].sort()[1] ?? d])
            }}
          />
          {/* 至 wraps with the end date on a phone, not after the start. */}
          <Space align="center" size={8}>
            <span>至</span>
            <DatePicker
              value={range[1]}
              clearable={false}
              disableDate={{ before: range[0] }}
              onChange={(v) => setRange([range[0], String(v || range[0])])}
            />
          </Space>
        </Space>
      ) : (
        <Space align="center" breakLine size={8}>
          <DatePicker
            value={range[0]}
            clearable={false}
            disableDate={{ before: today() }}
            onChange={(v) => {
              const d = String(v || today())
              setRange([d, d])
            }}
          />
          <TimePicker
            style={{ width: 100 }}
            format="HH:mm"
            steps={[1, 5]}
            clearable={false}
            value={start}
            onChange={(v) => setStart(String(v))}
          />
          <span>至</span>
          <TimePicker
            style={{ width: 100 }}
            format="HH:mm"
            steps={[1, 5]}
            clearable={false}
            value={end}
            onChange={(v) => setEnd(String(v))}
          />
        </Space>
      )}
      <Input
        style={{ maxWidth: 240 }}
        placeholder="备注（选填）"
        maxlength={40}
        value={note}
        onChange={(v) => setNote(String(v))}
      />
      <Button variant="outline" disabled={!!timeError} onClick={add}>
        添加{closure ? '闭馆' : kind === 'off' ? '请假' : '加班'}
      </Button>
      {timeError && <span className="danger-text">{timeError}</span>}
    </div>
  )
}

/** Venue-wide 闭馆, for the settings page. */
export function Closures() {
  const { data, error, reload } = useApi<ScheduleExceptionDto[]>('/admin/closures')
  const [conflicts, setConflicts] = useState<ScheduleConflictDto[]>([])
  const remove = async (id: number) => {
    const del = () =>
      api('DELETE', `/admin/closures/${id}`, undefined, { key: onceKey(`delete-closure-${id}`) })
    if (await attempt(del, '已删除闭馆')) await reload()
  }
  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {conflicts.length > 0 && <ConflictList conflicts={conflicts} what="在闭馆时间里" />}
      {error ? (
        <span className="danger-text">{error}</span>
      ) : !data?.length ? (
        <span className="muted">没有安排闭馆</span>
      ) : (
        <div className="exception-list">
          {data.map((e) => (
            <div key={e.id} className="exception-row">
              <span>{spanText(e.startsAt, e.endsAt)}</span>
              <span className="muted">{[e.note, e.byStaff].filter(Boolean).join(' · ')}</span>
              <Popconfirm
                theme="warning"
                content="删除后这段时间按各教练排班开放预约"
                confirmBtn={{ content: '删除', theme: 'danger' }}
                cancelBtn="保留"
                onConfirm={() => remove(e.id)}
              >
                <Button variant="text" theme="danger" size="small">
                  {Date.parse(e.startsAt) <= Date.now() ? '提前结束' : '删除'}
                </Button>
              </Popconfirm>
            </div>
          ))}
        </div>
      )}
      <ExceptionForm
        path="/admin/closures"
        closure
        onAdded={async (list) => {
          setConflicts(list)
          await reload()
        }}
      />
      <div className="muted">
        闭馆期间所有教练都不开放预约，小班课也不能排。已约的课不会自动取消。
      </div>
    </Space>
  )
}
