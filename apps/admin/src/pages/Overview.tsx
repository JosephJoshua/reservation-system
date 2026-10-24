import { UNMARKED_DAYS } from '@rs/shared'
import { useEffect, useState } from 'react'
import { Button, Card, Space, Tag } from 'tdesign-react'
import { addDays, fmtTime, yuanGrouped } from '../format'
import { useApi } from '../hooks'
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

/** Read-only here: 签到 is marked on 今日. */
function Attendance({
  booking,
  started,
}: {
  booking: TodaySession['students'][number]
  started: boolean
}) {
  if (!started) return <Tag variant="light">未开始</Tag>
  return booking.attendance === null ? (
    <Tag variant="light">未签到</Tag>
  ) : (
    <Tag variant="light" theme={booking.attendance === 'attended' ? 'success' : 'warning'}>
      {booking.attendance === 'attended' ? '到课' : '缺席'}
    </Tag>
  )
}

// Lessons on now and next that the overview lists.
const TODAY_SHOWN = 5

const lessonName = (row: TodaySession) =>
  row.capacity === null
    ? row.lessonType
    : `${row.lessonType}（${row.students.length}/${row.capacity} 人）`

function Students({ row, now }: { row: TodaySession; now: number }) {
  return (
    <div className="today-students">
      {row.students.map((b) => (
        <div key={b.bookingId} className="today-student">
          <StudentCell student={b.student} />
          <Attendance booking={b} started={Date.parse(row.startsAt) <= now} />
        </div>
      ))}
    </div>
  )
}

export function Overview() {
  const { data, error, loading, reload } = useApi<Summary>('/admin/summary')
  const money = useCan('finance')
  const toToday = useCan('attendance')
  // Ticks so a lesson that starts while the page is open shows as started, and picks up 签到
  // marked on 今日, by coaches or by student scans.
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now())
      void reload()
    }, 30_000)
    return () => clearInterval(timer)
  }, [reload])
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
  // What is on now and next; the whole day is on 今日.
  const sessions = all.filter((s) => Date.parse(s.endsAt) > now).slice(0, TODAY_SHOWN)
  const done = all.length - all.filter((s) => Date.parse(s.endsAt) > now).length

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
        actions={
          toToday && (
            <Button variant="outline" href="#/checkin">
              去今日签到
            </Button>
          )
        }
      >
        <div className="today-list">
          {!data && loading && <div className="viz-empty">加载中</div>}
          {data && all.length === 0 && <div className="viz-empty">今天没有课</div>}
          {data && all.length > 0 && sessions.length === 0 && (
            <div className="viz-empty">今天的 {all.length} 节课都已结束</div>
          )}
          {sessions.map((row) => (
            <div key={row.slotId} className="today-item">
              <div className="today-item-head">
                <strong>
                  {fmtTime(row.startsAt)}-{fmtTime(row.endsAt)}
                </strong>{' '}
                {row.coach} · {lessonName(row)}
              </div>
              <Students row={row} now={now} />
            </div>
          ))}
        </div>
        {data && (done > 0 || all.length > done + sessions.length) && (
          <div className="stat-sub">
            {done > 0 && `已结束 ${done} 节`}
            {done > 0 && all.length > done + sessions.length && '，'}
            {all.length > done + sessions.length &&
              `之后还有 ${all.length - done - sessions.length} 节`}
            {toToday && '，全部在“今日”页查看'}
          </div>
        )}
      </Card>
    </Space>
  )
}
