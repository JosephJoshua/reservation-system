import { venueDateKey, venueInstant } from '@rs/shared'
import { useState } from 'react'
import {
  Button,
  Checkbox,
  DatePicker,
  DateRangePicker,
  Dialog,
  Select,
  Space,
  Tag,
  Textarea,
} from 'tdesign-react'
import { api } from '../api'
import { BookForStudent } from '../BookForStudent'
import { DataTable } from '../DataTable'
import { ExportButton } from '../ExportButton'
import { Field } from '../Field'
import { addDays, fmtDateTime, fmtTime, today, yuan } from '../format'
import { attempt, hashParam, useApi, useIdempotencyKey, useSubmitting } from '../hooks'
import { bookingStatusLabel, refundLabel } from '../labels'
import { useCan } from '../me'
import { StudentCell } from '../StudentCell'
import type { AdminBooking, Coach, Slot } from '../types'

export function Bookings() {
  // The overview links here with `from` for lessons still to mark.
  const [range, setRange] = useState<[string, string]>(() => {
    const from = hashParam('from')
    return from && /^\d{4}-\d{2}-\d{2}$/.test(from) && from <= today()
      ? [from, today()]
      : [today(), addDays(today(), 13)]
  })
  // The overview links here with the status it counted.
  const [status, setStatus] = useState(() => hashParam('status') ?? '')
  const [unmarked, setUnmarked] = useState(() => hashParam('unmarked') === '1')
  const [coachId, setCoachId] = useState<number | null>(null)
  const [order, setOrder] = useState<'asc' | 'desc'>('asc')
  const canBook = useCan('bookings')
  const canMark = useCan('attendance')
  const money = useCan('finance')
  const coaches = useApi<Coach[]>('/admin/coaches')
  const [cancelling, setCancelling] = useState<AdminBooking | null>(null)
  const [moving, setMoving] = useState<AdminBooking | null>(null)
  const [reason, setReason] = useState('')
  const [booking, setBooking] = useState(false)
  const submitting = useSubmitting()

  const params = new URLSearchParams({
    from: venueInstant(range[0], 0).toISOString(),
    to: venueInstant(range[1], 24 * 60).toISOString(),
    order,
  })
  if (status) params.set('status', status)
  if (coachId) params.set('coachId', String(coachId))
  if (unmarked) params.set('unmarked', '1')
  const { data, loading, error, reload } = useApi<AdminBooking[]>(`/admin/bookings?${params}`)

  const closeCancel = () => {
    setCancelling(null)
    setReason('')
  }

  const cancel = async () => {
    if (!cancelling || !reason.trim()) return
    if (
      await attempt(
        () => api('POST', `/admin/bookings/${cancelling.id}/cancel`, { reason }),
        '已取消',
        {
          onStale: () => {
            closeCancel()
            void reload()
          },
        },
      )
    ) {
      closeCancel()
      await reload()
    }
  }

  const mark = async (row: AdminBooking, attendance: string | null) => {
    if (
      await attempt(
        () => api('PUT', `/admin/bookings/${row.id}/attendance`, { attendance }),
        '已更新签到',
        { key: `attendance-${row.id}` },
      )
    ) {
      await reload()
    }
  }

  return (
    <div>
      <div className="toolbar">
        <DateRangePicker
          style={{ width: 280 }}
          value={range}
          onChange={(v) => setRange([String(v[0] ?? today()), String(v[1] ?? today())])}
        />
        <Select
          style={{ width: 140 }}
          clearable
          placeholder="全部状态"
          value={status || undefined}
          onChange={(v) => setStatus(String(v ?? ''))}
          options={[
            { label: '待支付', value: 'pending_payment' },
            { label: '已预约', value: 'confirmed' },
            { label: '已完成', value: 'completed' },
            { label: '已取消', value: 'cancelled' },
            { label: '已超时', value: 'expired' },
          ]}
        />
        <Select
          style={{ width: 140 }}
          clearable
          placeholder="全部教练"
          value={coachId ?? undefined}
          onChange={(v) => setCoachId(v ? Number(v) : null)}
          options={(coaches.data ?? []).map((c) => ({ label: c.name, value: c.id }))}
        />
        <Select
          style={{ width: 120 }}
          value={order}
          onChange={(v) => setOrder(v === 'desc' ? 'desc' : 'asc')}
          options={[
            { label: '时间升序', value: 'asc' },
            { label: '时间降序', value: 'desc' },
          ]}
        />
        <Checkbox checked={unmarked} onChange={(v) => setUnmarked(v)}>
          只看未签到
        </Checkbox>
        <span className="spacer" />
        {money && (
          <ExportButton
            kind="bookings"
            range={range}
            filters={{ status, coachId, unmarked: unmarked ? '1' : undefined }}
            filterText={
              [
                status && `状态：${bookingStatusLabel[status as 'confirmed'][0]}`,
                coachId && `教练：${coaches.data?.find((c) => c.id === coachId)?.name ?? ''}`,
                unmarked && '未签到',
              ]
                .filter(Boolean)
                .join('，') || undefined
            }
          />
        )}
        {canBook && <Button onClick={() => setBooking(true)}>代约</Button>}
      </div>
      <DataTable
        rowKey="id"
        loading={loading}
        data={data ?? []}
        empty={error ?? '这段时间没有预约'}
        columns={[
          {
            colKey: 'startsAt',
            title: '时间',
            width: 150,
            cell: ({ row }) => (
              <div>
                <span className="nowrap">
                  {fmtDateTime(row.startsAt)}-{fmtTime(row.endsAt)}
                </span>
                {row.movedFrom && (
                  <div className="muted nowrap">原定 {fmtDateTime(row.movedFrom)}</div>
                )}
              </div>
            ),
          },
          { colKey: 'coach', title: '教练', cell: ({ row }) => row.coach.name },
          { colKey: 'lessonType', title: '课程', cell: ({ row }) => row.lessonType.name },
          {
            colKey: 'student',
            title: '学员',
            cell: ({ row }) => <StudentCell student={row.student} />,
          },
          {
            colKey: 'paid',
            title: '支付',
            cell: ({ row }) => (
              <div>
                {row.paidWith === 'package'
                  ? `课时包 ${row.packageName ?? ''}`
                  : row.price
                    ? yuan(row.price)
                    : '免费'}
                {row.bookedBy && <div className="muted nowrap">{row.bookedBy.name} 代约</div>}
              </div>
            ),
          },
          {
            colKey: 'status',
            title: '状态',
            cell: ({ row }) => {
              const [label, theme] = bookingStatusLabel[row.status]
              const refund = row.refund ? refundLabel(row.refund.status, row.paidOffline) : null
              return (
                <span>
                  <Tag theme={theme} variant="light">
                    {label}
                  </Tag>
                  {row.status === 'cancelled' && (
                    <>
                      {' '}
                      <span className="muted nowrap">
                        {row.cancelledBy === 'venue'
                          ? '场馆取消'
                          : row.late
                            ? '学员逾时取消'
                            : '学员取消'}
                      </span>
                    </>
                  )}
                  {refund && row.refund && (
                    <>
                      {' '}
                      <span className="muted nowrap">
                        {refund[0]} {yuan(row.refund.amount)}
                      </span>
                    </>
                  )}
                </span>
              )
            },
          },
          {
            colKey: 'attendance',
            title: '签到',
            cell: ({ row }) => {
              const started = Date.parse(row.startsAt) <= Date.now()
              const markable = started && (row.status === 'confirmed' || row.status === 'completed')
              return (
                <div>
                  {markable && !canMark ? (
                    <span className={row.attendance ? undefined : 'muted'}>
                      {row.attendance === 'attended'
                        ? '到课'
                        : row.attendance === 'no_show'
                          ? '缺席'
                          : '未签到'}
                    </span>
                  ) : markable ? (
                    <Select
                      size="small"
                      style={{ width: 96 }}
                      placeholder="未签到"
                      clearable
                      value={row.attendance ?? undefined}
                      options={[
                        { label: '到课', value: 'attended' },
                        { label: '缺席', value: 'no_show' },
                      ]}
                      onChange={(v) => mark(row, v ? String(v) : null)}
                    />
                  ) : (
                    <span className="muted">-</span>
                  )}
                  {row.coachNote && (
                    <div className="muted note-line" title={row.coachNote}>
                      备注：{row.coachNote}
                    </div>
                  )}
                </div>
              )
            },
          },
          ...(canBook
            ? [
                {
                  colKey: 'op',
                  title: '操作',
                  cell: ({ row }: { row: AdminBooking }) => {
                    const upcoming = Date.parse(row.startsAt) > Date.now()
                    return (
                      <Space size={0}>
                        {row.status === 'confirmed' && upcoming && (
                          <Button variant="text" theme="primary" onClick={() => setMoving(row)}>
                            改约
                          </Button>
                        )}
                        {(row.status === 'confirmed' || row.status === 'pending_payment') && (
                          <Button variant="text" theme="danger" onClick={() => setCancelling(row)}>
                            取消
                          </Button>
                        )}
                      </Space>
                    )
                  },
                },
              ]
            : []),
        ]}
      />
      {moving && (
        <MoveDialog
          booking={moving}
          coaches={coaches.data ?? []}
          onClose={() => setMoving(null)}
          onDone={() => {
            setMoving(null)
            void reload()
          }}
        />
      )}
      {cancelling && (
        <Dialog
          visible
          header="场馆取消预约"
          confirmBtn={{
            content: '确认取消',
            theme: 'danger',
            disabled: !reason.trim(),
            loading: submitting,
          }}
          cancelBtn="返回"
          onConfirm={cancel}
          onClose={closeCancel}
        >
          <p>
            {cancelling.student?.name} {fmtDateTime(cancelling.startsAt)}{' '}
            {cancelling.lessonType.name}
          </p>
          <p className="muted">
            场馆取消时，已付款项全额退款，课时包课时退回。前台收款的，请在退款页确认当面退还。
          </p>
          <Textarea
            placeholder="取消原因，学员可见"
            value={reason}
            maxlength={100}
            onChange={(v) => setReason(String(v))}
          />
        </Dialog>
      )}
      {booking && (
        <BookForStudent
          onClose={() => setBooking(false)}
          onDone={() => {
            setBooking(false)
            void reload()
          }}
        />
      )}
    </div>
  )
}

/** Moves a confirmed lesson to a free slot of the same length, with any coach who teaches it. */
function MoveDialog({
  booking,
  coaches,
  onClose,
  onDone,
}: {
  booking: AdminBooking
  coaches: Coach[]
  onClose: () => void
  onDone: () => void
}) {
  const teaching = coaches.filter(
    (c) => c.active && c.lessonTypeIds.includes(booking.lessonType.id),
  )
  const [picked, setCoachId] = useState(booking.coach.id)
  // The lesson's own coach, or the first who teaches it when they no longer do.
  const coachId = teaching.some((c) => c.id === picked) ? picked : (teaching[0]?.id ?? null)
  // Only upcoming lessons can move, so their own day is never in the past.
  const [date, setDate] = useState(() => venueDateKey(new Date(booking.startsAt)))
  const [slotId, setSlotId] = useState<number | null>(null)
  const submitting = useSubmitting()
  const key = useIdempotencyKey()
  const params = new URLSearchParams({
    from: venueInstant(date, 0).toISOString(),
    to: venueInstant(date, 24 * 60).toISOString(),
    coachId: String(coachId),
    moving: String(booking.id),
  })
  const {
    data,
    loading,
    error,
    reload: reloadSlots,
  } = useApi<Slot[]>(coachId ? `/admin/slots?${params}` : null)
  const length = Date.parse(booking.endsAt) - Date.parse(booking.startsAt)
  // Checked against the coach and day shown, since a failed or slow load keeps the last list.
  // A group class moves to another session of the same class with a free seat.
  const sessionOf = booking.capacity > 1 ? booking.lessonType.id : null
  const free = (data ?? []).filter(
    (s) =>
      s.coachId === coachId &&
      venueDateKey(new Date(s.startsAt)) === date &&
      s.open &&
      !s.cancelledAt &&
      s.lessonTypeId === sessionOf &&
      s.bookings.length < s.capacity &&
      !s.tableFull &&
      !(s.coachId === booking.coach.id && s.startsAt === booking.startsAt) &&
      Date.parse(s.startsAt) > Date.now() &&
      Date.parse(s.endsAt) - Date.parse(s.startsAt) === length,
  )

  const submit = async () => {
    if (!slotId) return
    let stale = false
    const ok = await attempt(
      () => api('POST', `/admin/bookings/${booking.id}/move`, { slotId }, { key }),
      '已改约',
      {
        // The lesson was cancelled or started meanwhile.
        stale: ['not_movable', 'started'],
        onStale: () => {
          stale = true
          onDone()
        },
      },
    )
    if (ok) onDone()
    else if (!stale) {
      // The time may have gone meanwhile: show what is free now.
      setSlotId(null)
      void reloadSlots()
    }
  }

  return (
    <Dialog
      visible
      header="改约"
      confirmBtn={{ content: '确认改约', disabled: !slotId, loading: submitting }}
      cancelBtn="返回"
      onConfirm={submit}
      onClose={onClose}
    >
      <p>
        {booking.student?.name} {booking.lessonType.name}，当前 {fmtDateTime(booking.startsAt)}{' '}
        {booking.coach.name}
      </p>
      <div className="fields">
        <Field label="教练" help={coachId ? undefined : '没有教这门课的教练'}>
          <Select
            value={coachId ?? undefined}
            options={teaching.map((c) => ({ label: c.name, value: c.id }))}
            onChange={(v) => {
              setCoachId(Number(v))
              setSlotId(null)
            }}
          />
        </Field>
        <Field label="日期">
          <DatePicker
            value={date}
            allowInput
            clearable={false}
            disableDate={{ before: today() }}
            onChange={(v) => {
              // Typing clears the input first; keep the last whole date until a new one is typed.
              const picked = String(v ?? '')
              if (!/^\d{4}-\d{2}-\d{2}$/.test(picked)) return
              setDate(picked)
              setSlotId(null)
            }}
          />
        </Field>
        <Field
          label="时间"
          help={error ?? (loading || !coachId || free.length ? undefined : '这天没有空闲时段')}
        >
          <Select
            value={slotId ?? undefined}
            loading={loading}
            placeholder="选择空闲时段"
            options={free.map((s) => ({
              label: `${fmtTime(s.startsAt)}-${fmtTime(s.endsAt)}${sessionOf ? ` 剩 ${s.capacity - s.bookings.length} 位` : ''}`,
              value: s.id,
            }))}
            onChange={(v) => setSlotId(Number(v))}
          />
        </Field>
      </div>
      <p className="muted">
        已付款项和课时不变，场馆改约不受教练价格和课时包范围限制。订阅了通知的学员和教练会收到改约消息。
      </p>
    </Dialog>
  )
}
