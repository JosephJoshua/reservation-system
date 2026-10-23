import { venueInstant } from '@rs/shared'
import { useState } from 'react'
import { Button, DateRangePicker, Dialog, Select, Table, Tag, Textarea } from 'tdesign-react'
import { api } from '../api'
import { addDays, fmtDateTime, fmtTime, today, yuan } from '../format'
import { attempt, useApi } from '../hooks'
import { bookingStatusLabel, refundStatusLabel } from '../labels'
import type { AdminBooking } from '../types'

export function Bookings() {
  const [range, setRange] = useState<[string, string]>([today(), addDays(today(), 13)])
  const [status, setStatus] = useState<string>('')
  const [cancelling, setCancelling] = useState<AdminBooking | null>(null)
  const [reason, setReason] = useState('')

  const params = new URLSearchParams({
    from: venueInstant(range[0], 0).toISOString(),
    to: venueInstant(range[1], 24 * 60).toISOString(),
  })
  if (status) params.set('status', status)
  const { data, loading, reload } = useApi<AdminBooking[]>(`/admin/bookings?${params}`)

  const cancel = async () => {
    if (!cancelling || !reason.trim()) return
    if (
      await attempt(
        () => api('POST', `/admin/bookings/${cancelling.id}/cancel`, { reason }),
        '已取消',
      )
    ) {
      setCancelling(null)
      setReason('')
      await reload()
    }
  }

  return (
    <div>
      <div className="toolbar">
        <DateRangePicker
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
            { label: '已取消', value: 'cancelled' },
            { label: '已超时', value: 'expired' },
          ]}
        />
      </div>
      <Table
        rowKey="id"
        loading={loading}
        data={data ?? []}
        empty="这段时间没有预约"
        columns={[
          {
            colKey: 'startsAt',
            title: '时间',
            cell: ({ row }) => `${fmtDateTime(row.startsAt)}-${fmtTime(row.endsAt)}`,
          },
          { colKey: 'coach', title: '教练', cell: ({ row }) => row.coach.name },
          { colKey: 'lessonType', title: '课程', cell: ({ row }) => row.lessonType.name },
          {
            colKey: 'student',
            title: '学员',
            cell: ({ row }) => (
              <a href={`#/students?id=${row.student?.id ?? ''}`}>
                {row.student?.name || '未填写'} {row.student?.phone}
              </a>
            ),
          },
          {
            colKey: 'paid',
            title: '支付',
            cell: ({ row }) =>
              row.paidWith === 'package'
                ? `课时包 ${row.packageName ?? ''}`
                : row.price
                  ? yuan(row.price)
                  : '免费',
          },
          {
            colKey: 'status',
            title: '状态',
            cell: ({ row }) => {
              const [label, theme] = bookingStatusLabel[row.status]
              const refund = row.refund ? refundStatusLabel[row.refund.status] : null
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
          confirmBtn={{ content: '确认取消', theme: 'danger', disabled: !reason.trim() }}
          onConfirm={cancel}
          onClose={() => setCancelling(null)}
        >
          <p>
            {cancelling.student?.name} {fmtDateTime(cancelling.startsAt)}{' '}
            {cancelling.lessonType.name}
          </p>
          <p className="muted">场馆取消时，已付款项全额退回微信，课时包课时退回。</p>
          <Textarea
            placeholder="取消原因，学员可见"
            value={reason}
            maxlength={100}
            onChange={(v) => setReason(String(v))}
          />
        </Dialog>
      )}
    </div>
  )
}
