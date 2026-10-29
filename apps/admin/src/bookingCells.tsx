import { cancelSource, DISRUPTION_TEXT, type Disruption } from '@rs/shared'
import type { MouseEvent } from 'react'
import { useState } from 'react'
import { Dialog, DialogPlugin, Select, Tag, Textarea } from 'tdesign-react'
import { api } from './api'
import { fmtDateTime, yuan } from './format'
import { attempt, onceKey, useSubmitting } from './hooks'
import { bookingStatusLabel, disruptionLabel, refundLabel } from './labels'
import { openLesson } from './lessonLink'
import { useCan } from './me'
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

/** Who cancelled it: 场馆取消, 学员逾时取消, or 教练取消 with the coach's reason. */
function cancelText(row: AdminBooking) {
  const { by, reason } = cancelSource(row)
  if (by === 'coach') return reason ? `教练取消：${reason}` : '教练取消'
  if (by === 'venue') return '场馆取消'
  return row.late ? '学员逾时取消' : '学员取消'
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
          <span className="muted nowrap">{cancelText(row)}</span>
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

/** Why the venue could not give a lesson as booked, as a warning tag. */
export function DisruptionTag({ disruption }: { disruption: Disruption }) {
  return (
    <Tag theme="warning" variant="light" title={DISRUPTION_TEXT[disruption]}>
      {disruptionLabel[disruption]}
    </Tag>
  )
}

/**
 * Asks before 签到 on a lesson the venue could not give, which the student may have been told
 * not to come to. Resolves true to go ahead.
 */
export function confirmDisruptedArrival(disruption: Disruption): Promise<boolean> {
  return new Promise((resolve) => {
    const answer = (yes: boolean) => {
      dialog.destroy()
      resolve(yes)
    }
    const dialog = DialogPlugin.confirm({
      header: `${DISRUPTION_TEXT[disruption]}，仍要签到？`,
      body: '学员可能已被告知这节课上不了。如果课程照常进行，请签到。',
      theme: 'warning',
      confirmBtn: '仍要签到',
      cancelBtn: '返回',
      onConfirm: () => answer(true),
      onClose: () => answer(false),
    })
  })
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
  // What stood in the way of the lesson, asked about before 到课.
  const disruption = row.lessonDisruption
  const started = Date.parse(row.startsAt) <= Date.now()
  const markable = started && (row.status === 'confirmed' || row.status === 'completed')
  const mark = async (attendance: string | null) => {
    if (attendance === 'attended' && disruption && !(await confirmDisruptedArrival(disruption))) {
      return
    }
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
  // The 退款 page, where a desk payment handed back is recorded, is for 财务 only.
  const canRefund = useCan('finance')
  const cancel = async () => {
    if (!reason.trim()) return
    if (
      await attempt(
        () =>
          api(
            'POST',
            `/admin/bookings/${booking.id}/cancel`,
            { reason },
            { key: onceKey(`cancel-booking-${booking.id}`) },
          ),
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
        场馆取消时，已付的款项会全额退款，用课时包约的课会退回课时。
        {canRefund
          ? '前台收款的订单，当面退还后请在退款页点“已退还”。'
          : '前台收款的订单，请当面把款项退还学员，并告知财务在退款页登记。'}
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
