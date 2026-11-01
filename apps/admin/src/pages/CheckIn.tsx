import {
  type AttendanceBy,
  CHECK_IN_EARLY_MINUTES,
  CHECK_IN_PATH,
  type FrontDeskLessonDto,
} from '@rs/shared'
import { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Card, Dialog, Input, Radio, Space, Tag } from 'tdesign-react'
import { renderSVG } from 'uqr'
import { api } from '../api'
import { BookForStudent } from '../BookForStudent'
import { confirmDisruptedArrival, DisruptionTag, LessonTime } from '../bookingCells'
import { DataTable } from '../DataTable'
import { NewStudentDialog } from '../DeskStudent'
import { fmtTime } from '../format'
import { attempt, useApi, useToday } from '../hooks'
import { useOnLessonChanged } from '../lessonLink'
import { useCan } from '../me'
import { StudentCell } from '../StudentCell'

type Filter = 'all' | 'unmarked' | 'marked'

const BY: Record<AttendanceBy, string> = { student: '学员扫码', coach: '教练', staff: '前台' }

/** The venue's 签到码: a link to the check-in path on this site, the same for every lesson. */
const codeUrl = () => `${window.location.origin}${CHECK_IN_PATH}`

function markedLine(row: FrontDeskLessonDto) {
  if (!row.attendanceAt) {
    if (row.attendance || row.canArrive) return null
    // Not open yet: say when the 签到 button turns up.
    const opens = new Date(Date.parse(row.startsAt) - CHECK_IN_EARLY_MINUTES * 60_000)
    return `${fmtTime(opens)} 起可签到`
  }
  const who = row.markedBy ? BY[row.markedBy.kind] : ''
  const name = row.markedBy?.name ? ` ${row.markedBy.name}` : ''
  return `${who}${name} ${fmtTime(row.attendanceAt)}`.trim()
}

function Status({ row }: { row: FrontDeskLessonDto }) {
  const line = markedLine(row)
  return (
    <div className="checkin-status">
      {row.attendance === 'attended' ? (
        <Tag theme="success" variant="light">
          到课
        </Tag>
      ) : row.attendance === 'no_show' ? (
        <Tag theme="danger" variant="light">
          缺席
        </Tag>
      ) : (
        <Tag variant="light">未签到</Tag>
      )}
      {row.disruption && <DisruptionTag disruption={row.disruption} />}
      {line && <span className="muted nowrap">{line}</span>}
    </div>
  )
}

function Actions({ row, onDone }: { row: FrontDeskLessonDto; onDone: () => void }) {
  const mark = async (attendance: 'attended' | 'no_show' | null) => {
    const label = { attended: '已签到', no_show: '已记为缺席' }
    // Staff on site know best, so asked rather than refused.
    if (
      attendance === 'attended' &&
      row.disruption &&
      !(await confirmDisruptedArrival(row.disruption))
    ) {
      return
    }
    if (
      await attempt(
        () => api('PUT', `/admin/bookings/${row.bookingId}/attendance`, { attendance }),
        attendance ? label[attendance] : '已撤销',
        { key: `attendance-${row.bookingId}`, onStale: onDone, stale: ['not_started'] },
      )
    ) {
      onDone()
    }
  }
  if (row.attendance) {
    return (
      <Button variant="text" theme="primary" onClick={() => void mark(null)}>
        撤销
      </Button>
    )
  }
  if (!row.canArrive) return null
  return (
    <Space size={8} className="nowrap">
      <Button theme="primary" onClick={() => void mark('attended')}>
        签到
      </Button>
      {row.canMarkAbsent && (
        <Button variant="outline" onClick={() => void mark('no_show')}>
          缺席
        </Button>
      )}
    </Space>
  )
}

function CodeDialog({ onClose }: { onClose: () => void }) {
  // Not /admin/settings, which is for 管理员 only.
  const settings = useApi<{ venueName: string; selfCheckIn: boolean }>('/admin/check-in-code')
  const canManage = useCan('manage')
  const svg = useMemo(() => renderSVG(codeUrl(), { border: 2 }), [])
  const print = () => {
    const w = window.open('', '_blank')
    if (!w) return
    const name = settings.data?.venueName ?? ''
    w.document.write(
      `<!doctype html><meta charset="utf-8"><title>签到码</title><style>body{font-family:system-ui,sans-serif;text-align:center;padding-top:48px;color:#000;background:#fff}h1{font-size:40px;margin:0 0 8px}p{font-size:22px;margin:8px 0}.qr{width:120mm;margin:24px auto}.qr svg{width:100%;height:auto}</style><h1>扫码签到</h1><p>${name.replace(/[<>&]/g, '')}</p><div class="qr">${svg}</div><p>打开小程序，在“课程”页点“扫码签到”</p><p>课前 ${CHECK_IN_EARLY_MINUTES} 分钟起可签到</p>`,
    )
    w.document.close()
    w.focus()
    w.print()
  }
  return (
    <Dialog
      visible
      header="签到码"
      onClose={onClose}
      confirmBtn={{ content: '打印', onClick: print }}
      cancelBtn="关闭"
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {settings.data && !settings.data.selfCheckIn && (
          <Alert
            theme="warning"
            message={
              canManage ? (
                <>
                  学员扫码签到已关闭，可以在<a href="#/settings?section=attendance">设置</a>中开启
                </>
              ) : (
                '学员扫码签到已关闭，需要时请联系管理员在设置中开启'
              )
            }
          />
        )}
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: uqr builds the SVG from our own URL */}
        <div className="checkin-qr" dangerouslySetInnerHTML={{ __html: svg }} />
        <div className="muted">
          打印后放在前台。学员课前 {CHECK_IN_EARLY_MINUTES}{' '}
          分钟起，打开小程序在“课程”页点“扫码签到”。
        </div>
      </Space>
    </Dialog>
  )
}

/** 今日: the front desk's day, one row per student, with 签到, 代约 and 前台建档. */
export function CheckIn() {
  const { data, error, loading, reload } = useApi<FrontDeskLessonDto[]>('/admin/front-desk')
  useOnLessonChanged(reload)
  // Left open past midnight: the new day's lessons.
  useToday(() => void reload())
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [showCode, setShowCode] = useState(false)
  const [booking, setBooking] = useState(false)
  const [adding, setAdding] = useState(false)
  const canBook = useCan('bookings')
  const canAdd = useCan('students')

  // Student scans and coach marks come in while the page is open.
  useEffect(() => {
    const timer = setInterval(() => void reload(), 30_000)
    return () => clearInterval(timer)
  }, [reload])

  const rows = data ?? []
  const q = query.trim().toLowerCase()
  const shown = rows.filter(
    (r) =>
      (filter === 'all' || (filter === 'unmarked') === (r.attendance === null)) &&
      (!q ||
        r.student.name.toLowerCase().includes(q) ||
        r.student.phone.includes(q) ||
        r.coach.name.toLowerCase().includes(q)),
  )
  const arrived = rows.filter((r) => r.attendance === 'attended').length
  const unmarked = rows.filter((r) => r.attendance === null).length

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div className="toolbar" style={{ marginBottom: 0 }}>
        <Input
          className="checkin-search"
          autofocus
          clearable
          placeholder="搜索学员姓名、手机号或教练"
          value={query}
          onChange={(v) => setQuery(String(v))}
        />
        <Radio.Group
          variant="default-filled"
          value={filter}
          onChange={(v) => setFilter(v as Filter)}
        >
          <Radio.Button value="all">全部</Radio.Button>
          <Radio.Button value="unmarked">未签到{data ? ` ${unmarked}` : ''}</Radio.Button>
          <Radio.Button value="marked">已签到</Radio.Button>
        </Radio.Group>
        <span className="spacer" />
        <Space size={8} breakLine>
          {canBook && (
            <Button theme="primary" onClick={() => setBooking(true)}>
              代约
            </Button>
          )}
          {canAdd && (
            <Button variant="outline" onClick={() => setAdding(true)}>
              前台建档
            </Button>
          )}
          <Button variant="outline" onClick={() => setShowCode(true)}>
            签到码
          </Button>
        </Space>
      </div>

      <Card bordered title={data ? `今日 ${rows.length} 人次，已到 ${arrived}` : '今日'}>
        {error && !data ? (
          <div className="viz-empty">
            {error}{' '}
            <Button variant="text" theme="primary" onClick={() => void reload()}>
              重试
            </Button>
          </div>
        ) : (
          <DataTable
            rowKey="bookingId"
            loading={loading && !data}
            data={shown}
            empty={rows.length ? '没有符合条件的学员' : '今天没有课'}
            columns={[
              {
                colKey: 'time',
                title: '时间',
                width: 120,
                cell: ({ row }) => (
                  <LessonTime slotId={row.slotId}>
                    <span className="nowrap">
                      {fmtTime(row.startsAt)}-{fmtTime(row.endsAt)}
                    </span>
                  </LessonTime>
                ),
              },
              {
                colKey: 'student',
                title: '学员',
                width: 160,
                cell: ({ row }) => <StudentCell student={row.student} />,
              },
              {
                colKey: 'lesson',
                title: '课程',
                cell: ({ row }) => `${row.coach.name} · ${row.lessonTypeName}`,
              },
              {
                colKey: 'status',
                title: '签到',
                width: 200,
                cell: ({ row }) => <Status row={row} />,
              },
              {
                colKey: 'actions',
                title: '操作',
                width: 180,
                cell: ({ row }) => <Actions row={row} onDone={() => void reload()} />,
              },
            ]}
          />
        )}
      </Card>
      {showCode && <CodeDialog onClose={() => setShowCode(false)} />}
      {booking && (
        <BookForStudent
          onClose={() => setBooking(false)}
          onDone={() => {
            setBooking(false)
            void reload()
          }}
        />
      )}
      {adding && (
        <NewStudentDialog
          initial={query.trim()}
          onClose={() => setAdding(false)}
          onDone={(student) => {
            setAdding(false)
            window.location.hash = `/students/${student.id}`
          }}
        />
      )}
    </Space>
  )
}
