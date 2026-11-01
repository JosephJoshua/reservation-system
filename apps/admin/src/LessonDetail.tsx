import { type BookingStatus, staffActionLabels } from '@rs/shared'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Card, Dialog, Drawer, Loading, Space, Tag, Textarea } from 'tdesign-react'
import { api, RequestError } from './api'
import { BookForStudent } from './BookForStudent'
import {
  AttendanceCell,
  CancelBookingDialog,
  DisruptionTag,
  PaidCell,
  StatusCell,
} from './bookingCells'
import { DataTable } from './DataTable'
import { actorName, fmtDate, fmtDateTime, fmtTime, fmtWeekday } from './format'
import {
  attempt,
  hashParam,
  overlayShown,
  useApi,
  useIdempotencyKey,
  useIsPhone,
  useNow,
  useSubmitting,
} from './hooks'
import {
  bookingStatusLabel,
  callOffEffect,
  cancelConfirmLabel,
  sessionCancelDoneMessage,
} from './labels'
import { closeLesson, lessonChanged, showLesson } from './lessonLink'
import { MoveDialog } from './MoveDialog'
import { useCan } from './me'
import { Feedback } from './pages/Feedback'
import { SHOW_SECTION } from './SectionNav'
import type { ActionLogEntry, AdminBooking, LessonSlot, Slot } from './types'

// The API's page of 操作记录.
const LOG_PAGE = 50

const LIVE = new Set(['pending_payment', 'confirmed', 'completed'])

/** The lesson, its seats and what can be done to it, loaded together. */
function useLesson(id: number) {
  const slot = useApi<LessonSlot>(`/admin/slots/${id}`)
  const seats = useApi<AdminBooking[]>(`/admin/bookings?slotId=${id}&limit=100`)
  // Goes up after a change, so 记录 loads again.
  const [version, setVersion] = useState(0)
  const reload = async () => {
    await Promise.all([slot.reload(), seats.reload()])
    setVersion((v) => v + 1)
    lessonChanged()
  }
  return { slot, seats, version, reload }
}

type Lesson = ReturnType<typeof useLesson>

/** A moment as 10月28日 周三 10:00. */
const moment = (iso: string) => {
  const [, month, date] = fmtDate(iso).split('-')
  return `${Number(month)}月${Number(date)}日 ${fmtWeekday(iso)} ${fmtTime(iso)}`
}

const when = (s: { startsAt: string; endsAt: string }) =>
  `${moment(s.startsAt)}-${fmtTime(s.endsAt)}`

/**
 * 课程详情: one lesson with its students, 课后点评 and what staff did to it. A group session or a
 * private lesson; shown over a list or as a page of its own.
 */
function LessonBody({
  lesson,
  page,
  onMoved,
}: {
  lesson: Lesson
  page: boolean
  /** Shows the lesson where a private lesson was moved to, if this one is still shown. */
  onMoved: (to: number, from: number) => void
}) {
  const { slot, seats, version, reload } = lesson
  const canBook = useCan('bookings')
  const canMark = useCan('attendance')
  const canManage = useCan('manage')
  const [moving, setMoving] = useState<AdminBooking | null>(null)
  const [cancelling, setCancelling] = useState<AdminBooking | null>(null)
  const [callingOff, setCallingOff] = useState(false)
  const [adding, setAdding] = useState(false)
  // So 改约 and 加人 go at the start, and 取消 at the end, with the drawer left open.
  const now = useNow(10_000)

  const s = slot.data
  const rows = seats.data
  if (!s || !rows) {
    const error = slot.error ?? seats.error
    return error ? <p className="muted">{error}</p> : <Loading size="small" />
  }

  const group = s.lessonTypeId !== null
  const live = rows.filter((b) => LIVE.has(b.status))
  // A private lesson is its one booking, the live one if it was booked again after a cancel.
  const main = group ? null : (live[0] ?? rows[0] ?? null)
  const lessonName = s.lessonType?.name ?? main?.lessonType.name ?? '私教课'
  const started = Date.parse(s.startsAt) <= now
  const ended = Date.parse(s.endsAt) <= now
  const cancelled = s.cancelledAt !== null
  const full = live.length >= s.capacity || (!live.length && s.tableFull)
  const status = main ? bookingStatusLabel[main.status] : null

  const actions = canBook && (
    <Space size={8} breakLine>
      {main && main.status === 'confirmed' && !started && (
        <Button variant="outline" onClick={() => setMoving(main)}>
          改约
        </Button>
      )}
      {main && (main.status === 'confirmed' || main.status === 'pending_payment') && !ended && (
        <Button theme="danger" variant="outline" onClick={() => setCancelling(main)}>
          取消
        </Button>
      )}
      {group && !cancelled && !started && s.open && !full && (
        <Button onClick={() => setAdding(true)}>代约加人</Button>
      )}
      {group && !cancelled && !ended && (
        <Button theme="danger" variant="outline" onClick={() => setCallingOff(true)}>
          取消整节
        </Button>
      )}
    </Space>
  )

  const session: Slot = {
    ...s,
    booking: null,
    bookings: live.map((b) => ({
      id: b.id,
      status: b.status,
      lessonTypeId: b.lessonType.id,
      attendance: b.attendance,
      student: b.student,
    })),
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div className="detail-head">
        <div>
          {page && <h2 className="detail-title">{when(s)}</h2>}
          <div className="lesson-facts">
            <span>{s.coach.name}</span>
            <span>{lessonName}</span>
            {group ? (
              cancelled ? (
                <Tag theme="danger" variant="light">
                  已取消：{s.cancelReason}
                </Tag>
              ) : (
                <span>
                  已报名 {live.length}/{s.capacity} 人
                  {!s.open && <span className="muted">，已停止报名</span>}
                </span>
              )
            ) : (
              status && (
                <Tag theme={status[1]} variant="light">
                  {status[0]}
                </Tag>
              )
            )}
            {s.disruption && !cancelled && live.length > 0 && (
              <DisruptionTag disruption={s.disruption} />
            )}
          </div>
        </div>
        {actions}
      </div>

      <Card title="学员" bordered>
        <DataTable
          rowKey="id"
          data={rows}
          empty={
            group ? (
              '还没有学员报名'
            ) : s.movedTo ? (
              <span>
                这节课已改约到{' '}
                <a
                  href={`#/lessons/${s.movedTo.slotId}`}
                  data-overlay
                  onClick={(e) => {
                    e.preventDefault()
                    if (s.movedTo) onMoved(s.movedTo.slotId, s.id)
                  }}
                >
                  {moment(s.movedTo.startsAt)}
                </a>
              </span>
            ) : (
              '没有预约'
            )
          }
          columns={[
            {
              colKey: 'student',
              title: '学员',
              cell: ({ row }) =>
                row.student ? (
                  <div className="student-cell">
                    <a href={`#/students/${row.student.id}`} title={row.student.name}>
                      {row.student.name || '未填写'}
                    </a>
                    {row.student.phone && <div className="muted nowrap">{row.student.phone}</div>}
                  </div>
                ) : (
                  <span className="muted">-</span>
                ),
            },
            { colKey: 'paid', title: '支付', cell: ({ row }) => <PaidCell row={row} /> },
            { colKey: 'status', title: '状态', cell: ({ row }) => <StatusCell row={row} /> },
            {
              colKey: 'attendance',
              title: '签到',
              cell: ({ row }) => <AttendanceCell row={row} canMark={canMark} onChanged={reload} />,
            },
            ...(group && canBook
              ? [
                  {
                    colKey: 'op',
                    title: '操作',
                    width: 120,
                    cell: ({ row }: { row: AdminBooking }) => (
                      <Space size={0}>
                        {row.status === 'confirmed' && !started && (
                          <Button variant="text" theme="primary" onClick={() => setMoving(row)}>
                            改约
                          </Button>
                        )}
                        {(row.status === 'confirmed' || row.status === 'pending_payment') &&
                          !ended && (
                            <Button
                              variant="text"
                              theme="danger"
                              onClick={() => setCancelling(row)}
                            >
                              取消
                            </Button>
                          )}
                      </Space>
                    ),
                  },
                ]
              : []),
          ]}
        />
      </Card>

      {canBook && (
        <Card title="课后点评" bordered>
          <Feedback slotId={s.id} onChanged={reload} />
        </Card>
      )}

      {canManage && (
        <Card title="记录" bordered>
          <LessonLog slotId={s.id} version={version} />
        </Card>
      )}

      {moving && (
        <MoveDialog
          booking={moving}
          onClose={() => setMoving(null)}
          onDone={async () => {
            const moved = moving
            setMoving(null)
            await reload()
            // A private lesson goes with its booking to the new time.
            if (!group) {
              const [b] = await api<AdminBooking[]>('GET', `/admin/bookings?id=${moved.id}`)
              if (b && b.slotId !== s.id) onMoved(b.slotId, s.id)
            }
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
      {callingOff && (
        <CallOffDialog
          slot={s}
          statuses={live.map((b) => b.status)}
          onClose={() => setCallingOff(false)}
          onDone={reload}
        />
      )}
      {adding && (
        <BookForStudent
          session={session}
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false)
            void reload()
          }}
        />
      )}
    </Space>
  )
}

/**
 * 取消整节: every student who paid is refunded or gets the lesson back on their package, and a
 * hold still to pay is closed.
 */
function CallOffDialog({
  slot,
  statuses,
  onClose,
  onDone,
}: {
  slot: LessonSlot
  /** The live bookings' statuses. */
  statuses: BookingStatus[]
  onClose: () => void
  onDone: () => unknown
}) {
  const [reason, setReason] = useState('')
  const submitting = useSubmitting()
  const key = useIdempotencyKey()
  // Held from the click until the dialog closes, so a second click cannot cancel again.
  const sent = useRef(false)
  const cancel = async () => {
    if (!reason.trim() || sent.current) return
    sent.current = true
    const ok = await attempt(
      () => api('POST', `/admin/slots/${slot.id}/cancel`, { reason }, { key }),
      sessionCancelDoneMessage,
      {
        onStale: () => {
          onClose()
          void onDone()
        },
      },
    )
    if (ok) {
      onClose()
      await onDone()
    } else sent.current = false
  }
  return (
    <Dialog
      visible
      header="取消整节课"
      confirmBtn={{
        content: cancelConfirmLabel(statuses),
        theme: 'danger',
        disabled: !reason.trim(),
        loading: submitting,
      }}
      cancelBtn="返回"
      onConfirm={cancel}
      onClose={onClose}
    >
      <p>{statuses.length ? `取消后，${callOffEffect(statuses)}。` : '还没有学员报名。'}</p>
      <Textarea
        placeholder="取消原因（学员可见）"
        value={reason}
        maxlength={100}
        onChange={(v) => setReason(String(v))}
      />
    </Dialog>
  )
}

/** What staff did to the lesson and its bookings, newest first. */
function LessonLog({ slotId, version }: { slotId: number; version: number }) {
  const [rows, setRows] = useState<ActionLogEntry[] | null>(null)
  const [more, setMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)
  const load = useCallback(
    async (before?: number) => {
      const mine = ++seq.current
      setLoading(true)
      try {
        const page = await api<ActionLogEntry[]>(
          'GET',
          `/admin/actions?slotId=${slotId}${before ? `&before=${before}` : ''}`,
        )
        if (mine !== seq.current) return
        setRows((old) => (before ? [...(old ?? []), ...page] : page))
        setMore(page.length === LOG_PAGE)
        setError(null)
      } catch (e) {
        if (mine === seq.current) setError(e instanceof RequestError ? e.message : '加载失败')
      } finally {
        if (mine === seq.current) setLoading(false)
      }
    },
    [slotId],
  )
  // From the newest again after each change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: version says the lesson changed
  useEffect(() => {
    void load()
  }, [load, version])
  return (
    <>
      <DataTable
        rowKey="id"
        loading={!rows && !error}
        data={rows ?? []}
        empty={error ?? '还没有记录'}
        columns={[
          {
            colKey: 'createdAt',
            title: '时间',
            width: 120,
            cell: ({ row }) => <span className="nowrap">{fmtDateTime(row.createdAt)}</span>,
          },
          {
            colKey: 'staff',
            title: '操作人',
            width: 130,
            cell: ({ row }) => <span className="nowrap">{actorName(row)}</span>,
          },
          {
            colKey: 'action',
            title: '操作',
            width: 110,
            cell: ({ row }) => (
              <Tag variant="light" className="nowrap">
                {staffActionLabels[row.action] ?? row.action}
              </Tag>
            ),
          },
          { colKey: 'summary', title: '内容', cell: ({ row }) => row.summary },
        ]}
      />
      {more && !loading && (
        <div className="load-more">
          <Button variant="outline" loading={loading} onClick={() => load(rows?.at(-1)?.id)}>
            加载更多
          </Button>
        </div>
      )}
    </>
  )
}

/** 课程详情 over the page shown, from `?lesson=` in the address. */
export function LessonDrawer({ id }: { id: number }) {
  const lesson = useLesson(id)
  const phone = useIsPhone()
  // Opened after mounting rather than mounted open, so the drawer takes focus and Esc closes it.
  const [shown, setShown] = useState(false)
  useEffect(() => setShown(true), [])
  // Esc closes it even after a dialog over it took the focus away, but not while one is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !overlayShown('.t-drawer')) closeLesson()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  const s = lesson.slot.data
  return (
    <Drawer
      visible={shown}
      size={phone ? '100%' : '800px'}
      header={
        <div className="drawer-head">
          <span>{s ? when(s) : '课程详情'}</span>
          <Button size="small" variant="outline" href={`#/lessons/${id}`}>
            打开整页
          </Button>
        </div>
      }
      footer={false}
      // Esc is handled below, which leaves it to a dropdown or dialog that is open.
      closeOnEscKeydown={false}
      onClose={closeLesson}
    >
      <LessonBody lesson={lesson} page={false} onMoved={showLesson} />
    </Drawer>
  )
}

function slotFromHash() {
  const [page, part] = window.location.hash.split('?')[0]?.split('/').slice(1) ?? []
  if (page !== 'lessons') return null
  const id = Number(part)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

/**
 * 课程详情 as a page, at `#/lessons/12`. `#/lessons?booking=5` opens the lesson a booking is in
 * now, for the 操作记录, which names bookings.
 */
export function LessonPage() {
  const [id, setId] = useState(slotFromHash)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const on = () => setId(slotFromHash())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  // A booking resolves to its lesson, in place of the address, so back skips it.
  const booking = id ? null : Number(hashParam('booking'))
  useEffect(() => {
    if (!booking) return
    let live = true
    api<AdminBooking[]>('GET', `/admin/bookings?id=${booking}`)
      .then(([b]) => {
        if (!live) return
        if (!b) return setError('没有找到这个预约')
        history.replaceState(history.state, '', `#/lessons/${b.slotId}`)
        window.dispatchEvent(new Event(SHOW_SECTION))
        setId(b.slotId)
      })
      .catch(() => live && setError('加载失败'))
    return () => {
      live = false
    }
  }, [booking])
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [])

  return (
    <div className="detail-page">
      <nav className="breadcrumb" aria-label="位置">
        <a href="#/bookings">预约</a>
        <span aria-hidden="true">/</span>
        <span aria-current="page">课程详情</span>
      </nav>
      {id ? (
        <LessonPageBody
          key={id}
          id={id}
          onMoved={(slotId, from) => {
            if (slotFromHash() !== from) return
            history.replaceState(history.state, '', `#/lessons/${slotId}`)
            window.dispatchEvent(new Event(SHOW_SECTION))
            setId(slotId)
          }}
        />
      ) : error || !booking ? (
        <p className="muted">{error ?? '没有找到这节课'}</p>
      ) : (
        <Loading size="small" />
      )}
    </div>
  )
}

function LessonPageBody({
  id,
  onMoved,
}: {
  id: number
  onMoved: (to: number, from: number) => void
}) {
  const lesson = useLesson(id)
  return <LessonBody lesson={lesson} page onMoved={onMoved} />
}
