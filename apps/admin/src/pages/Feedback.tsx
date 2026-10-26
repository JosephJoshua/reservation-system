import type { AdminFeedbackDto } from '@rs/shared'
import { venueInstant } from '@rs/shared'
import { useRef } from 'react'
import { Button, DateRangePicker, Select, Tag } from 'tdesign-react'
import { api } from '../api'
import { LessonTime } from '../bookingCells'
import { DataTable } from '../DataTable'
import { FeedbackPhotos } from '../FeedbackPhotos'
import { addDays, fmtDateTime, today } from '../format'
import { attempt, useApi, useSubmitting } from '../hooks'
import { useOnLessonChanged } from '../lessonLink'
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
import { StudentCell } from '../StudentCell'
import type { Coach, LessonType } from '../types'
import { undoMessage } from '../undo'

const stateOptions = [
  { label: '学员可见', value: 'visible' },
  { label: '学员不可见', value: 'invisible' },
  { label: '已隐藏', value: 'hidden' },
  { label: '教练已删除', value: 'deleted' },
]

function state(row: AdminFeedbackDto): [string, 'success' | 'warning' | 'default'] {
  if (row.deleted) return ['教练已删除', 'default']
  if (row.hidden) return ['已隐藏', 'default']
  // Written for a lesson since marked as not attended: kept, but the student does not see it.
  if (!row.visible) return ['学员不可见', 'warning']
  return ['学员可见', 'success']
}

/**
 * Coaches' 课后点评, newest lesson first, which the venue can hide from the student. With
 * `studentId`, all of one student's, as on their 学员详情; with `slotId`, one lesson's.
 */
export function Feedback({
  studentId,
  slotId,
  active = true,
  onChanged,
}: {
  studentId?: number
  slotId?: number
  /** On 预约, while its tab is the one shown, so the filters are in the address. */
  active?: boolean
  /** Called after a 隐藏 or 恢复, for views that show it too. */
  onChanged?: () => unknown
} = {}) {
  const filtered = !!(studentId || slotId)
  const filters = useListFilters(
    {
      from: addDays(today(), -30),
      to: today(),
      q: '',
      coach: '',
      type: '',
      state: '',
    },
    {
      path: filtered ? undefined : '#/bookings',
      active,
      valid: {
        from: isDay,
        to: isDay,
        coach: isId,
        type: isId,
        state: oneOf(...stateOptions.map((o) => o.value)),
      },
    },
  )
  const f = filters.values
  const range: [string, string] = f.from <= f.to ? [f.from, f.to] : [f.to, f.from]
  const coaches = useApi<Coach[]>(filtered ? null : '/admin/coaches')
  const types = useApi<LessonType[]>(filtered ? null : '/admin/lesson-types')

  const params = new URLSearchParams(
    slotId
      ? { slotId: String(slotId) }
      : studentId
        ? { studentId: String(studentId) }
        : {
            from: venueInstant(range[0], 0).toISOString(),
            to: venueInstant(range[1], 24 * 60).toISOString(),
          },
  )
  if (!filtered) {
    if (f.q) params.set('q', f.q)
    if (f.coach) params.set('coachId', f.coach)
    if (f.type) params.set('lessonTypeId', f.type)
    if (f.state) params.set('state', f.state)
  }
  const list = usePagedList<AdminFeedbackDto>(`/admin/feedback?${params}`, filters)
  // The list as filtered now, also for a 撤销 pressed after the filter changed.
  const reload = useRef(list.reload)
  reload.current = list.reload
  useOnLessonChanged(list.reload)
  const more = ['coach', 'type', 'state'] as const

  const setHidden = async (
    row: AdminFeedbackDto,
    hidden: boolean,
    undone = false,
  ): Promise<boolean> => {
    // Busy until the list shows the change, so its button can't send it again meanwhile.
    const ok = await attempt(
      async () => {
        await api('PUT', `/admin/feedback/${row.id}/hidden`, { hidden })
        await reload.current()
      },
      undone ? '已撤销' : hidden ? undefined : '已恢复',
      { key: hideKey(row.id) },
    )
    if (!ok) return false
    void onChanged?.()
    // Hiding takes effect at once, with 撤销 in the message instead of a confirmation.
    if (hidden && !undone)
      undoMessage('已隐藏，学员看不到这条点评', () => setHidden(row, false, true))
    return true
  }

  return (
    <div className="paged-list">
      {!filtered && (
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
              <Filter label="状态">
                <Select
                  style={{ width: 130 }}
                  clearable
                  placeholder="全部状态"
                  value={f.state || undefined}
                  onChange={(v) => filters.set({ state: String(v ?? '') })}
                  options={stateOptions}
                />
              </Filter>
            </>
          }
          set={filters.changed([...more])}
          onClear={() => filters.reset([...more])}
        />
      )}
      <DataTable
        rowKey="id"
        loading={list.loading}
        data={list.rows}
        empty={
          list.error ??
          (filtered
            ? '还没有课后点评'
            : filters.changed([...more, 'q'])
              ? '没有符合条件的课后点评'
              : '这段时间没有课后点评')
        }
        columns={[
          ...(slotId
            ? []
            : [
                {
                  colKey: 'startsAt',
                  title: '上课时间',
                  width: 130,
                  cell: ({ row }: { row: AdminFeedbackDto }) => (
                    <LessonTime slotId={row.slotId}>
                      <span className="nowrap">{fmtDateTime(row.startsAt)}</span>
                    </LessonTime>
                  ),
                },
              ]),
          ...(studentId
            ? []
            : [
                {
                  colKey: 'student',
                  title: '学员',
                  width: 140,
                  cell: ({ row }: { row: AdminFeedbackDto }) => (
                    <StudentCell student={row.student} />
                  ),
                },
              ]),
          ...(slotId
            ? []
            : [
                {
                  colKey: 'coach',
                  title: '教练',
                  width: 140,
                  cell: ({ row }: { row: AdminFeedbackDto }) => (
                    <div>
                      <div>{row.coach.name}</div>
                      <div className="muted">{row.lessonTypeName}</div>
                    </div>
                  ),
                },
              ]),
          {
            colKey: 'text',
            title: '点评',
            cell: ({ row }) => (
              <div className="feedback-cell">
                {row.deleted ? (
                  <div className="muted">删除于 {fmtDateTime(row.updatedAt)}</div>
                ) : (
                  <div className="feedback-text">{row.text}</div>
                )}
                <FeedbackPhotos photos={row.photos} />
                {!row.deleted && row.updatedAt !== row.createdAt && (
                  <div className="muted">修改于 {fmtDateTime(row.updatedAt)}</div>
                )}
              </div>
            ),
          },
          {
            colKey: 'hidden',
            title: '状态',
            width: 110,
            cell: ({ row }) => {
              const [label, theme] = state(row)
              return (
                <Tag theme={theme} variant="light">
                  {label}
                </Tag>
              )
            },
          },
          {
            colKey: 'actions',
            title: '操作',
            width: 90,
            cell: ({ row }) =>
              row.deleted ? null : row.hidden ? (
                <HideButton id={row.id} onClick={() => setHidden(row, false)}>
                  恢复
                </HideButton>
              ) : (
                <HideButton id={row.id} danger onClick={() => setHidden(row, true)}>
                  隐藏
                </HideButton>
              ),
          },
        ]}
      />
      <Pager list={list} filters={filters} />
    </div>
  )
}

const hideKey = (id: number) => `feedback-${id}`

function HideButton({
  id,
  danger = false,
  onClick,
  children,
}: {
  id: number
  danger?: boolean
  onClick: () => void
  children: string
}) {
  const busy = useSubmitting(hideKey(id))
  return (
    <Button variant="text" theme={danger ? 'danger' : 'primary'} loading={busy} onClick={onClick}>
      {children}
    </Button>
  )
}
