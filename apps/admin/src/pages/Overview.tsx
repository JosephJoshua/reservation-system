import { UNMARKED_DAYS } from '@rs/shared'
import { useEffect, useState } from 'react'
import { Button, Card, Checkbox, Select, Space, Tag } from 'tdesign-react'
import { api } from '../api'
import { BookForStudent } from '../BookForStudent'
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
  const canBook = useCan('bookings')
  // Ticks so a lesson that starts while the page is open can be marked.
  const [now, setNow] = useState(Date.now)
  const [coach, setCoach] = useState<string | null>(null)
  const [unmarkedOnly, setUnmarkedOnly] = useState(false)
  const [booking, setBooking] = useState(false)
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
  const all = data?.sessions ?? []
  const people = all.reduce((n, s) => n + s.students.length, 0)
  const coaches = [...new Set(all.map((s) => s.coach))]
  // A busy day has a lesson per coach per hour: the front desk narrows it to what needs marking.
  const sessions = all.filter(
    (s) =>
      (!coach || s.coach === coach) &&
      (!unmarkedOnly ||
        (Date.parse(s.startsAt) <= now && s.students.some((b) => b.attendance === null))),
  )

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
          <div className="stat">{data ? `${all.length} 节` : '-'}</div>
          {data && <div className="stat-sub">{people} 人次</div>}
        </Card>
      </div>

      <Card bordered title="待办" className="todo-card">
        <div className="todo-grid">
          {todo.map(([label, value, href]) => (
            <a key={label} href={href} className={value ? 'todo-item' : 'todo-item none'}>
              <span className="todo-label">{label}</span>
              <span className="todo-value">{value ?? '-'}</span>
            </a>
          ))}
        </div>
      </Card>

      <Card
        bordered
        title="今日课程"
        actions={canBook && <Button onClick={() => setBooking(true)}>代约</Button>}
      >
        <div className="toolbar">
          <Select
            style={{ width: 140 }}
            clearable
            placeholder="全部教练"
            value={coach ?? undefined}
            onChange={(v) => setCoach(v ? String(v) : null)}
            options={coaches.map((c) => ({ label: c, value: c }))}
          />
          <Checkbox checked={unmarkedOnly} onChange={(v) => setUnmarkedOnly(v)}>
            只看待签到
          </Checkbox>
        </div>
        {phone ? (
          <div className="today-list">
            {!data && loading && <div className="viz-empty">加载中</div>}
            {data && sessions.length === 0 && (
              <div className="viz-empty">{all.length ? '没有符合条件的课' : '今天没有课'}</div>
            )}
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
            empty={all.length ? '没有符合条件的课' : '今天没有课'}
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
      {booking && (
        <BookForStudent
          onClose={() => setBooking(false)}
          onDone={() => {
            setBooking(false)
            void reload()
          }}
        />
      )}
    </Space>
  )
}
