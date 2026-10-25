import type { AdminFeedbackDto } from '@rs/shared'
import { venueInstant } from '@rs/shared'
import { useState } from 'react'
import { Button, DateRangePicker, Select, Tag } from 'tdesign-react'
import { api } from '../api'
import { DataTable, LoadMore } from '../DataTable'
import { FeedbackPhotos } from '../FeedbackPhotos'
import { addDays, fmtDateTime, today } from '../format'
import { attempt, useApi, usePagedApi } from '../hooks'
import { StudentCell } from '../StudentCell'
import type { Coach } from '../types'
import { undoMessage } from '../undo'

function state(row: AdminFeedbackDto): [string, 'success' | 'warning' | 'default'] {
  if (row.deleted) return ['教练已删除', 'default']
  if (row.hidden) return ['已隐藏', 'default']
  // Written for a lesson since marked as not attended: kept, but the student does not see it.
  if (!row.visible) return ['学员不可见', 'warning']
  return ['学员可见', 'success']
}

/**
 * Coaches' 课后点评, newest lesson first, which the venue can hide from the student. With
 * `studentId`, all of one student's, as on their 学员详情.
 */
export function Feedback({ studentId }: { studentId?: number } = {}) {
  const [range, setRange] = useState<[string, string]>([addDays(today(), -30), today()])
  const [coachId, setCoachId] = useState<number | null>(null)
  const coaches = useApi<Coach[]>(studentId ? null : '/admin/coaches')

  const params = new URLSearchParams(
    studentId
      ? { studentId: String(studentId) }
      : {
          from: venueInstant(range[0], 0).toISOString(),
          to: venueInstant(range[1], 24 * 60).toISOString(),
        },
  )
  if (coachId && !studentId) params.set('coachId', String(coachId))
  const list = usePagedApi<AdminFeedbackDto>(`/admin/feedback?${params}`, 'offset')
  const { reload } = list

  const setHidden = async (row: AdminFeedbackDto, hidden: boolean, undone = false) => {
    if (
      await attempt(
        () => api('PUT', `/admin/feedback/${row.id}/hidden`, { hidden }),
        undone ? '已撤销' : hidden ? undefined : '已恢复',
        { key: `feedback-${row.id}` },
      )
    ) {
      // Hiding takes effect at once, with 撤销 in the message instead of a confirmation.
      if (hidden && !undone)
        undoMessage('已隐藏，学员看不到这条点评', () => void setHidden(row, false, true))
      await reload()
    }
  }

  return (
    <div>
      {!studentId && (
        <div className="toolbar">
          <DateRangePicker
            style={{ width: 280 }}
            value={range}
            onChange={(v) => setRange([String(v[0] ?? today()), String(v[1] ?? today())])}
          />
          <Select
            style={{ width: 140 }}
            clearable
            placeholder="全部教练"
            value={coachId ?? undefined}
            onChange={(v) => setCoachId(v ? Number(v) : null)}
            options={(coaches.data ?? []).map((c) => ({ label: c.name, value: c.id }))}
          />
        </div>
      )}
      <DataTable
        rowKey="id"
        loading={list.loading && !list.loaded}
        data={list.rows}
        empty={list.error ?? (studentId ? '还没有课后点评' : '这段时间没有课后点评')}
        columns={[
          {
            colKey: 'startsAt',
            title: '上课时间',
            width: 130,
            cell: ({ row }) => <span className="nowrap">{fmtDateTime(row.startsAt)}</span>,
          },
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
          {
            colKey: 'coach',
            title: '教练',
            width: 140,
            cell: ({ row }) => (
              <div>
                <div>{row.coach.name}</div>
                <div className="muted">{row.lessonTypeName}</div>
              </div>
            ),
          },
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
                <Button variant="text" theme="primary" onClick={() => setHidden(row, false)}>
                  恢复
                </Button>
              ) : (
                <Button variant="text" theme="danger" onClick={() => setHidden(row, true)}>
                  隐藏
                </Button>
              ),
          },
        ]}
      />
      <LoadMore
        shown={list.rows.length}
        more={list.more}
        loading={list.loading}
        onMore={list.loadMore}
      />
    </div>
  )
}
