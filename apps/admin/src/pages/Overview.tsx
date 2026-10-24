import { UNMARKED_DAYS } from '@rs/shared'
import { useEffect, useState } from 'react'
import { Card, Select, Space, Tag } from 'tdesign-react'
import { api } from '../api'
import { DataTable } from '../DataTable'
import { addDays, fmtTime, yuanGrouped } from '../format'
import { attempt, useApi, useIsPhone } from '../hooks'
import { useCan } from '../me'
import { Delta } from '../StatDelta'
import { StudentCell } from '../StudentCell'
import type { Person } from '../types'

interface TodaySession {
  slotId: number
  startsAt: string
  endsAt: string
  coach: string
  lessonType: string
  capacity: number | null
  students: { bookingId: number; student: Person; attendance: 'attended' | 'no_show' | null }[]
}

interface Summary {
  upcomingBookings: number
  pendingPayments: number
  // Null for staff without finance, as is revenue.
  refundRequests: number | null
  failedRefunds: number | null
  offlineRefundsOwed: number | null
  date: string
  sessions: TodaySession[]
  unmarked: number
  revenue: { today: number; month: number; lastMonth: number } | null
  newStudents: { month: number; lastMonth: number }
}

function Attendance({
  booking,
  started,
  onMarked,
}: {
  booking: TodaySession['students'][number]
  started: boolean
  onMarked: () => void
}) {
  const canMark = useCan('attendance')
  if (!started) return <Tag variant="light">未开始</Tag>
  if (!canMark) {
    return booking.attendance === null ? (
      <Tag variant="light">未签到</Tag>
    ) : (
      <Tag variant="light" theme={booking.attendance === 'attended' ? 'success' : 'warning'}>
        {booking.attendance === 'attended' ? '到课' : '缺席'}
      </Tag>
    )
  }
  return (
    <Select
      size="small"
      style={{ width: 96 }}
      placeholder="未签到"
      clearable
      value={booking.attendance ?? undefined}
      options={[
        { label: '到课', value: 'attended' },
        { label: '缺席', value: 'no_show' },
      ]}
      onChange={async (v) => {
        if (
          await attempt(
            () =>
              api('PUT', `/admin/bookings/${booking.bookingId}/attendance`, {
                attendance: v ? String(v) : null,
              }),
            '已更新签到',
            { key: `attendance-${booking.bookingId}`, onStale: onMarked },
          )
        ) {
          onMarked()
        }
      }}
    />
  )
}

const lessonName = (row: TodaySession) =>
  row.capacity === null
    ? row.lessonType
    : `${row.lessonType}（${row.students.length}/${row.capacity} 人）`

function Students({
  row,
  now,
  onMarked,
}: {
  row: TodaySession
  now: number
  onMarked: () => void
}) {
  return (
    <div className="today-students">
      {row.students.map((b) => (
        <div key={b.bookingId} className="today-student">
          <StudentCell student={b.student} />
          <Attendance booking={b} started={Date.parse(row.startsAt) <= now} onMarked={onMarked} />
        </div>
      ))}
    </div>
  )
}

export function Overview() {
  const { data, error, loading, reload } = useApi<Summary>('/admin/summary')
  const phone = useIsPhone()
  const money = useCan('finance')
  // Ticks so a lesson that starts while the page is open can be marked.
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])
  if (error && !data) return <p className="muted">{error}</p>

  const todo: [string, number | null | undefined, string][] = [
    [
      '待签到',
      data?.unmarked,
      `#/bookings?status=completed&unmarked=1&from=${data ? addDays(data.date, -UNMARKED_DAYS) : ''}`,
    ],
    ['待上课预约', data?.upcomingBookings, '#/bookings?status=confirmed'],
    ['待支付', data?.pendingPayments, '#/bookings?status=pending_payment'],
    ...((money
      ? [
          ['待审核退款', data?.refundRequests, '#/refunds?status=requested'],
          ['待线下退还', data?.offlineRefundsOwed, '#/refunds?status=pending'],
          ['退款失败', data?.failedRefunds, '#/refunds?status=failed'],
        ]
      : []) as typeof todo),
  ]
  const sessions = data?.sessions ?? []
  const people = sessions.reduce((n, s) => n + s.students.length, 0)

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div className="stat-grid kpi-grid">
        {money && (
          <>
            <Card bordered>
              <div className="muted">今日收款</div>
              <div className="stat">{data?.revenue ? yuanGrouped(data.revenue.today) : '-'}</div>
              <div className="stat-sub">已扣除退款</div>
            </Card>
            <Card bordered>
              <div className="muted">本月收款</div>
              <div className="stat">{data?.revenue ? yuanGrouped(data.revenue.month) : '-'}</div>
              {data?.revenue && (
                <Delta
                  now={data.revenue.month}
                  before={data.revenue.lastMonth}
                  label="比上月同期"
                  format={yuanGrouped}
                />
              )}
            </Card>
          </>
        )}
        <Card bordered>
          <div className="muted">本月新学员</div>
          <div className="stat">{data ? `${data.newStudents.month} 人` : '-'}</div>
          {data && (
            <Delta
              now={data.newStudents.month}
              before={data.newStudents.lastMonth}
              label="比上月同期"
              format={(v) => `${v} 人`}
            />
          )}
        </Card>
        <Card bordered>
          <div className="muted">今日课程</div>
          <div className="stat">{data ? `${sessions.length} 节` : '-'}</div>
          {data && <div className="stat-sub">{people} 人次</div>}
        </Card>
      </div>

      <div className="stat-grid">
        {todo.map(([label, value, href]) => (
          <a key={label} href={href} style={{ textDecoration: 'none' }}>
            <Card bordered hoverShadow>
              <div className="muted">{label}</div>
              <div className="stat">{value ?? '-'}</div>
            </Card>
          </a>
        ))}
      </div>

      <Card bordered title="今日课程">
        {phone ? (
          <div className="today-list">
            {!data && loading && <div className="viz-empty">加载中</div>}
            {data && sessions.length === 0 && <div className="viz-empty">今天没有课</div>}
            {sessions.map((row) => (
              <div key={row.slotId} className="today-item">
                <div className="today-item-head">
                  <strong>
                    {fmtTime(row.startsAt)}-{fmtTime(row.endsAt)}
                  </strong>{' '}
                  {row.coach} · {lessonName(row)}
                </div>
                <Students row={row} now={now} onMarked={() => void reload()} />
              </div>
            ))}
          </div>
        ) : (
          <DataTable
            rowKey="slotId"
            loading={loading && !data}
            data={sessions}
            empty="今天没有课"
            columns={[
              {
                colKey: 'time',
                title: '时间',
                width: 120,
                cell: ({ row }) => `${fmtTime(row.startsAt)}-${fmtTime(row.endsAt)}`,
              },
              { colKey: 'coach', title: '教练', width: 120 },
              {
                colKey: 'lessonType',
                title: '课程',
                cell: ({ row }) => lessonName(row),
              },
              {
                colKey: 'students',
                title: '学员与签到',
                cell: ({ row }) => <Students row={row} now={now} onMarked={() => void reload()} />,
              },
            ]}
          />
        )}
      </Card>
    </Space>
  )
}
