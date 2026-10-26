import type { MouseEvent } from 'react'
import { useState } from 'react'
import { Dialog, Select, Tag, Textarea } from 'tdesign-react'
import { api } from './api'
import { fmtDateTime, yuan } from './format'
import { attempt, useSubmitting } from './hooks'
import { bookingStatusLabel, refundLabel } from './labels'
import { openLesson } from './lessonLink'
import type { AdminBooking } from './types'

/** How a booking was paid for, and who booked it at the desk. */
export function PaidCell({ row }: { row: AdminBooking }) {
  const how = [
    row.paidWith === 'package' && '课时包',
    row.bookedBy && `${row.bookedBy.name} 代约`,
  ].filter(Boolean)
  return (
    <>
      <div className="ellipsis" title={row.packageName ?? undefined}>
        {row.paidWith === 'package'
          ? (row.packageName ?? '课时包')
          : row.price
            ? yuan(row.price)
            : '免费'}
      </div>
      {how.length > 0 && <div className="muted nowrap">{how.join(' · ')}</div>}
    </>
  )
}

/** Its status, who cancelled it and any refund. */
export function StatusCell({ row }: { row: AdminBooking }) {
  const [label, theme] = bookingStatusLabel[row.status]
  const refund = row.refund ? refundLabel(row.refund.status, row.paidOffline) : null
  return (
    <span>
      <Tag theme={theme} variant="light">
        {label}
      </Tag>
      {row.status === 'cancelled' && (
        <>
          {' '}
          <span className="muted nowrap">
            {row.cancelledBy === 'venue' ? '场馆取消' : row.late ? '学员逾时取消' : '学员取消'}
          </span>
        </>
      )}
      {refund && row.refund && (
        <>
          {' '}
          <span className="muted nowrap">
            {refund[0]} {yuan(row.refund.amount)}
          </span>
        </>
      )}
    </span>
  )
}

/** 签到 once the lesson has started, which staff who mark attendance can change. */
export function AttendanceCell({
  row,
  canMark,
  onChanged,
}: {
  row: AdminBooking
  canMark: boolean
  onChanged: () => unknown
}) {
  const started = Date.parse(row.startsAt) <= Date.now()
  const markable = started && (row.status === 'confirmed' || row.status === 'completed')
  const mark = async (attendance: string | null) => {
    if (
      await attempt(
        () => api('PUT', `/admin/bookings/${row.id}/attendance`, { attendance }),
        '已更新签到',
        { key: `attendance-${row.id}` },
      )
    ) {
      await onChanged()
    }
  }
  return (
    <div>
      {markable && !canMark ? (
        <span className={row.attendance ? undefined : 'muted'}>
          {row.attendance === 'attended'
            ? '到课'
            : row.attendance === 'no_show'
              ? '缺席'
              : '未签到'}
        </span>
      ) : markable ? (
        <Select
          size="small"
          style={{ width: 96 }}
          placeholder="未签到"
          clearable
          value={row.attendance ?? undefined}
          options={[
            { label: '到课', value: 'attended' },
            { label: '缺席', value: 'no_show' },
          ]}
          onChange={(v) => mark(v ? String(v) : null)}
        />
      ) : (
        <span className="muted">-</span>
      )}
      {row.coachNote && (
        <div className="muted note-line" title={row.coachNote}>
          备注：{row.coachNote}
        </div>
      )}
    </div>
  )
}

/** The lesson's time, opening 课程详情 over the page; a new tab opens it as a page. */
export function LessonTime({ slotId, children }: { slotId: number; children: React.ReactNode }) {
  const open = (e: MouseEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    openLesson(slotId)
  }
  return (
    <a href={`#/lessons/${slotId}`} className="lesson-link" data-overlay onClick={open}>
      {children}
    </a>
  )
}

/** 场馆取消 for one booking, with the reason the student reads. */
export function CancelBookingDialog({
  booking,
  onClose,
  onDone,
}: {
  booking: AdminBooking
  onClose: () => void
  onDone: () => unknown
}) {
  const [reason, setReason] = useState('')
  const submitting = useSubmitting()
  const cancel = async () => {
    if (!reason.trim()) return
    if (
      await attempt(
        () => api('POST', `/admin/bookings/${booking.id}/cancel`, { reason }),
        '已取消',
        {
          onStale: () => {
            onClose()
            void onDone()
          },
        },
      )
    ) {
      onClose()
      await onDone()
    }
  }
  return (
    <Dialog
      visible
      header="场馆取消预约"
      confirmBtn={{
        content: '确认取消',
        theme: 'danger',
        disabled: !reason.trim(),
        loading: submitting,
      }}
      cancelBtn="返回"
      onConfirm={cancel}
      onClose={onClose}
    >
      <p>
        {booking.student?.name} {fmtDateTime(booking.startsAt)} {booking.lessonType.name}
      </p>
      <p className="muted">
        场馆取消时，已付的款项会全额退款，用课时包约的课会退回课时。前台收款的订单，请在退款页确认已当面退还。
      </p>
      <Textarea
        placeholder="取消原因（学员可见）"
        value={reason}
        maxlength={100}
        onChange={(v) => setReason(String(v))}
      />
    </Dialog>
  )
}
