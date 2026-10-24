import { type StaffAction, staffActionLabels, venueInstant } from '@rs/shared'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, DateRangePicker, Select, Tag } from 'tdesign-react'
import { api, RequestError } from '../api'
import { DataTable } from '../DataTable'
import { addDays, fmtDateTime, yuan } from '../format'
import { useApi } from '../hooks'
import { StudentCell } from '../StudentCell'
import type { ActionLogEntry, Staff } from '../types'

// Matches the API's page size.
const PAGE = 50

const groups: { label: string; actions: StaffAction[] }[] = [
  {
    label: '预约',
    actions: ['booking.create', 'booking.cancel', 'booking.move', 'booking.attendance'],
  },
  { label: '点评', actions: ['feedback.hide', 'feedback.show'] },
  { label: '课时包', actions: ['package.sell', 'package.grant', 'package.extend'] },
  {
    label: '退款',
    actions: ['refund.approve', 'refund.reject', 'refund.retry', 'refund.paid_back'],
  },
  { label: '发票', actions: ['invoice.issue', 'invoice.reject', 'invoice.refund_seen'] },
  {
    label: '价格',
    actions: ['price.lesson_type', 'price.product', 'price.coach', 'price.coach_pay'],
  },
  { label: '其他', actions: ['settings.update', 'student.update', 'data.export'] },
  { label: '员工', actions: ['staff.create', 'staff.update', 'staff.password'] },
]

/** Read-only record of what each staff member did, newest first. */
export function ActionLog() {
  const staff = useApi<Staff[]>('/admin/staff')
  const [staffId, setStaffId] = useState<number | null>(null)
  const [group, setGroup] = useState<string>('')
  const [range, setRange] = useState<[string, string] | []>([])
  const [rows, setRows] = useState<ActionLogEntry[]>([])
  const [more, setMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)

  const params = new URLSearchParams()
  if (staffId) params.set('staffId', String(staffId))
  const actions = groups.find((g) => g.label === group)?.actions
  if (actions) params.set('actions', actions.join(','))
  if (range.length === 2) {
    params.set('from', venueInstant(range[0], 0).toISOString())
    params.set('to', venueInstant(addDays(range[1], 1), 0).toISOString())
  }
  const query = params.toString()

  const load = useCallback(
    async (before?: number) => {
      const mine = ++seq.current
      setLoading(true)
      try {
        const page = await api<ActionLogEntry[]>(
          'GET',
          `/admin/actions?${query}${before ? `&before=${before}` : ''}`,
        )
        if (mine !== seq.current) return
        setRows((old) => (before ? [...old, ...page] : page))
        setMore(page.length === PAGE)
        setError(null)
      } catch (e) {
        if (mine === seq.current) setError(e instanceof RequestError ? e.message : '加载失败')
      } finally {
        if (mine === seq.current) setLoading(false)
      }
    },
    [query],
  )

  useEffect(() => {
    setRows([])
    void load()
  }, [load])

  return (
    <div>
      <div className="toolbar">
        <Select
          style={{ width: 140 }}
          clearable
          placeholder="全部员工"
          value={staffId ?? undefined}
          options={(staff.data ?? []).map((s) => ({ label: s.name, value: s.id }))}
          onChange={(v) => setStaffId(v ? Number(v) : null)}
        />
        <Select
          style={{ width: 140 }}
          clearable
          placeholder="全部操作"
          value={group || undefined}
          options={groups.map((g) => ({ label: g.label, value: g.label }))}
          onChange={(v) => setGroup(String(v ?? ''))}
        />
        <DateRangePicker
          clearable
          placeholder={['开始日期', '结束日期']}
          value={range}
          onChange={(v) => setRange(v[0] && v[1] ? [String(v[0]), String(v[1])] : [])}
        />
      </div>
      <DataTable
        rowKey="id"
        loading={loading && rows.length === 0}
        data={rows}
        empty={error ?? '没有记录'}
        columns={[
          {
            colKey: 'createdAt',
            title: '时间',
            width: 120,
            cell: ({ row }) => <span className="nowrap">{fmtDateTime(row.createdAt)}</span>,
          },
          { colKey: 'staff', title: '员工', width: 100, cell: ({ row }) => row.staff.name },
          {
            colKey: 'action',
            title: '操作',
            width: 120,
            cell: ({ row }) => (
              <Tag variant="light" className="nowrap">
                {staffActionLabels[row.action] ?? row.action}
              </Tag>
            ),
          },
          { colKey: 'summary', title: '内容', cell: ({ row }) => row.summary },
          {
            colKey: 'student',
            title: '学员',
            width: 140,
            cell: ({ row }) => <StudentCell student={row.student} />,
          },
          {
            colKey: 'amount',
            title: '金额',
            width: 100,
            cell: ({ row }) => (row.amount === null ? '-' : yuan(row.amount)),
          },
        ]}
      />
      {rows.length > 0 && error && <p className="muted">{error}</p>}
      {more && (
        <div className="load-more">
          <Button variant="outline" loading={loading} onClick={() => load(rows.at(-1)?.id)}>
            加载更多
          </Button>
        </div>
      )}
    </div>
  )
}
