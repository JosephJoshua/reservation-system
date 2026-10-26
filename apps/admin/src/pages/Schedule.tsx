import {
  clashes,
  type DayPlanDto,
  endsSameVenueDay,
  SCHEDULE_STEP,
  type ScheduleConflictDto,
  type Span,
  venueDateKey,
  venueInstant,
  venueParts,
  withinSpans,
} from '@rs/shared'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Checkbox,
  DatePicker,
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
import { MoveDialog } from '../MoveDialog'
import type { Coach, LessonType, Slot } from '../types'
import { CoachScheduleDialog, spanText } from './CoachDialogs'

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']
// Matches the API's limit per request.
const MAX_SLOTS = 500
const HOUR_PX = 72
const MINUTE = 60_000

const ATTENDANCE = { attended: '已到课', no_show: '缺席' } as const

const toSpan = (s: { startsAt: string; endsAt: string }): Span => ({
  startsAt: new Date(s.startsAt),
  endsAt: new Date(s.endsAt),
})

/** Minutes after the venue midnight that starts `date`. */
const minuteOf = (iso: string, date: string) =>
  (Date.parse(iso) - venueInstant(date, 0).getTime()) / MINUTE

/** What a private lesson block says after the student's name. */
function lessonState(b: NonNullable<Slot['booking']>) {
  if (b.status === 'pending_payment') return '待支付'
  if (b.status !== 'completed') return '已约'
  return b.attendance ? ATTENDANCE[b.attendance] : '未签到'
}

/**
 * 日程: one day of the venue, a row per coach with their working time, 请假 and lessons, and the
 * tables in use. Clicking free time books a lesson there; clicking a coach opens their 排班.
 */
export function Schedule() {
  const coaches = useApi<Coach[]>('/admin/coaches')
  const types = useApi<LessonType[]>('/admin/lesson-types')
  const [date, setDate] = useState(today)
  const plan = useApi<DayPlanDto>(`/admin/schedule/day?date=${date}`)
  const slots = useApi<Slot[]>(
    `/admin/slots?${new URLSearchParams({
      from: venueInstant(date, 0).toISOString(),
      to: venueInstant(addDays(date, 1), 0).toISOString(),
    })}`,
  )
  const conflicts = useApi<ScheduleConflictDto[]>('/admin/schedule/conflicts')
  const [category, setCategory] = useState<string>('')
  const [search, setSearch] = useState('')
  const [booking, setBooking] = useState<
    { coachId: number; startsAt: string; outside: boolean } | 'any' | null
  >(null)
  const [creating, setCreating] = useState(false)
  const [selected, setSelected] = useState<Slot | null>(null)
  const [scheduleOf, setScheduleOf] = useState<Coach | null>(null)
  const [showConflicts, setShowConflicts] = useState(false)
  const phone = useIsPhone()

  const reload = () => {
    void plan.reload()
    void slots.reload()
    void conflicts.reload()
  }

  const day = plan.data?.date === date ? plan.data : null
  const categories = [
    ...new Set((day?.coaches ?? []).map((c) => c.categoryName).filter((n): n is string => !!n)),
  ]
  const shown = (day?.coaches ?? []).filter(
    (c) =>
      (!category || c.categoryName === category) &&
      (!search.trim() || c.name.includes(search.trim())),
  )
  const daySlots = (slots.data ?? []).filter((s) => venueDateKey(new Date(s.startsAt)) === date)

  // The hours shown: 8:00 to 22:00, widened to whatever the day holds.
  const [startHour, endHour] = useMemo(() => {
    let first = 8 * 60
    let last = 22 * 60
    const see = (from: string, to: string) => {
      first = Math.min(first, Math.max(0, minuteOf(from, date)))
      last = Math.max(last, Math.min(24 * 60, minuteOf(to, date)))
    }
    for (const c of day?.coaches ?? []) for (const w of c.working) see(w.startsAt, w.endsAt)
    for (const s of daySlots) see(s.startsAt, s.endsAt)
    return [Math.floor(first / 60), Math.ceil(last / 60)]
  }, [day, daySlots, date])
  const hours = Array.from({ length: endHour - startHour }, (_, i) => startHour + i)
  const width = hours.length * HOUR_PX
  const x = (iso: string) =>
    ((Math.min(Math.max(minuteOf(iso, date), startHour * 60), endHour * 60) - startHour * 60) /
      60) *
    HOUR_PX
  const span = (from: string, to: string) => ({
    left: x(from),
    width: Math.max(2, x(to) - x(from)),
  })

  const typeName = (id: number | null) => (types.data ?? []).find((t) => t.id === id)?.name ?? ''
  const coachOf = (id: number) => (coaches.data ?? []).find((c) => c.id === id)

  /**
   * Books at the clicked time, rounded down to the half hour. In 排班 the picker settles on the
   * open start time that covers it; outside 排班 it is a time to agree with the coach.
   */
  const bookAt = (coach: DayPlanDto['coaches'][number], e: React.MouseEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    const minute = startHour * 60 + ((e.clientX - box.left) / HOUR_PX) * 60
    const start = venueInstant(date, Math.floor(minute / 30) * 30)
    if (start.getTime() <= Date.now()) {
      void MessagePlugin.info('这个时间已过')
      return
    }
    // The first step of a lesson starting then.
    const moment = { startsAt: start, endsAt: new Date(start.getTime() + SCHEDULE_STEP * MINUTE) }
    const off = coach.off.filter((o) => clashes(moment, toSpan(o)))
    if (off.length) {
      void MessagePlugin.info(
        off.some((o) => o.coachId === null) ? '这个时间闭馆' : '教练这个时间请假',
      )
      return
    }
    setBooking({
      coachId: coach.id,
      startsAt: start.toISOString(),
      outside: !withinSpans(moment, coach.working.map(toSpan)),
    })
  }

  const tables = day?.tables ?? null
  const use = new Map((day?.tableUse ?? []).map((u) => [u.startsAt, u.used]))
  const pending = conflicts.data ?? []
  const clashing = new Set(pending.map((c) => c.slotId))

  return (
    <div>
      <div className="toolbar">
        <div className="week-nav">
          <Button variant="outline" onClick={() => setDate(addDays(date, -1))}>
            前一天
          </Button>
          <DatePicker
            value={date}
            clearable={false}
            style={{ width: phone ? undefined : 140 }}
            onChange={(v) => setDate(String(v || today()))}
          />
          <Button variant="outline" onClick={() => setDate(addDays(date, 1))}>
            后一天
          </Button>
          {date !== today() && (
            <Button variant="text" onClick={() => setDate(today())}>
              今天
            </Button>
          )}
        </div>
        {categories.length > 0 && (
          <Select
            style={{ width: 140 }}
            value={category}
            options={[
              { label: '全部级别', value: '' },
              ...categories.map((c) => ({ label: c, value: c })),
            ]}
            onChange={(v) => setCategory(String(v ?? ''))}
          />
        )}
        <Input
          style={{ width: 160 }}
          clearable
          placeholder="搜索教练"
          value={search}
          onChange={(v) => setSearch(String(v))}
        />
        <span className="spacer" />
        <Space>
          <Button variant="outline" onClick={() => setCreating(true)}>
            排小班课
          </Button>
          <Button onClick={() => setBooking('any')}>代约</Button>
        </Space>
      </div>

      {pending.length > 0 && (
        <Alert
          theme="warning"
          className="board-alert"
          message={
            <div>
              <span>有 {pending.length} 节课在教练请假或闭馆时间里，请改约或取消。</span>
              <Button
                variant="text"
                theme="primary"
                onClick={() => setShowConflicts(!showConflicts)}
              >
                {showConflicts ? '收起' : '查看'}
              </Button>
              {showConflicts &&
                pending.map((c) => (
                  <div key={`${c.slotId}-${c.bookingId}`}>
                    <Button
                      variant="text"
                      theme="primary"
                      onClick={() => setDate(venueDateKey(new Date(c.startsAt)))}
                    >
                      {spanText(c.startsAt, c.endsAt)} {c.coachName} {c.title}
                      {c.group && '（小班课）'}
                    </Button>
                  </div>
                ))}
            </div>
          }
        />
      )}

      <h3 className="board-date">
        {date.slice(5)} 周{WEEKDAYS[(venueInstant(date, 12 * 60).getUTCDay() + 6) % 7]}
        {date === today() && <span className="muted"> 今天</span>}
      </h3>

      {plan.error || slots.error ? (
        <p className="danger-text">{plan.error ?? slots.error}</p>
      ) : !day ? (
        <p className="muted">加载中</p>
      ) : day.coaches.length === 0 ? (
        <p className="muted">先在“教练”页添加教练</p>
      ) : (
        <div className="board-scroll">
          <div className="board" style={{ width: width + 120 }}>
            <div className="board-row board-head">
              <div className="board-name" />
              <div className="board-track" style={{ width }}>
                {hours.map((h) => (
                  <span key={h} className="board-hour" style={{ left: (h - startHour) * HOUR_PX }}>
                    {String(h).padStart(2, '0')}:00
                  </span>
                ))}
              </div>
            </div>
            {tables !== null && (
              <div className="board-row board-tables">
                <div className="board-name">
                  球台 <span className="muted">共 {tables} 张</span>
                </div>
                <div className="board-track" style={{ width }}>
                  {hours.flatMap((h) =>
                    [0, 30].map((m) => {
                      const at = venueInstant(date, h * 60 + m).toISOString()
                      const used = use.get(at) ?? 0
                      return (
                        <span
                          key={at}
                          className={`board-table${used >= tables ? ' full' : used ? ' some' : ''}`}
                          style={{
                            left: ((h - startHour) * 60 + m) * (HOUR_PX / 60),
                            width: HOUR_PX / 2,
                          }}
                          title={`${String(h).padStart(2, '0')}:${m ? '30' : '00'} 用了 ${used}/${tables} 张`}
                        >
                          {used || ''}
                        </span>
                      )
                    }),
                  )}
                </div>
              </div>
            )}
            {shown.length === 0 && <p className="muted board-empty">没有符合条件的教练</p>}
            {shown.map((c) => {
              const mine = daySlots.filter((s) => s.coachId === c.id)
              const full = coachOf(c.id)
              return (
                <div key={c.id} className="board-row">
                  <button
                    type="button"
                    className="board-name board-coach"
                    title="查看排班"
                    onClick={() => full && setScheduleOf(full)}
                  >
                    <span>{c.name}</span>
                    <span className="muted">
                      {c.active ? (c.categoryName ?? '') : '已停止接课'}
                    </span>
                  </button>
                  {/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: the 代约 button does the same from the keyboard */}
                  <div
                    className={`board-track${c.active ? ' bookable' : ''}`}
                    style={{ width }}
                    onClick={(e) => c.active && bookAt(c, e)}
                  >
                    {c.working.map((w) => (
                      <span
                        key={w.startsAt}
                        className="board-work"
                        style={span(w.startsAt, w.endsAt)}
                      />
                    ))}
                    {c.off.map((o) => (
                      <span
                        key={o.id}
                        className="board-off"
                        style={span(o.startsAt, o.endsAt)}
                        title={`${o.coachId === null ? '闭馆' : '请假'} ${o.note}`}
                      >
                        {o.coachId === null ? '闭馆' : '请假'}
                        {o.note && ` · ${o.note}`}
                      </span>
                    ))}
                    {mine.map((s) => {
                      const group = s.lessonTypeId !== null
                      const label = group
                        ? `${typeName(s.lessonTypeId)} ${s.cancelledAt ? '已取消' : `${s.bookings.length}/${s.capacity}`}`
                        : `${s.booking?.student?.name || '未填写姓名'} · ${s.booking ? lessonState(s.booking) : ''}`
                      return (
                        <button
                          type="button"
                          key={s.id}
                          className={`board-block${group ? ' group' : ''}${s.cancelledAt ? ' cancelled' : ''}${s.booking?.status === 'pending_payment' ? ' pending' : ''}${clashing.has(s.id) ? ' conflict' : ''}`}
                          style={span(s.startsAt, s.endsAt)}
                          title={`${fmtTime(s.startsAt)}-${fmtTime(s.endsAt)} ${label}`}
                          onClick={(e) => {
                            e.stopPropagation()
                            setSelected(s)
                          }}
                        >
                          <span className="board-block-time">{fmtTime(s.startsAt)}</span>
                          {label}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
      <p className="muted">
        浅色为教练排班时间，斜线为请假或闭馆。点空白处代约，点教练名查看和修改排班。
      </p>

      {booking && (
        <BookForStudent
          at={booking === 'any' ? undefined : booking}
          date={date}
          onClose={() => setBooking(null)}
          onDone={() => {
            setBooking(null)
            reload()
          }}
        />
      )}

      {creating && (
        <CreateSessions
          coaches={(coaches.data ?? []).filter((c) => c.active)}
          types={(types.data ?? []).filter((t) => t.active && t.capacity > 1)}
          initialFrom={date}
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false)
            reload()
          }}
        />
      )}

      {scheduleOf && (
        <CoachScheduleDialog
          coach={scheduleOf}
          onClose={() => {
            setScheduleOf(null)
            reload()
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
            reload()
          }}
        />
      )}

      {selected && selected.lessonTypeId === null && selected.booking && (
        <LessonDialog
          slot={selected}
          booking={selected.booking}
          lessonType={(types.data ?? []).find((t) => t.id === selected.booking?.lessonTypeId)}
          coach={coachOf(selected.coachId)}
          onClose={() => setSelected(null)}
          onChanged={() => {
            setSelected(null)
            reload()
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
function planError(plan: Plan, items: { startsAt: string; endsAt: string }[], what: string) {
  if (!plan.parsed) return '时间格式应为 09:00，多个用逗号分隔'
  const late = items.find((i) => !endsSameVenueDay(new Date(i.startsAt), new Date(i.endsAt)))
  if (late) {
    const { hours, minutes } = venueParts(new Date(late.startsAt))
    const t = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
    return `${t} 开始的课会上到第二天，请修改开始时间`
  }
  if (items.length === 0) return `没有要创建的${what}`
  if (items.length > MAX_SLOTS) return `一次最多创建 ${MAX_SLOTS} 个${what}，请缩短日期范围`
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
      <Field label="开始时间" help="多个时间用逗号分隔，如：09:00, 10:30">
        <Input
          value={plan.times}
          status={plan.parsed ? 'default' : 'error'}
          onChange={(v) => plan.setTimes(String(v))}
        />
      </Field>
    </>
  )
}

/** 排小班课: sessions of a group class for one coach, repeated over a date range. */
function CreateSessions({
  coaches,
  types,
  initialFrom,
  onClose,
  onDone,
}: {
  coaches: Coach[]
  types: LessonType[]
  initialFrom: string
  onClose: () => void
  onDone: () => void
}) {
  // Coaches who teach a group class.
  const able = coaches.filter((c) => types.some((t) => c.lessonTypeIds.includes(t.id)))
  const [coachId, setCoachId] = useState<number | undefined>(able[0]?.id)
  const coach = able.find((c) => c.id === coachId)
  const taught = types.filter((t) => coach?.lessonTypeIds.includes(t.id))
  const [lessonTypeId, setLessonTypeId] = useState<number | undefined>(taught[0]?.id)
  const lessonType = taught.find((t) => t.id === lessonTypeId)
  useEffect(() => {
    if (!taught.some((t) => t.id === lessonTypeId)) {
      setLessonTypeId(taught[0]?.id)
      if (taught[0]) setCapacity(taught[0].capacity)
    }
  }, [taught, lessonTypeId])
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
    const error = planError(plan, sessions, '小班课')
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
      header="排小班课"
      confirmBtn={{
        content: `创建 ${count} 节`,
        loading: submitting,
        disabled: !lessonType,
      }}
      onConfirm={submit}
      onClose={onClose}
    >
      {able.length === 0 ? (
        <p className="muted">
          还没有教练教小班课。先在“课程”页新建上课人数多于 1 人的课程，并在“教练”页让教练教这门课。
        </p>
      ) : (
        <div className="fields">
          <Field label="教练">
            <Select
              value={coachId}
              options={able.map((c) => ({ label: c.name, value: c.id }))}
              onChange={(v) => setCoachId(Number(v))}
            />
          </Field>
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
            help={`${lessonType?.minStudents ? `报名不足 ${lessonType.minStudents} 人时整节自动取消并退款。` : ''}与该教练已有的课重叠、或在请假和闭馆里的时间不能排`}
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

/** A private lesson on the board: who, and moving, cancelling or marking attendance. */
function LessonDialog({
  slot,
  booking: b,
  lessonType,
  coach,
  onClose,
  onChanged,
}: {
  slot: Slot
  booking: NonNullable<Slot['booking']>
  lessonType: LessonType | undefined
  coach: Coach | undefined
  onClose: () => void
  onChanged: () => void
}) {
  const [reason, setReason] = useState('')
  const [cancelling, setCancelling] = useState(false)
  const [moving, setMoving] = useState(false)
  const submitting = useSubmitting()
  const status = bookingStatusLabel[b.status as keyof typeof bookingStatusLabel]
  const now = new Date()
  const started = new Date(slot.startsAt) <= now

  const cancel = async () => {
    if (!reason.trim()) return
    if (
      await attempt(
        () => api('POST', `/admin/bookings/${b.id}/cancel`, { reason }),
        '已取消，学员会收到全额退款或退回的课时',
        { onStale: onChanged },
      )
    )
      onChanged()
  }
  const mark = async (attendance: string) => {
    if (
      await attempt(
        () => api('PUT', `/admin/bookings/${b.id}/attendance`, { attendance: attendance || null }),
        '已保存',
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
        <Space breakLine>
          <span>
            {b.student?.name || '未填写姓名'} {b.student?.phone}
          </span>
          {status && (
            <Tag theme={status[1]} variant="light">
              {status[0]}
            </Tag>
          )}
        </Space>
        <span className="muted">
          {coach?.name} {lessonType?.name}
        </span>

        {started && b.status !== 'pending_payment' && (
          <Space align="center">
            <span>签到</span>
            <Select
              size="small"
              style={{ width: 100 }}
              value={b.attendance ?? ''}
              options={[
                { label: '未签到', value: '' },
                { label: '到课', value: 'attended' },
                { label: '缺席', value: 'no_show' },
              ]}
              onChange={(v) => mark(String(v))}
            />
          </Space>
        )}

        {!cancelling && (
          <Space>
            {!started && b.status === 'confirmed' && lessonType && coach && (
              <Button variant="outline" onClick={() => setMoving(true)}>
                改约
              </Button>
            )}
            {/* The API refuses to cancel a lesson that has ended. */}
            {new Date(slot.endsAt) > now && (
              <Button theme="danger" variant="outline" onClick={() => setCancelling(true)}>
                场馆取消
              </Button>
            )}
          </Space>
        )}
        {cancelling && (
          <>
            <Textarea
              placeholder="取消原因（学员可见）"
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
      </Space>
      {moving && lessonType && coach && (
        <MoveDialog
          booking={{
            id: b.id,
            startsAt: slot.startsAt,
            endsAt: slot.endsAt,
            lessonType,
            coach,
            student: b.student,
          }}
          onClose={() => setMoving(false)}
          onDone={onChanged}
        />
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
  // No seats left, or no table yet for a session nobody has joined.
  const full = slot.bookings.length >= slot.capacity || (!slot.bookings.length && slot.tableFull)
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
            '已取消整节，学员会收到全额退款或退回的课时',
            { onStale: onChanged },
          )
        : await attempt(
            () => api('POST', `/admin/bookings/${cancelling}/cancel`, { reason }),
            '已取消，学员会收到全额退款或退回的课时',
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
          <span className="muted">
            {slot.tableFull && !started ? '还没有学员报名，但这个时段的球台已满' : '还没有学员报名'}
          </span>
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
                ? `取消整节课后，${slot.bookings.length} 位学员都会收到全额退款或退回课时`
                : `取消 ${slot.bookings.find((b) => b.id === cancelling)?.student?.name || '该学员'} 的预约`}
            </span>
            <Textarea
              placeholder="取消原因（学员可见）"
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
        <BookForStudent session={slot} onClose={() => setBooking(false)} onDone={onChanged} />
      )}
    </Dialog>
  )
}
