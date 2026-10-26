import { venueInstant } from '@rs/shared'
import { useEffect, useState } from 'react'
import { Button, Checkbox, DateRangePicker, Select, Space, Tabs } from 'tdesign-react'
import { BookForStudent } from '../BookForStudent'
import {
  AttendanceCell,
  CancelBookingDialog,
  LessonTime,
  PaidCell,
  StatusCell,
} from '../bookingCells'
import { DataTable, LoadMore } from '../DataTable'
import { ExportButton } from '../ExportButton'
import { addDays, fmtDateTime, fmtTime, today } from '../format'
import { hashParam, useApi, usePagedApi } from '../hooks'
import { bookingStatusLabel } from '../labels'
import { openLesson, useOnLessonChanged } from '../lessonLink'
import { MoveDialog } from '../MoveDialog'
import { useCan } from '../me'
import { SHOW_SECTION } from '../SectionNav'
import { StudentCell } from '../StudentCell'
import type { AdminBooking, Coach } from '../types'
import { Feedback } from './Feedback'

const isDay = (v: string | null): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v)

/** 预约 with its two tabs: the bookings, and the 课后点评 coaches wrote for them. */
export function Bookings() {
  const canFeedback = useCan('bookings')
  const [picked, setTab] = useState(() => hashParam('tab'))
  const tab = picked === 'feedback' && canFeedback ? 'feedback' : 'bookings'
  const pick = (t: string) => {
    setTab(t)
    // The bookings tab puts its own filters back in the address.
    if (t === 'feedback') showParams({ tab: 'feedback' })
  }
  return (
    <Tabs value={tab} onChange={(v) => pick(String(v))} className="detail-tabs">
      <Tabs.TabPanel value="bookings" label="预约" destroyOnHide={false}>
        <BookingList active={tab === 'bookings'} />
      </Tabs.TabPanel>
      {canFeedback && (
        <Tabs.TabPanel value="feedback" label="课后点评">
          <Feedback />
        </Tabs.TabPanel>
      )}
    </Tabs>
  )
}

/** Puts the filters in the address for a refresh or a copied link, keeping an open lesson. */
function showParams(values: Record<string, string>) {
  const params = new URLSearchParams(values)
  const lesson = hashParam('lesson')
  if (lesson) params.set('lesson', lesson)
  const query = params.toString()
  const next = `#/bookings${query ? `?${query}` : ''}`
  if (next === window.location.hash) return
  history.replaceState(history.state, '', next)
  window.dispatchEvent(new Event(SHOW_SECTION))
}

function BookingList({ active }: { active: boolean }) {
  const [range, setRange] = useState<[string, string]>(() => {
    const from = hashParam('from')
    const to = hashParam('to')
    if (isDay(from) && isDay(to) && from <= to) return [from, to]
    // The overview links here with `from` alone for lessons still to mark.
    return isDay(from) && from <= today() ? [from, today()] : [today(), addDays(today(), 13)]
  })
  // The overview links here with the status it counted.
  const [status, setStatus] = useState(() => hashParam('status') ?? '')
  const [unmarked, setUnmarked] = useState(() => hashParam('unmarked') === '1')
  const [coachId, setCoachId] = useState<number | null>(() => {
    const id = Number(hashParam('coach'))
    return Number.isSafeInteger(id) && id > 0 ? id : null
  })
  const [order, setOrder] = useState<'asc' | 'desc'>(() =>
    hashParam('order') === 'desc' ? 'desc' : 'asc',
  )
  useEffect(() => {
    const values: Record<string, string> = { from: range[0], to: range[1] }
    if (status) values.status = status
    if (coachId) values.coach = String(coachId)
    if (unmarked) values.unmarked = '1'
    if (order === 'desc') values.order = 'desc'
    if (active) showParams(values)
  }, [active, range, status, coachId, unmarked, order])
  const canBook = useCan('bookings')
  const canMark = useCan('attendance')
  const money = useCan('finance')
  const coaches = useApi<Coach[]>('/admin/coaches')
  const [cancelling, setCancelling] = useState<AdminBooking | null>(null)
  const [moving, setMoving] = useState<AdminBooking | null>(null)
  const [booking, setBooking] = useState(false)

  const params = new URLSearchParams({
    from: venueInstant(range[0], 0).toISOString(),
    to: venueInstant(range[1], 24 * 60).toISOString(),
    order,
  })
  if (status) params.set('status', status)
  if (coachId) params.set('coachId', String(coachId))
  if (unmarked) params.set('unmarked', '1')
  const list = usePagedApi<AdminBooking>(`/admin/bookings?${params}`, 'offset')
  const { reload } = list
  useOnLessonChanged(reload)

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
        <div className="toolbar-actions">
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
      </div>
      <DataTable
        rowKey="id"
        onOpen={(row) => openLesson(row.slotId)}
        loading={list.loading && !list.loaded}
        data={list.rows}
        empty={list.error ?? '这段时间没有预约'}
        columns={[
          {
            colKey: 'startsAt',
            title: '时间',
            width: 150,
            cell: ({ row }) => (
              <div>
                <LessonTime slotId={row.slotId}>
                  <span className="nowrap">
                    {fmtDateTime(row.startsAt)}-{fmtTime(row.endsAt)}
                  </span>
                </LessonTime>
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
          { colKey: 'paid', title: '支付', cell: ({ row }) => <PaidCell row={row} /> },
          { colKey: 'status', title: '状态', cell: ({ row }) => <StatusCell row={row} /> },
          {
            colKey: 'attendance',
            title: '签到',
            cell: ({ row }) => <AttendanceCell row={row} canMark={canMark} onChanged={reload} />,
          },
          ...(canBook
            ? [
                {
                  colKey: 'op',
                  title: '操作',
                  width: 150,
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
      <LoadMore
        shown={list.rows.length}
        more={list.more}
        loading={list.loading}
        onMore={list.loadMore}
      />
      {moving && (
        <MoveDialog
          booking={moving}
          onClose={() => setMoving(null)}
          onDone={() => {
            setMoving(null)
            void reload()
          }}
        />
      )}
      {cancelling && (
        <CancelBookingDialog
          booking={cancelling}
          onClose={() => setCancelling(null)}
          onDone={reload}
        />
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
