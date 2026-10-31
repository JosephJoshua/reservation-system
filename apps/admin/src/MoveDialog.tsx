import { venueDateKey } from '@rs/shared'
import { useState } from 'react'
import { Dialog } from 'tdesign-react'
import { api } from './api'
import { Field } from './Field'
import { fmtDateTime } from './format'
import { attempt, useApi, useIdempotencyKey, useSubmitting } from './hooks'
import { type LessonPick, LessonTimePicker, pickBody } from './LessonTimePicker'
import type { Coach, LessonType } from './types'

/** What the move dialog needs to know about the lesson. */
export interface MovingLesson {
  id: number
  startsAt: string
  endsAt: string
  lessonType: { id: number; name: string }
  coach: { id: number; name: string }
  student: { name: string } | null
}

/**
 * 改约 at the desk: moves a confirmed lesson to another time of the same length, with any coach
 * who teaches it, inside their 排班 or, agreed with the coach, outside it. A group class moves to
 * another session of the same class.
 */
export function MoveDialog({
  booking,
  onClose,
  onDone,
}: {
  booking: MovingLesson
  onClose: () => void
  onDone: () => void
}) {
  const coaches = useApi<Coach[]>('/admin/coaches')
  const types = useApi<LessonType[]>('/admin/lesson-types')
  const [pick, setPick] = useState<LessonPick | null>(null)
  const [refresh, setRefresh] = useState(0)
  const submitting = useSubmitting()
  const key = useIdempotencyKey()
  const lessonType = (types.data ?? []).find((t) => t.id === booking.lessonType.id)
  const teaching = (coaches.data ?? []).filter(
    (c) => c.active && c.lessonTypeIds.includes(booking.lessonType.id),
  )
  const minutes = (Date.parse(booking.endsAt) - Date.parse(booking.startsAt)) / 60_000

  const submit = async () => {
    if (!pick) return
    const ok = await attempt(
      () =>
        api(
          'POST',
          `/admin/bookings/${booking.id}/move`,
          // What the dialog shows as the lesson's time: one moved elsewhere meanwhile is refused.
          { ...pickBody(pick), from: { coachId: booking.coach.id, startsAt: booking.startsAt } },
          { key },
        ),
      '已改约',
      {
        // The lesson was cancelled, started or moved meanwhile.
        stale: ['not_movable', 'started', 'booking_changed'],
        onStale: onDone,
        // The time may have gone meanwhile: pick again from what is free now.
        onRefused: () => {
          setPick(null)
          setRefresh((n) => n + 1)
        },
      },
    )
    if (ok) onDone()
  }

  return (
    <Dialog
      visible
      width={600}
      header="改约"
      confirmBtn={{ content: '确认改约', disabled: !pick, loading: submitting }}
      cancelBtn="返回"
      onConfirm={submit}
      onClose={onClose}
    >
      <p>
        {booking.student?.name || '未填写姓名'} {booking.lessonType.name}，当前{' '}
        {fmtDateTime(booking.startsAt)} {booking.coach.name}
      </p>
      <div className="fields">
        <Field label="新时间">
          {coaches.error || types.error ? (
            <span className="field-text danger-text">{coaches.error ?? types.error}</span>
          ) : !lessonType ? (
            <span className="field-text muted">加载中</span>
          ) : teaching.length === 0 ? (
            <span className="field-text muted">没有教这门课的教练</span>
          ) : (
            <LessonTimePicker
              lessonType={lessonType}
              coaches={teaching}
              minutes={minutes}
              moving={{ id: booking.id, coachId: booking.coach.id, startsAt: booking.startsAt }}
              allowOutside
              initialCoachId={
                teaching.some((c) => c.id === booking.coach.id) ? booking.coach.id : undefined
              }
              initialDate={venueDateKey(new Date(booking.startsAt))}
              refresh={refresh}
              value={pick}
              onChange={setPick}
            />
          )}
        </Field>
      </div>
      <p className="muted">
        已付的款项和课时都不变。场馆改约不受教练价格和课时包适用范围的限制。订阅了通知的学员和教练会收到改约消息。
      </p>
    </Dialog>
  )
}
