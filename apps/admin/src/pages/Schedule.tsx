import { venueDateKey, venueInstant } from '@rs/shared'
import { useEffect, useMemo, useState } from 'react'
import {
  Button,
  Checkbox,
  DateRangePicker,
  Dialog,
  Input,
  InputNumber,
  MessagePlugin,
  Popconfirm,
  Select,
  Space,
  Tag,
  Textarea,
} from 'tdesign-react'
import { api } from '../api'
import { Field } from '../Field'
import { addDays, fmtDate, fmtTime, fmtWeekday, today, venueIso } from '../format'
import { attempt, useApi, useIdempotencyKey, useIsPhone, useSubmitting } from '../hooks'
import { bookingStatusLabel } from '../labels'
import type { Coach, LessonType, Slot } from '../types'

/** The second line of a slot in the week grid. */
function slotLabel(s: Slot) {
  const b = s.booking
  if (!b) {
    if (new Date(s.startsAt) <= new Date()) return '已过'
    return s.open ? '可预约' : '已关闭'
  }
  const state =
    b.status === 'pending_payment'
      ? '待支付'
      : b.status !== 'completed'
        ? '已约'
        : b.attendance
          ? ATTENDANCE[b.attendance]
          : '未签到'
  return `${b.student?.name || '学员'} · ${state}`
}

const ATTENDANCE = { attended: '已到课', no_show: '缺席' } as const

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']
// Matches the API's limit per request.
const MAX_SLOTS = 500

/** Monday of the venue week containing `dateKey`. */
function mondayOf(dateKey: string) {
  const day = venueInstant(dateKey, 12 * 60).getUTCDay() // noon at the venue is the same UTC day
  return addDays(dateKey, -((day + 6) % 7))
}

export function Schedule() {
  const coaches = useApi<Coach[]>('/admin/coaches')
  const types = useApi<LessonType[]>('/admin/lesson-types')
  const [coachId, setCoachId] = useState<number | null>(null)
  const [week, setWeek] = useState(() => mondayOf(today()))
  const [creating, setCreating] = useState(false)
  const [selected, setSelected] = useState<Slot | null>(null)

  const active = (coaches.data ?? []).filter((c) => c.active)
  useEffect(() => {
    if (coachId === null && active[0]) setCoachId(active[0].id)
  }, [active, coachId])

  const from = venueInstant(week, 0).toISOString()
  const to = venueInstant(addDays(week, 7), 0).toISOString()
  const slots = useApi<Slot[]>(
    coachId
      ? `/admin/slots?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&coachId=${coachId}`
      : null,
  )

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(week, i)), [week])
  // A phone shows one day of the week at a time.
  const phone = useIsPhone()
  const [day, setDay] = useState(today)
  const shownDay = days.includes(day) ? day : (days[0] ?? day)

  return (
    <div>
      <div className="toolbar">
        <Select
          style={{ width: 180 }}
          value={coachId ?? undefined}
          placeholder="选择教练"
          options={active.map((c) => ({ label: c.name, value: c.id }))}
          onChange={(v) => setCoachId(Number(v))}
        />
        <div className="week-nav">
          <Button variant="outline" onClick={() => setWeek(addDays(week, -7))}>
            上一周
          </Button>
          <span>
            {phone
              ? `${week.slice(5)} 至 ${addDays(week, 6).slice(5)}`
              : `${week} 至 ${addDays(week, 6)}`}
          </span>
          <Button variant="outline" onClick={() => setWeek(addDays(week, 7))}>
            下一周
          </Button>
          <Button
            variant="text"
            onClick={() => {
              setWeek(mondayOf(today()))
              setDay(today())
            }}
          >
            本周
          </Button>
        </div>
        <span className="spacer" />
        <Button disabled={!coachId} onClick={() => setCreating(true)}>
          批量排课
        </Button>
      </div>

      {active.length === 0 && !coaches.loading && (
        <p className="muted">先在“课程与教练”里添加教练</p>
      )}

      {phone && (
        <div className="day-strip">
          {days.map((d, i) => (
            <button
              type="button"
              key={d}
              className={`day-tab${d === shownDay ? ' active' : ''}`}
              onClick={() => setDay(d)}
            >
              周{WEEKDAYS[i]}
              <br />
              {d.slice(8)}
            </button>
          ))}
        </div>
      )}

      <div className="week-scroll">
        <div className={phone ? 'day-grid' : 'week-grid'}>
          {days.map((d, i) => {
            if (phone && d !== shownDay) return null
            const daySlots = (slots.data ?? []).filter(
              (s) => venueDateKey(new Date(s.startsAt)) === d,
            )
            return (
              <div key={d} className="week-day">
                <h4>
                  周{WEEKDAYS[i]} {d.slice(5)}
                  {d === today() && <span className="muted"> 今天</span>}
                </h4>
                {daySlots.length === 0 && <span className="muted">无时段</span>}
                {daySlots.map((s) => (
                  <button
                    type="button"
                    key={s.id}
                    className={`slot-chip${s.booking ? ' booked' : ''}${s.open ? '' : ' closed'}`}
                    onClick={() => setSelected(s)}
                  >
                    {fmtTime(s.startsAt)}-{fmtTime(s.endsAt)}
                    <br />
                    {slotLabel(s)}
                  </button>
                ))}
              </div>
            )
          })}
        </div>
      </div>

      {creating && coachId && (
        <CreateSlots
          coachId={coachId}
          durations={[
            ...new Set((types.data ?? []).filter((t) => t.active).map((t) => t.durationMinutes)),
          ]}
          initialFrom={week}
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false)
            void slots.reload()
          }}
        />
      )}

      {selected && (
        <SlotDialog
          slot={selected}
          onClose={() => setSelected(null)}
          onChanged={() => {
            setSelected(null)
            void slots.reload()
          }}
        />
      )}
    </div>
  )
}

function parseTimes(text: string): string[] | null {
  const parts = text
    .split(/[,，\s]+/)
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length === 0) return null
  const out: string[] = []
  for (const p of parts) {
    const m = /^(\d{1,2})[:：](\d{2})$/.exec(p)
    if (!m) return null
    const h = Number(m[1])
    const min = Number(m[2])
    if (h > 23 || min > 59) return null
    out.push(`${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`)
  }
  return [...new Set(out)].sort()
}

function CreateSlots({
  coachId,
  durations,
  initialFrom,
  onClose,
  onDone,
}: {
  coachId: number
  durations: number[]
  initialFrom: string
  onClose: () => void
  onDone: () => void
}) {
  const start = initialFrom < today() ? today() : initialFrom
  const [range, setRange] = useState<[string, string]>([
    start,
    addDays(initialFrom, 6) < start ? addDays(start, 6) : addDays(initialFrom, 6),
  ])
  const [weekdays, setWeekdays] = useState<number[]>([0, 1, 2, 3, 4, 5, 6])
  const [times, setTimes] = useState('09:00, 10:00, 14:00, 15:00, 16:00')
  const [minutes, setMinutes] = useState(durations[0] ?? 60)
  const submitting = useSubmitting()
  const key = useIdempotencyKey()

  const parsed = useMemo(() => parseTimes(times), [times])
  const dates = useMemo(() => {
    const out: string[] = []
    for (let d = range[0]; d <= range[1]; d = addDays(d, 1)) {
      const wd = (venueInstant(d, 12 * 60).getUTCDay() + 6) % 7
      if (weekdays.includes(wd)) out.push(d)
    }
    return out
  }, [range, weekdays])
  // Times already past are skipped, so a range starting today still works.
  const planned = useMemo(() => {
    if (!parsed) return []
    const now = Date.now()
    return dates.flatMap((d) =>
      parsed.flatMap((t) => {
        const startsAt = venueIso(d, t)
        if (new Date(startsAt).getTime() <= now) return []
        return [
          {
            coachId,
            startsAt,
            endsAt: new Date(new Date(startsAt).getTime() + minutes * 60_000).toISOString(),
          },
        ]
      }),
    )
  }, [parsed, dates, coachId, minutes])
  const count = planned.length

  const submit = async () => {
    if (!parsed) {
      void MessagePlugin.warning('时间格式应为 09:00，多个用逗号分隔')
      return
    }
    if (count === 0) {
      void MessagePlugin.warning('没有要创建的时段')
      return
    }
    if (count > MAX_SLOTS) {
      void MessagePlugin.warning(`一次最多创建 ${MAX_SLOTS} 个时段，请缩短日期范围`)
      return
    }
    if (
      await attempt(
        () => api('POST', '/admin/slots', { slots: planned }, { key }),
        `已创建 ${count} 个时段`,
        { onStale: onDone },
      )
    )
      onDone()
  }

  return (
    <Dialog
      visible
      width={560}
      header="批量排课"
      confirmBtn={{ content: `创建 ${count} 个时段`, loading: submitting }}
      onConfirm={submit}
      onClose={onClose}
    >
      <div className="fields">
        <Field label="日期">
          <DateRangePicker
            value={range}
            disableDate={{ before: today() }}
            onChange={(v) => setRange([String(v[0] ?? ''), String(v[1] ?? '')])}
          />
        </Field>
        <Field label="星期">
          <Checkbox.Group value={weekdays} onChange={(v) => setWeekdays(v as number[])}>
            {WEEKDAYS.map((w, i) => (
              <Checkbox key={w} value={i}>
                周{w}
              </Checkbox>
            ))}
          </Checkbox.Group>
        </Field>
        <Field label="开始时间" help="多个用逗号分隔，如 09:00, 10:30">
          <Input
            value={times}
            status={parsed ? 'default' : 'error'}
            onChange={(v) => setTimes(String(v))}
          />
        </Field>
        <Field label="时长" help="需与课程时长一致，学员才能预约">
          <Space>
            <InputNumber
              theme="normal"
              value={minutes}
              min={15}
              max={480}
              step={15}
              suffix="分钟"
              onChange={(v) => setMinutes(Number(v) || 60)}
            />
            {durations.map((d) => (
              <Tag
                key={d}
                variant={d === minutes ? 'dark' : 'outline'}
                theme="primary"
                className="pick-tag"
                onClick={() => setMinutes(d)}
              >
                {d} 分钟
              </Tag>
            ))}
          </Space>
        </Field>
      </div>
    </Dialog>
  )
}

function SlotDialog({
  slot,
  onClose,
  onChanged,
}: {
  slot: Slot
  onClose: () => void
  onChanged: () => void
}) {
  const [reason, setReason] = useState('')
  const [cancelling, setCancelling] = useState(false)
  const submitting = useSubmitting()
  const b = slot.booking
  const status = b ? bookingStatusLabel[b.status as keyof typeof bookingStatusLabel] : null
  const started = new Date(slot.startsAt) <= new Date()

  const toggle = async () => {
    if (
      await attempt(
        () => api('PATCH', `/admin/slots/${slot.id}`, { open: !slot.open }),
        slot.open ? '已关闭' : '已开放',
        { onStale: onChanged },
      )
    )
      onChanged()
  }
  const remove = async () => {
    if (
      await attempt(() => api('DELETE', `/admin/slots/${slot.id}`), '已删除', {
        onStale: onChanged,
      })
    )
      onChanged()
  }
  const cancel = async () => {
    if (!b || !reason.trim()) return
    if (
      await attempt(
        () => api('POST', `/admin/bookings/${b.id}/cancel`, { reason }),
        '已取消，学员将收到全额退款或退回课时',
        { onStale: onChanged },
      )
    )
      onChanged()
  }

  return (
    <Dialog
      visible
      width={480}
      header={`${fmtDate(slot.startsAt).slice(5)} ${fmtWeekday(slot.startsAt)} ${fmtTime(slot.startsAt)}-${fmtTime(slot.endsAt)}`}
      footer={false}
      onClose={onClose}
    >
      <Space direction="vertical" style={{ width: '100%' }}>
        {b ? (
          <div>
            <Space>
              <span>
                {b.student?.name || '未填写姓名'} {b.student?.phone}
              </span>
              {status && (
                <Tag theme={status[1]} variant="light">
                  {status[0]}
                </Tag>
              )}
            </Space>
          </div>
        ) : (
          <span className="muted">{slot.open ? '尚无预约' : '已关闭，学员看不到'}</span>
        )}

        {/* The API refuses to cancel a lesson that has ended. */}
        {b && !cancelling && new Date(slot.endsAt) > new Date() && (
          <Button theme="danger" variant="outline" onClick={() => setCancelling(true)}>
            场馆取消该预约
          </Button>
        )}
        {b && cancelling && (
          <>
            <Textarea
              placeholder="取消原因，学员可见"
              value={reason}
              maxlength={100}
              onChange={(v) => setReason(String(v))}
            />
            <Space>
              <Button
                theme="danger"
                disabled={!reason.trim()}
                loading={submitting}
                onClick={cancel}
              >
                确认取消并退款
              </Button>
              <Button variant="outline" onClick={() => setCancelling(false)}>
                返回
              </Button>
            </Space>
          </>
        )}

        <Space>
          {!started && (
            <Button variant="outline" loading={submitting} onClick={toggle}>
              {slot.open ? '关闭时段' : '重新开放'}
            </Button>
          )}
          {/* Slots from weekly hours would come back at the next sync, so they are only closed. */}
          {!b && slot.source === 'manual' && (
            <Popconfirm
              theme="danger"
              content="删除这个时段？"
              confirmBtn={{ content: '删除', theme: 'danger' }}
              cancelBtn="返回"
              onConfirm={remove}
            >
              <Button variant="text" theme="danger" loading={submitting}>
                删除时段
              </Button>
            </Popconfirm>
          )}
        </Space>
        {slot.open && b && <span className="muted">关闭时段不影响已有预约</span>}
      </Space>
    </Dialog>
  )
}
