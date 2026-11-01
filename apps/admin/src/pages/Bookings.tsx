import { venueInstant } from '@rs/shared'
import { useEffect, useState } from 'react'
import { Button, Checkbox, DateRangePicker, Select, Space, Tabs } from 'tdesign-react'
import { BookForStudent } from '../BookForStudent'
import {
  AttendanceCell,
  CancelBookingDialog,
  DisruptionTag,
  LessonTime,
  PaidCell,
  StatusCell,
} from '../bookingCells'
import { DataTable } from '../DataTable'
import { ExportButton } from '../ExportButton'
import { addDays, fmtDateTime, fmtTime, today } from '../format'
import { hashParam, useApi, useNow } from '../hooks'
import { openLesson, useOnLessonChanged } from '../lessonLink'
import {
  Filter,
  FilterBar,
  isDay,
  isId,
  oneOf,
  Pager,
  SearchInput,
  useListFilters,
  usePagedList,
} from '../lists'
import { MoveDialog } from '../MoveDialog'
import { useCan } from '../me'
import { SHOW_SECTION } from '../SectionNav'
import { StudentCell } from '../StudentCell'
import type { AdminBooking, Coach, LessonType } from '../types'
import { Feedback } from './Feedback'

/** 预约 with its two tabs: the bookings, and the 课后点评 coaches wrote for them. */
export function Bookings() {
  const canFeedback = useCan('bookings')
  const [picked, setTab] = useState(() => hashParam('tab'))
  // A link to the other tab, such as an old 课后点评 link, while 预约 is open.
  useEffect(() => {
    const on = () => {
      if (window.location.hash.startsWith('#/bookings')) setTab(hashParam('tab'))
    }
    window.addEventListener('hashchange', on)
    window.addEventListener(SHOW_SECTION, on)
    return () => {
      window.removeEventListener('hashchange', on)
      window.removeEventListener(SHOW_SECTION, on)
    }
  }, [])
  const tab = picked === 'feedback' && canFeedback ? 'feedback' : 'bookings'
  const pick = (t: string) => {
    setTab(t)
    // Each tab then puts its own filters in the address.
    showParams(t === 'feedback' ? { tab: 'feedback' } : {})
  }
  // Without 课后点评 there is one list: no tab bar for it.
  if (!canFeedback) return <BookingList active />
  return (
    <Tabs value={tab} onChange={(v) => pick(String(v))} className="detail-tabs">
      <Tabs.TabPanel value="bookings" label="预约" destroyOnHide={false}>
        <BookingList active={tab === 'bookings'} />
      </Tabs.TabPanel>
      <Tabs.TabPanel value="feedback" label="课后点评">
        <Feedback active={tab === 'feedback'} />
      </Tabs.TabPanel>
    </Tabs>
  )
}

/** Puts the tab in the address, keeping an open lesson. */
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

const statusOptions = [
  { label: '待支付', value: 'pending_payment' },
  { label: '已预约', value: 'confirmed' },
  { label: '已完成', value: 'completed' },
  { label: '已取消', value: 'cancelled' },
  { label: '已超时', value: 'expired' },
]
const payOptions = [
  { label: '课时包', value: 'package' },
  { label: '微信支付', value: 'wechat' },
  { label: '线下付款', value: 'offline' },
]
const sourceOptions = [
  { label: '学员自约', value: 'student' },
  { label: '员工代约', value: 'staff' },
]
const label = (options: { label: string; value: string }[], v: string) =>
  options.find((o) => o.value === v)?.label

function BookingList({ active }: { active: boolean }) {
  // The overview links here with `from` alone for lessons still to mark, up to today; a later
  // `from` alone gets two weeks from it. The range is always in the address, so this only
  // applies to such a link.
  const from = active ? hashParam('from') : null
  const filters = useListFilters(
    {
      from: today(),
      to:
        from && isDay(from)
          ? from <= today()
            ? today()
            : addDays(from, 13)
          : addDays(today(), 13),
      q: '',
      status: '',
      coach: '',
      type: '',
      pay: '',
      source: '',
      unmarked: '',
      order: 'asc',
    },
    {
      path: '#/bookings',
      active,
      always: ['from', 'to'],
      valid: {
        from: isDay,
        to: isDay,
        status: oneOf(...statusOptions.map((o) => o.value)),
        coach: isId,
        type: isId,
        pay: oneOf(...payOptions.map((o) => o.value)),
        source: oneOf(...sourceOptions.map((o) => o.value)),
        unmarked: oneOf('1'),
        order: oneOf('asc', 'desc'),
      },
    },
  )
  const f = filters.values
  const range: [string, string] = f.from <= f.to ? [f.from, f.to] : [f.to, f.from]
  const canBook = useCan('bookings')
  // 改约 goes once a lesson starts, with the page left open.
  const now = useNow(10_000)
  const canMark = useCan('attendance')
  const money = useCan('finance')
  const coaches = useApi<Coach[]>('/admin/coaches')
  const types = useApi<LessonType[]>('/admin/lesson-types')
  const [cancelling, setCancelling] = useState<AdminBooking | null>(null)
  const [moving, setMoving] = useState<AdminBooking | null>(null)
  const [booking, setBooking] = useState(false)

  const params = new URLSearchParams({
    from: venueInstant(range[0], 0).toISOString(),
    to: venueInstant(range[1], 24 * 60).toISOString(),
    order: f.order,
  })
  if (f.q) params.set('q', f.q)
  if (f.status) params.set('status', f.status)
  if (f.coach) params.set('coachId', f.coach)
  if (f.type) params.set('lessonTypeId', f.type)
  if (f.pay) params.set('pay', f.pay)
  if (f.source) params.set('source', f.source)
  if (f.unmarked) params.set('unmarked', '1')
  const list = usePagedList<AdminBooking>(`/admin/bookings?${params}`, filters)
  const { reload } = list
  useOnLessonChanged(reload)
  const more = ['status', 'coach', 'type', 'pay', 'source', 'unmarked'] as const
  const coachName = coaches.data?.find((c) => String(c.id) === f.coach)?.name
  const typeName = types.data?.find((t) => String(t.id) === f.type)?.name

  return (
    <div className="paged-list">
      <FilterBar
        main={
          <>
            <DateRangePicker
              style={{ width: 280 }}
              value={range}
              onChange={(v) =>
                filters.set({ from: String(v[0] ?? today()), to: String(v[1] ?? today()) })
              }
            />
            <SearchInput value={f.q} onChange={(q) => filters.set({ q })} />
          </>
        }
        more={
          <>
            <Filter label="状态">
              <Select
                style={{ width: 120 }}
                clearable
                placeholder="全部状态"
                value={f.status || undefined}
                onChange={(v) => filters.set({ status: String(v ?? '') })}
                options={statusOptions}
              />
            </Filter>
            <Filter label="教练">
              <Select
                style={{ width: 120 }}
                clearable
                filterable
                placeholder="全部教练"
                value={f.coach ? Number(f.coach) : undefined}
                onChange={(v) => filters.set({ coach: v ? String(v) : '' })}
                options={(coaches.data ?? []).map((c) => ({ label: c.name, value: c.id }))}
              />
            </Filter>
            <Filter label="课程">
              <Select
                style={{ width: 140 }}
                clearable
                filterable
                placeholder="全部课程"
                value={f.type ? Number(f.type) : undefined}
                onChange={(v) => filters.set({ type: v ? String(v) : '' })}
                options={(types.data ?? []).map((t) => ({ label: t.name, value: t.id }))}
              />
            </Filter>
            <Filter label="支付">
              <Select
                style={{ width: 120 }}
                clearable
                placeholder="全部支付"
                value={f.pay || undefined}
                onChange={(v) => filters.set({ pay: String(v ?? '') })}
                options={payOptions}
              />
            </Filter>
            <Filter label="来源">
              <Select
                style={{ width: 120 }}
                clearable
                placeholder="全部来源"
                value={f.source || undefined}
                onChange={(v) => filters.set({ source: String(v ?? '') })}
                options={sourceOptions}
              />
            </Filter>
            <Filter label="排序">
              <Select
                style={{ width: 120 }}
                value={f.order}
                onChange={(v) => filters.set({ order: v === 'desc' ? 'desc' : 'asc' })}
                options={[
                  { label: '时间升序', value: 'asc' },
                  { label: '时间降序', value: 'desc' },
                ]}
              />
            </Filter>
            <Filter label="">
              <Checkbox
                checked={f.unmarked === '1'}
                onChange={(v) => filters.set({ unmarked: v ? '1' : '' })}
              >
                只看未签到
              </Checkbox>
            </Filter>
          </>
        }
        set={filters.changed([...more])}
        onClear={() => filters.reset([...more])}
        actions={
          (money || canBook) && (
            <>
              {money && (
                <ExportButton
                  kind="bookings"
                  range={range}
                  filters={{
                    q: f.q,
                    status: f.status,
                    coachId: f.coach,
                    lessonTypeId: f.type,
                    pay: f.pay,
                    source: f.source,
                    unmarked: f.unmarked || undefined,
                  }}
                  filterText={
                    [
                      f.q && `搜索“${f.q}”`,
                      f.status && `状态：${label(statusOptions, f.status)}`,
                      f.coach && `教练：${coachName ?? ''}`,
                      f.type && `课程：${typeName ?? ''}`,
                      f.pay && `支付：${label(payOptions, f.pay)}`,
                      f.source && label(sourceOptions, f.source),
                      f.unmarked && '未签到',
                    ]
                      .filter(Boolean)
                      .join('，') || undefined
                  }
                />
              )}
              {canBook && <Button onClick={() => setBooking(true)}>代约</Button>}
            </>
          )
        }
      />
      <DataTable
        rowKey="id"
        onOpen={(row) => openLesson(row.slotId)}
        loading={list.loading}
        data={list.rows}
        empty={
          list.error ??
          (filters.changed([...more, 'q']) ? '没有符合条件的预约' : '这段时间没有预约')
        }
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
          {
            colKey: 'status',
            title: '状态',
            cell: ({ row }) => (
              <>
                <StatusCell row={row} />
                {row.lessonDisruption && (
                  <>
                    {' '}
                    <DisruptionTag disruption={row.lessonDisruption} />
                  </>
                )}
              </>
            ),
          },
          {
            colKey: 'attendance',
            title: '签到',
            cell: ({ row }) => (
              <AttendanceCell row={row} canMark={canMark} now={now} onChanged={reload} />
            ),
          },
          ...(canBook
            ? [
                {
                  colKey: 'op',
                  title: '操作',
                  width: 150,
                  cell: ({ row }: { row: AdminBooking }) => {
                    const upcoming = Date.parse(row.startsAt) > now
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
      <Pager list={list} filters={filters} />
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
