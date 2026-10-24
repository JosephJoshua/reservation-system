import { venueDateKey, venueInstant } from '@rs/shared'
import { useEffect, useMemo, useRef, useState } from 'react'
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
import { BookForStudent } from '../BookForStudent'
import { Field } from '../Field'
import { addDays, fmtDate, fmtTime, fmtWeekday, today, venueIso } from '../format'
import { attempt, useApi, useIdempotencyKey, useIsPhone, useSubmitting } from '../hooks'
import { bookingStatusLabel } from '../labels'
import type { Coach, LessonType, Slot } from '../types'

/** The second line of a slot in the week grid. */
function slotLabel(s: Slot, types: LessonType[]) {
  if (s.lessonTypeId !== null) {
    const name = types.find((t) => t.id === s.lessonTypeId)?.name ?? '小班课'
    return s.cancelledAt ? `${name} · 已取消` : `${name} · ${s.bookings.length}/${s.capacity} 人`
  }
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
  const [creating, setCreating] = useState<'slots' | 'sessions' | null>(null)
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
        <Space>
          <Button variant="outline" disabled={!coachId} onClick={() => setCreating('sessions')}>
            排小班课
          </Button>
          <Button disabled={!coachId} onClick={() => setCreating('slots')}>
            批量排课
          </Button>
        </Space>
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
                    className={`slot-chip${s.bookings.length ? ' booked' : ''}${s.lessonTypeId !== null ? ' group' : ''}${s.open ? '' : ' closed'}`}
                    onClick={() => setSelected(s)}
                  >
                    {fmtTime(s.startsAt)}-{fmtTime(s.endsAt)}
                    <br />
                    {slotLabel(s, types.data ?? [])}
                  </button>
                ))}
              </div>
            )
          })}
        </div>
      </div>

      {creating === 'slots' && coachId && (
        <CreateSlots
          coachId={coachId}
          durations={[
            ...new Set(
              (types.data ?? [])
                .filter((t) => t.active && t.capacity === 1)
                .map((t) => t.durationMinutes),
            ),
          ]}
          initialFrom={week}
          onClose={() => setCreating(null)}
          onDone={() => {
            setCreating(null)
            void slots.reload()
          }}
        />
      )}

      {creating === 'sessions' && coachId && (
        <CreateSessions
          coach={active.find((c) => c.id === coachId)}
          types={(types.data ?? []).filter((t) => t.active && t.capacity > 1)}
          initialFrom={week}
          onClose={() => setCreating(null)}
          onDone={() => {
            setCreating(null)
            void slots.reload()
          }}
        />
      )}

      {selected && selected.lessonTypeId !== null && (
        <SessionDialog
          slot={selected}
          lessonType={(types.data ?? []).find((t) => t.id === selected.lessonTypeId)}
          onClose={() => setSelected(null)}
          onChanged={() => {
            setSelected(null)
            void slots.reload()
          }}
        />
      )}

      {selected && selected.lessonTypeId === null && (
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

/** The dates, weekdays and start times a batch of slots or sessions repeats on. */
function usePlan(initialFrom: string, initialTimes: string) {
  const start = initialFrom < today() ? today() : initialFrom
  const [range, setRange] = useState<[string, string]>([
    start,
    addDays(initialFrom, 6) < start ? addDays(start, 6) : addDays(initialFrom, 6),
  ])
  const [weekdays, setWeekdays] = useState<number[]>([0, 1, 2, 3, 4, 5, 6])
  const [times, setTimes] = useState(initialTimes)
  const parsed = useMemo(() => parseTimes(times), [times])
  const dates = useMemo(() => {
    const out: string[] = []
    for (let d = range[0]; d <= range[1]; d = addDays(d, 1)) {
      const wd = (venueInstant(d, 12 * 60).getUTCDay() + 6) % 7
      if (weekdays.includes(wd)) out.push(d)
    }
    return out
  }, [range, weekdays])
  // One object per change, so callers can memoize on it.
  return useMemo(
    () => ({ range, setRange, weekdays, setWeekdays, times, setTimes, parsed, dates }),
    [range, weekdays, times, parsed, dates],
  )
}

type Plan = ReturnType<typeof usePlan>

/** Each planned start of `minutes` for the coach. Times already past are skipped, so a range starting today still works. */
function planned(plan: Plan, coachId: number, minutes: number) {
  if (!plan.parsed) return []
  const now = Date.now()
  const times = plan.parsed
  return plan.dates.flatMap((d) =>
    times.flatMap((t) => {
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
}

/** Why a plan cannot be sent, or null. */
function planError(plan: Plan, count: number, what: string) {
  if (!plan.parsed) return '时间格式应为 09:00，多个用逗号分隔'
  if (count === 0) return `没有要创建的${what}`
  if (count > MAX_SLOTS) return `一次最多创建 ${MAX_SLOTS} 个${what}，请缩短日期范围`
  return null
}

function PlanFields({ plan }: { plan: Plan }) {
  return (
    <>
      <Field label="日期">
        <DateRangePicker
          value={plan.range}
          disableDate={{ before: today() }}
          onChange={(v) => plan.setRange([String(v[0] ?? ''), String(v[1] ?? '')])}
        />
      </Field>
      <Field label="星期">
        <Checkbox.Group value={plan.weekdays} onChange={(v) => plan.setWeekdays(v as number[])}>
          {WEEKDAYS.map((w, i) => (
            <Checkbox key={w} value={i}>
              周{w}
            </Checkbox>
          ))}
        </Checkbox.Group>
      </Field>
      <Field label="开始时间" help="多个用逗号分隔，如 09:00, 10:30">
        <Input
          value={plan.times}
          status={plan.parsed ? 'default' : 'error'}
          onChange={(v) => plan.setTimes(String(v))}
        />
      </Field>
    </>
  )
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
  const plan = usePlan(initialFrom, '09:00, 10:00, 14:00, 15:00, 16:00')
  const [minutes, setMinutes] = useState(durations[0] ?? 60)
  const submitting = useSubmitting()
  const key = useIdempotencyKey()
  const slots = useMemo(() => planned(plan, coachId, minutes), [plan, coachId, minutes])
  const count = slots.length

  const submit = async () => {
    const error = planError(plan, count, '时段')
    if (error) {
      void MessagePlugin.warning(error)
      return
    }
    if (
      await attempt(
        () => api('POST', '/admin/slots', { slots }, { key }),
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
        <PlanFields plan={plan} />
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

/** 排小班课: sessions of a group class for one coach, repeated over a date range. */
function CreateSessions({
  coach,
  types,
  initialFrom,
  onClose,
  onDone,
}: {
  coach: Coach | undefined
  types: LessonType[]
  initialFrom: string
  onClose: () => void
  onDone: () => void
}) {
  const taught = types.filter((t) => coach?.lessonTypeIds.includes(t.id))
  const [lessonTypeId, setLessonTypeId] = useState<number | undefined>(taught[0]?.id)
  const lessonType = taught.find((t) => t.id === lessonTypeId)
  const [capacity, setCapacity] = useState<number>(lessonType?.capacity ?? 6)
  const least = Math.max(2, lessonType?.minStudents ?? 0)
  const plan = usePlan(initialFrom, '10:00')
  const submitting = useSubmitting()
  const key = useIdempotencyKey()
  const sessions = useMemo(
    () => (coach && lessonType ? planned(plan, coach.id, lessonType.durationMinutes) : []),
    [plan, coach, lessonType],
  )
  const count = sessions.length

  const submit = async () => {
    if (!lessonType) return
    const error = planError(plan, count, '小班课')
    if (error) {
      void MessagePlugin.warning(error)
      return
    }
    if (
      await attempt(
        () =>
          api(
            'POST',
            '/admin/sessions',
            { lessonTypeId: lessonType.id, capacity, sessions },
            { key },
          ),
        `已排 ${count} 节小班课`,
        { onStale: onDone },
      )
    )
      onDone()
  }

  return (
    <Dialog
      visible
      width={560}
      header={`排小班课${coach ? ` · ${coach.name}` : ''}`}
      confirmBtn={{
        content: `创建 ${count} 节`,
        loading: submitting,
        disabled: !lessonType,
      }}
      onConfirm={submit}
      onClose={onClose}
    >
      {taught.length === 0 ? (
        <p className="muted">
          该教练还没有小班课课程。先在“课程与教练”里新建上课人数多于 1 人的课程，并让教练教这门课。
        </p>
      ) : (
        <div className="fields">
          <Field label="课程">
            <Select
              value={lessonTypeId}
              options={taught.map((t) => ({
                label: `${t.name}（${t.durationMinutes} 分钟）`,
                value: t.id,
              }))}
              onChange={(v) => {
                const next = taught.find((t) => t.id === Number(v))
                setLessonTypeId(next?.id)
                if (next) setCapacity(next.capacity)
              }}
            />
          </Field>
          <PlanFields plan={plan} />
          <Field
            label="每节人数"
            help={`${lessonType?.minStudents ? `报名不足 ${lessonType.minStudents} 人时整节自动取消并退款。` : ''}与已有预约重叠的时间不能排，重叠的空闲时段会关闭`}
          >
            <InputNumber
              theme="normal"
              value={capacity}
              min={least}
              max={30}
              suffix="人"
              onChange={(v) => setCapacity(Math.max(least, Math.min(30, Number(v) || least)))}
            />
          </Field>
        </div>
      )}
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
  const [booking, setBooking] = useState(false)
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

        {!b && slot.open && !started && <Button onClick={() => setBooking(true)}>代约</Button>}

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
      {booking && (
        <BookForStudent slot={slot} onClose={() => setBooking(false)} onDone={onChanged} />
      )}
    </Dialog>
  )
}

/** A group session: its students, seats, and calling it off. */
function SessionDialog({
  slot,
  lessonType,
  onClose,
  onChanged,
}: {
  slot: Slot
  lessonType: LessonType | undefined
  onClose: () => void
  onChanged: () => void
}) {
  const [capacity, setCapacity] = useState(slot.capacity)
  const [cancelling, setCancelling] = useState<'session' | number | null>(null)
  const [reason, setReason] = useState('')
  const [booking, setBooking] = useState(false)
  const submitting = useSubmitting()
  const key = useIdempotencyKey()
  const now = new Date()
  const started = new Date(slot.startsAt) <= now
  const ended = new Date(slot.endsAt) <= now
  const cancelled = slot.cancelledAt !== null
  const full = slot.bookings.length >= slot.capacity
  // Never below the students already in, so nobody loses a seat, nor below the class minimum.
  const minSeats = Math.max(2, slot.bookings.length, lessonType?.minStudents ?? 0)
  const capacityOk = Number.isInteger(capacity) && capacity >= minSeats && capacity <= 30

  const patch = async (body: { open?: boolean; capacity?: number }, done: string) => {
    if (
      await attempt(() => api('PATCH', `/admin/slots/${slot.id}`, body), done, {
        onStale: onChanged,
      })
    )
      onChanged()
  }
  // Held from the click until the dialog closes: a second click landing after the request but
  // before the dialog goes away must not cancel again.
  const sent = useRef(false)
  const cancel = async () => {
    if (!reason.trim() || cancelling === null || sent.current) return
    sent.current = true
    const ok =
      cancelling === 'session'
        ? await attempt(
            () => api('POST', `/admin/slots/${slot.id}/cancel`, { reason }, { key }),
            '已取消整节，学员将收到全额退款或退回课时',
            { onStale: onChanged },
          )
        : await attempt(
            () => api('POST', `/admin/bookings/${cancelling}/cancel`, { reason }),
            '已取消，学员将收到全额退款或退回课时',
            { onStale: onChanged },
          )
    if (ok) onChanged()
    else sent.current = false
  }
  const mark = async (bookingId: number, attendance: string) => {
    if (
      await attempt(
        () =>
          api('PUT', `/admin/bookings/${bookingId}/attendance`, {
            attendance: attendance || null,
          }),
        '已保存',
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

  return (
    <Dialog
      visible
      width={560}
      header={`${lessonType?.name ?? '小班课'} · ${fmtDate(slot.startsAt).slice(5)} ${fmtWeekday(slot.startsAt)} ${fmtTime(slot.startsAt)}-${fmtTime(slot.endsAt)}`}
      footer={false}
      onClose={onClose}
    >
      <div className="session-panel">
        {cancelled ? (
          <Tag theme="danger" variant="light">
            已取消：{slot.cancelReason}
          </Tag>
        ) : (
          <span>
            已报名 {slot.bookings.length}/{slot.capacity} 人
            {!slot.open && <span className="muted">，已停止报名</span>}
          </span>
        )}

        {slot.bookings.length === 0 ? (
          <span className="muted">尚无学员报名</span>
        ) : (
          <div className="roster">
            {slot.bookings.map((b) => {
              const status = bookingStatusLabel[b.status as keyof typeof bookingStatusLabel]
              return (
                <div key={b.id} className="roster-row">
                  <span className="roster-name">
                    {b.student?.name || '未填写姓名'}{' '}
                    <span className="muted">{b.student?.phone}</span>
                  </span>
                  {status && (
                    <Tag theme={status[1]} variant="light">
                      {status[0]}
                    </Tag>
                  )}
                  {started && b.status !== 'pending_payment' && (
                    <Select
                      size="small"
                      style={{ width: 100 }}
                      value={b.attendance ?? ''}
                      options={[
                        { label: '未签到', value: '' },
                        { label: '到课', value: 'attended' },
                        { label: '缺席', value: 'no_show' },
                      ]}
                      onChange={(v) => mark(b.id, String(v))}
                    />
                  )}
                  {!ended && cancelling === null && (
                    <Button
                      size="small"
                      variant="text"
                      theme="danger"
                      onClick={() => setCancelling(b.id)}
                    >
                      取消
                    </Button>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {cancelling !== null && (
          <>
            <span>
              {cancelling === 'session'
                ? `取消整节，${slot.bookings.length} 位学员全额退款或退回课时`
                : `取消 ${slot.bookings.find((b) => b.id === cancelling)?.student?.name || '该学员'} 的预约`}
            </span>
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
              <Button variant="outline" onClick={() => setCancelling(null)}>
                返回
              </Button>
            </Space>
          </>
        )}

        {!cancelled && !started && cancelling === null && (
          <>
            <Space>
              {slot.open && !full && <Button onClick={() => setBooking(true)}>代约</Button>}
              <Button
                variant="outline"
                loading={submitting}
                onClick={() => patch({ open: !slot.open }, slot.open ? '已停止报名' : '已开放报名')}
              >
                {slot.open ? '停止报名' : '开放报名'}
              </Button>
            </Space>
            <Space align="center">
              <span>每节人数</span>
              <InputNumber
                theme="normal"
                value={capacity}
                min={minSeats}
                max={30}
                suffix="人"
                status={capacityOk ? 'default' : 'error'}
                onChange={(v) => setCapacity(Number(v) || 0)}
              />
              <Button
                variant="outline"
                disabled={capacity === slot.capacity || !capacityOk}
                loading={submitting}
                onClick={() => patch({ capacity }, '已修改人数')}
              >
                保存
              </Button>
            </Space>
            {!capacityOk && <span className="danger-text">人数需在 {minSeats} 到 30 之间</span>}
          </>
        )}

        {!cancelled && !ended && cancelling === null && (
          <Space>
            <Button theme="danger" variant="outline" onClick={() => setCancelling('session')}>
              取消整节
            </Button>
            {slot.bookings.length === 0 && (
              <Popconfirm
                theme="danger"
                content="删除这节小班课？"
                confirmBtn={{ content: '删除', theme: 'danger' }}
                cancelBtn="返回"
                onConfirm={remove}
              >
                <Button variant="text" theme="danger" loading={submitting}>
                  删除
                </Button>
              </Popconfirm>
            )}
          </Space>
        )}
      </div>
      {booking && (
        <BookForStudent slot={slot} onClose={() => setBooking(false)} onDone={onChanged} />
      )}
    </Dialog>
  )
}
