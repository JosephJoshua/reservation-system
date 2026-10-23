import { venueInstant } from '@rs/shared'
import { useState } from 'react'
import { Button, DateRangePicker, Dialog, Select, Tag, Textarea } from 'tdesign-react'
import { api } from '../api'
import { BookForStudent } from '../BookForStudent'
import { DataTable } from '../DataTable'
import { addDays, fmtDateTime, fmtTime, today, yuan } from '../format'
import { attempt, useApi, useSubmitting } from '../hooks'
import { bookingStatusLabel, refundLabel } from '../labels'
import { StudentCell } from '../StudentCell'
import type { AdminBooking, Coach } from '../types'

export function Bookings() {
  const [range, setRange] = useState<[string, string]>([today(), addDays(today(), 13)])
  const [status, setStatus] = useState<string>('')
  const [coachId, setCoachId] = useState<number | null>(null)
  const [order, setOrder] = useState<'asc' | 'desc'>('asc')
  const coaches = useApi<Coach[]>('/admin/coaches')
  const [cancelling, setCancelling] = useState<AdminBooking | null>(null)
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
        <span className="spacer" />
        <Button onClick={() => setBooking(true)}>代约</Button>
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
              <span className="nowrap">
                {fmtDateTime(row.startsAt)}-{fmtTime(row.endsAt)}
              </span>
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
                    <span className="muted">
                      {' '}
                      {row.cancelledBy === 'venue'
                        ? '场馆取消'
                        : row.late
                          ? '学员逾时取消'
                          : '学员取消'}
                    </span>
                  )}
                  {refund && row.refund && (
                    <span className="muted">
                      {' '}
                      {refund[0]} {yuan(row.refund.amount)}
                    </span>
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
                  {markable ? (
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
          {
            colKey: 'op',
            title: '操作',
            cell: ({ row }) =>
              row.status === 'confirmed' || row.status === 'pending_payment' ? (
                <Button variant="text" theme="danger" onClick={() => setCancelling(row)}>
                  取消
                </Button>
              ) : null,
          },
        ]}
      />
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
