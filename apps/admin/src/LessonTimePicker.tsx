import type { OpenTimeDto } from '@rs/shared'
import { venueInstant } from '@rs/shared'
import { useEffect, useRef, useState } from 'react'
import { Alert, Button, DatePicker, Select, TimePicker } from 'tdesign-react'
import { fmtTime, today, venueIso } from './format'
import { useApi } from './hooks'
import type { Coach, LessonType, Slot } from './types'

/** Where a lesson goes: a group session, or a coach and start time for a private lesson. */
export type LessonPick =
  | { kind: 'session'; slot: Slot }
  | {
      kind: 'time'
      coachId: number
      startsAt: string
      endsAt: string
      /** Outside the coach's 排班, which the desk agreed with the coach. */
      outside: boolean
    }

/** The request fields for a pick, as 代约 and 改约 send them. */
export function pickBody(p: LessonPick) {
  return p.kind === 'session'
    ? { slotId: p.slot.id }
    : { coachId: p.coachId, startsAt: p.startsAt, anyTime: p.outside }
}

const sameTime = (a: LessonPick | null, coachId: number, startsAt: string) =>
  a?.kind === 'time' && a.coachId === coachId && Date.parse(a.startsAt) === Date.parse(startsAt)

/** A pick's venue date. */
export function pickDate(p: LessonPick) {
  return new Date(p.kind === 'session' ? p.slot.startsAt : p.startsAt)
}

/**
 * Picks a time for a lesson of one type: the open start times in the coaches' 排班 for a private
 * lesson, or the sessions with seats left for a group class. With `allowOutside` the desk may
 * also type a time outside 排班 for one coach. `moving` is a lesson being moved, whose own time
 * and table count as free and whose length is kept.
 */
export function LessonTimePicker({
  lessonType,
  coaches,
  minutes,
  moving,
  allowOutside,
  initialCoachId,
  initialDate,
  snap = false,
  refresh,
  value,
  onChange,
}: {
  lessonType: LessonType
  /** Active coaches who teach the lesson type. */
  coaches: Coach[]
  minutes: number
  moving?: { id: number; coachId: number; startsAt: string }
  allowOutside: boolean
  initialCoachId?: number
  initialDate?: string
  /** The value was handed in, as a time clicked on the 日程 board, and may not be open as is. */
  snap?: boolean
  /** Changed to load the open times again. */
  refresh?: number
  value: LessonPick | null
  onChange: (p: LessonPick | null) => void
}) {
  const group = lessonType.capacity > 1
  // 0 is every coach, for a private lesson the desk can give to whoever is free.
  const [coachId, setCoachId] = useState<number>(
    initialCoachId ?? (coaches.length === 1 ? (coaches[0]?.id ?? 0) : 0),
  )
  const [date, setDate] = useState(initialDate && initialDate >= today() ? initialDate : today())
  const [outside, setOutside] = useState(value?.kind === 'time' && value.outside)
  const coach = coaches.find((c) => c.id === coachId)
  // A coach who stopped teaching it is dropped back to every coach.
  useEffect(() => {
    if (coachId && !coaches.some((c) => c.id === coachId)) setCoachId(0)
  }, [coaches, coachId])

  const timesPath = group
    ? null
    : `/admin/open-times?${new URLSearchParams({
        date,
        ...(moving ? { moving: String(moving.id) } : { lessonTypeId: String(lessonType.id) }),
        ...(coachId ? { coachId: String(coachId) } : {}),
      })}`
  const times = useApi<OpenTimeDto[]>(timesPath)
  const sessionsPath = group
    ? `/admin/slots?${new URLSearchParams({
        from: venueInstant(date, 0).toISOString(),
        to: venueInstant(date, 24 * 60).toISOString(),
        ...(coachId ? { coachId: String(coachId) } : {}),
        ...(moving ? { moving: String(moving.id) } : {}),
      })}`
    : null
  const sessions = useApi<Slot[]>(sessionsPath)
  const names = new Map(coaches.map((c) => [c.id, c.name]))
  const now = Date.now()

  // Kept to the shown day and coach, since a slow load keeps the last list a moment.
  const offered = (times.data ?? []).filter(
    (t) =>
      names.has(t.coachId) &&
      (!coachId || t.coachId === coachId) &&
      Date.parse(t.startsAt) > now &&
      !(moving && t.coachId === moving.coachId && t.startsAt === moving.startsAt) &&
      new Date(t.startsAt) >= venueInstant(date, 0) &&
      new Date(t.startsAt) < venueInstant(date, 24 * 60),
  )
  const open = (sessions.data ?? []).filter(
    (s) =>
      s.lessonTypeId === lessonType.id &&
      names.has(s.coachId) &&
      (!coachId || s.coachId === coachId) &&
      s.open &&
      !s.cancelledAt &&
      s.bookings.length < s.capacity &&
      // An empty session holds no table yet, so it needs one free.
      !(s.tableFull && !s.bookings.length) &&
      !(moving && s.bookings.some((b) => b.id === moving.id)) &&
      Date.parse(s.startsAt) > now &&
      Date.parse(s.endsAt) - Date.parse(s.startsAt) === minutes * 60_000,
  )

  // A time handed in with `snap`, from the 日程 board, that 排班 does not offer as it stands (off
  // the grid, or running into another lesson) settles once on the open start time that covers
  // it, or else becomes an outside time. A picked time gone after a reload is dropped.
  const snapping = useRef(snap)
  const loaded = times.data !== null && !times.loading
  useEffect(() => {
    if (!loaded || !value || value.kind !== 'time' || value.outside) return
    const first = snapping.current
    snapping.current = false
    const match = offered.find((t) => sameTime(value, t.coachId, t.startsAt))
    // No table is free then: nothing to book, in 排班 or outside it.
    if (match?.tableFull) onChange(null)
    if (match) return
    if (!first) {
      onChange(null)
      return
    }
    const at = Date.parse(value.startsAt)
    const covering = offered.findLast(
      (t) =>
        t.coachId === value.coachId &&
        !t.tableFull &&
        Date.parse(t.startsAt) <= at &&
        at < Date.parse(t.endsAt),
    )
    if (covering) {
      onChange({
        kind: 'time',
        coachId: covering.coachId,
        startsAt: covering.startsAt,
        endsAt: covering.endsAt,
        outside: false,
      })
    } else onChange(allowOutside ? { ...value, outside: true } : null)
  })

  // Asked again after a refused booking, so a time taken meanwhile goes from the list.
  const refreshed = useRef(refresh)
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloads only when `refresh` changes
  useEffect(() => {
    if (refresh === refreshed.current) return
    refreshed.current = refresh
    void times.reload()
    void sessions.reload()
  }, [refresh])

  // An outside time handed in or settled on opens the outside time field, which stays open when
  // the coach or date changes.
  const outsideValue = value?.kind === 'time' && value.outside
  useEffect(() => {
    if (outsideValue) setOutside(true)
  }, [outsideValue])
  const showOutside = outside || outsideValue
  const outsideTime = value?.kind === 'time' && value.outside ? fmtTime(value.startsAt) : undefined
  const pickOutside = (hhmm: string) => {
    if (!coachId || !/^\d{2}:\d{2}$/.test(hhmm)) return
    const startsAt = venueIso(date, hhmm)
    onChange({
      kind: 'time',
      coachId,
      startsAt,
      endsAt: new Date(Date.parse(startsAt) + minutes * 60_000).toISOString(),
      outside: true,
    })
  }

  const loading = group ? sessions.loading : times.loading
  const error = group ? sessions.error : times.error
  const list = group ? open.length : offered.length

  return (
    <div className="fields">
      <Select
        value={coachId}
        options={[
          ...(group || coaches.length > 1 ? [{ label: '全部教练', value: 0 }] : []),
          ...coaches.map((c) => ({ label: c.name, value: c.id })),
        ]}
        onChange={(v) => {
          setCoachId(Number(v))
          onChange(null)
        }}
      />
      <DatePicker
        value={date}
        clearable={false}
        disableDate={{ before: today() }}
        onChange={(v) => {
          const picked = String(v ?? '')
          if (!/^\d{4}-\d{2}-\d{2}$/.test(picked)) return
          setDate(picked)
          onChange(null)
        }}
      />
      {showOutside && !group ? (
        <>
          <Alert
            theme="warning"
            message="排班外的时间请先和教练确认。教练已有课、请假或闭馆时不能预约。"
          />
          {coach ? (
            <TimePicker
              format="HH:mm"
              allowInput
              steps={[1, 5]}
              placeholder="开始时间"
              value={outsideTime}
              onChange={(v) => pickOutside(String(v ?? ''))}
            />
          ) : (
            <span className="muted">先选择教练</span>
          )}
          <div>
            <Button
              variant="text"
              theme="primary"
              onClick={() => {
                setOutside(false)
                onChange(null)
              }}
            >
              改选排班内的时间
            </Button>
          </div>
        </>
      ) : (
        <>
          {error ? (
            <span className="danger-text">{error}</span>
          ) : loading && !list ? (
            <span className="muted">加载中</span>
          ) : !list ? (
            <span className="muted">
              {group ? '这天没有可报名的小班课' : '这天排班里没有空闲时间'}
            </span>
          ) : (
            // A grid of times rather than a radio group, so it wraps evenly on a phone too.
            <div className="slot-picks">
              {group
                ? open.map((s) => {
                    const on = value?.kind === 'session' && value.slot.id === s.id
                    return (
                      <Button
                        key={s.id}
                        variant={on ? 'base' : 'outline'}
                        theme={on ? 'primary' : 'default'}
                        aria-pressed={on}
                        onClick={() => onChange({ kind: 'session', slot: s })}
                      >
                        {fmtTime(s.startsAt)}
                        {!coachId && ` ${names.get(s.coachId)}`} 剩 {s.capacity - s.bookings.length}{' '}
                        位
                      </Button>
                    )
                  })
                : offered.map((t) => {
                    const on = sameTime(value, t.coachId, t.startsAt)
                    return (
                      <Button
                        key={`${t.coachId}@${t.startsAt}`}
                        variant={on ? 'base' : 'outline'}
                        theme={on ? 'primary' : 'default'}
                        aria-pressed={on}
                        disabled={t.tableFull}
                        title={t.tableFull ? '球台已满' : undefined}
                        onClick={() =>
                          onChange({
                            kind: 'time',
                            coachId: t.coachId,
                            startsAt: t.startsAt,
                            endsAt: t.endsAt,
                            outside: false,
                          })
                        }
                      >
                        {fmtTime(t.startsAt)}
                        {!coachId && ` ${names.get(t.coachId)}`}
                        {t.tableFull && ' 球台已满'}
                      </Button>
                    )
                  })}
            </div>
          )}
          {allowOutside && !group && (
            <div>
              <Button
                variant="text"
                theme="primary"
                onClick={() => {
                  setOutside(true)
                  onChange(null)
                }}
              >
                排班外的时间
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
