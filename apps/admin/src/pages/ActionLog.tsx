import { type StaffAction, staffActionLabels } from '@rs/shared'
import { Select, Tag } from 'tdesign-react'
import { DataTable } from '../DataTable'
import { actorName, fmtDateTime, yuan } from '../format'
import { useApi } from '../hooks'
import {
  DateFilter,
  Filter,
  FilterBar,
  isDay,
  isId,
  oneOf,
  Pager,
  SearchInput,
  setRange,
  useListFilters,
  usePagedList,
} from '../lists'
import { StudentCell } from '../StudentCell'
import type { ActionLogEntry, Coach, Staff } from '../types'

const groups: { label: string; actions: StaffAction[] }[] = [
  {
    label: '预约',
    actions: ['booking.create', 'booking.cancel', 'booking.move', 'booking.attendance'],
  },
  {
    label: '排班',
    actions: [
      'schedule.hours',
      'schedule.add',
      'schedule.remove',
      'schedule.end',
      'session.create',
      'session.update',
      'session.cancel',
    ],
  },
  {
    label: '教练操作',
    actions: [
      'coach.cancel',
      'coach.move',
      'coach.hours',
      'coach.leave_add',
      'coach.leave_remove',
      'coach.leave_end',
    ],
  },
  { label: '点评', actions: ['feedback.hide', 'feedback.show'] },
  { label: '课时包', actions: ['package.sell', 'package.grant', 'package.extend'] },
  {
    label: '退款',
    actions: [
      'refund.approve',
      'refund.reject',
      'refund.retry',
      'refund.synced',
      'refund.paid_back',
    ],
  },
  { label: '发票', actions: ['invoice.issue', 'invoice.reject', 'invoice.refund_seen'] },
  { label: '订单', actions: ['order.anomaly_handled'] },
  {
    label: '价格',
    actions: [
      'price.lesson_type',
      'price.product',
      'price.coach',
      'price.coach_pay',
      'pay.confirm',
      'pay.unconfirm',
    ],
  },
  {
    label: '学员',
    actions: ['student.create', 'student.update', 'student.delete'],
  },
  { label: '其他', actions: ['settings.update', 'rules.lesson_type', 'data.export'] },
  { label: '员工', actions: ['staff.create', 'staff.update', 'staff.roles', 'staff.password'] },
]

/** Read-only record of what each staff member, and each coach in the mini program, did. */
export function ActionLog() {
  const staff = useApi<Staff[]>('/admin/staff')
  const coaches = useApi<Coach[]>('/admin/coaches')
  const filters = useListFilters(
    { staff: '', coach: '', group: '', from: '', to: '', q: '' },
    {
      path: '#/actions',
      valid: {
        staff: isId,
        coach: isId,
        group: oneOf(...groups.map((g) => g.label)),
        from: isDay,
        to: isDay,
      },
    },
  )
  const f = filters.values
  const params = new URLSearchParams()
  if (f.staff) params.set('staffId', f.staff)
  if (f.coach) params.set('coachId', f.coach)
  const actions = groups.find((g) => g.label === f.group)?.actions
  if (actions) params.set('actions', actions.join(','))
  setRange(params, f.from, f.to)
  if (f.q) params.set('q', f.q)
  const list = usePagedList<ActionLogEntry>(`/admin/actions?${params}`, filters)
  const more = ['staff', 'coach', 'group'] as const

  return (
    <div className="paged-list">
      <FilterBar
        main={
          <>
            <DateFilter
              from={f.from}
              to={f.to}
              placeholder={['开始日期', '结束日期']}
              onChange={(from, to) => filters.set({ from, to })}
            />
            <SearchInput
              placeholder="内容或学员"
              value={f.q}
              onChange={(q) => filters.set({ q })}
            />
          </>
        }
        more={
          <>
            <Filter label="员工">
              <Select
                style={{ width: 120 }}
                clearable
                placeholder="全部员工"
                value={f.staff ? Number(f.staff) : undefined}
                options={(staff.data ?? []).map((s) => ({ label: s.name, value: s.id }))}
                onChange={(v) => filters.set({ staff: v ? String(v) : '' })}
              />
            </Filter>
            <Filter label="教练">
              <Select
                style={{ width: 120 }}
                clearable
                placeholder="全部教练"
                value={f.coach ? Number(f.coach) : undefined}
                options={(coaches.data ?? []).map((c) => ({ label: c.name, value: c.id }))}
                onChange={(v) => filters.set({ coach: v ? String(v) : '' })}
              />
            </Filter>
            <Filter label="操作">
              <Select
                style={{ width: 120 }}
                clearable
                placeholder="全部操作"
                value={f.group || undefined}
                options={groups.map((g) => ({ label: g.label, value: g.label }))}
                onChange={(v) => filters.set({ group: String(v ?? '') })}
              />
            </Filter>
          </>
        }
        set={filters.changed([...more])}
        onClear={() => filters.reset([...more])}
      />
      <DataTable
        rowKey="id"
        loading={list.loading}
        data={list.rows}
        empty={
          list.error ??
          (filters.changed([...more, 'from', 'q']) ? '没有符合条件的记录' : '没有记录')
        }
        columns={[
          {
            colKey: 'createdAt',
            title: '时间',
            width: 120,
            cell: ({ row }) => <span className="nowrap">{fmtDateTime(row.createdAt)}</span>,
          },
          {
            colKey: 'staff',
            title: '操作人',
            width: 130,
            cell: ({ row }) => <span className="nowrap">{actorName(row)}</span>,
          },
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
          {
            colKey: 'summary',
            title: '内容',
            cell: ({ row }) =>
              row.targetKind === 'booking' && row.targetId ? (
                <a href={`#/lessons?booking=${row.targetId}`}>{row.summary}</a>
              ) : row.targetKind === 'slot' && row.targetId ? (
                <a href={`#/lessons/${row.targetId}`}>{row.summary}</a>
              ) : (
                row.summary
              ),
          },
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
      <Pager list={list} filters={filters} />
    </div>
  )
}
