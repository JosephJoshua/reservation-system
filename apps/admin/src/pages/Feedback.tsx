import type { AdminFeedbackDto } from '@rs/shared'
import { FEEDBACK_LIST_LIMIT, venueInstant } from '@rs/shared'
import { useState } from 'react'
import { Button, DateRangePicker, Select, Tag } from 'tdesign-react'
import { api } from '../api'
import { DataTable } from '../DataTable'
import { addDays, fmtDateTime, today } from '../format'
import { attempt, useApi } from '../hooks'
import { StudentCell } from '../StudentCell'
import type { Coach } from '../types'

function state(row: AdminFeedbackDto): [string, 'success' | 'warning' | 'default'] {
  if (row.deleted) return ['教练已删除', 'default']
  if (row.hidden) return ['已隐藏', 'default']
  // Written for a lesson since marked as not attended: kept, but the student does not see it.
  if (!row.visible) return ['学员不可见', 'warning']
  return ['学员可见', 'success']
}

/** Coaches' 课后点评, newest lesson first, which the venue can hide from the student. */
export function Feedback() {
  const [range, setRange] = useState<[string, string]>([addDays(today(), -30), today()])
  const [coachId, setCoachId] = useState<number | null>(null)
  const coaches = useApi<Coach[]>('/admin/coaches')

  const params = new URLSearchParams({
    from: venueInstant(range[0], 0).toISOString(),
    to: venueInstant(range[1], 24 * 60).toISOString(),
  })
  if (coachId) params.set('coachId', String(coachId))
  const { data, loading, error, reload } = useApi<AdminFeedbackDto[]>(`/admin/feedback?${params}`)

  const setHidden = async (row: AdminFeedbackDto, hidden: boolean) => {
    if (
      await attempt(
        () => api('PUT', `/admin/feedback/${row.id}/hidden`, { hidden }),
        hidden ? '已隐藏，学员看不到这条点评' : '已恢复',
        { key: `feedback-${row.id}` },
      )
    ) {
      await reload()
    }
  }

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
          placeholder="全部教练"
          value={coachId ?? undefined}
          onChange={(v) => setCoachId(v ? Number(v) : null)}
          options={(coaches.data ?? []).map((c) => ({ label: c.name, value: c.id }))}
        />
      </div>
      {data?.length === FEEDBACK_LIST_LIMIT && (
        <p className="muted">只显示最近 {FEEDBACK_LIST_LIMIT} 条，请缩小日期范围。</p>
      )}
      <DataTable
        rowKey="id"
        loading={loading}
        data={data ?? []}
        empty={error ?? '这段时间没有课后点评'}
        columns={[
          {
            colKey: 'startsAt',
            title: '上课时间',
            width: 130,
            cell: ({ row }) => <span className="nowrap">{fmtDateTime(row.startsAt)}</span>,
          },
          {
            colKey: 'student',
            title: '学员',
            width: 140,
            cell: ({ row }) => <StudentCell student={row.student} />,
          },
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
                {row.photos.length > 0 && (
                  <div className="feedback-photos">
                    {row.photos.map((url, i) => (
                      <a
                        key={url}
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        title={`照片 ${i + 1}`}
                      >
                        <img src={url} alt={`照片 ${i + 1}`} loading="lazy" />
                      </a>
                    ))}
                  </div>
                )}
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
    </div>
  )
}
