import type { PriceTag } from '@rs/shared'
import { venueDateKey } from '@rs/shared'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Dialog, Input, InputNumber, MessagePlugin, Radio, Select } from 'tdesign-react'
import { api, RequestError } from './api'
import { NewStudentDialog } from './DeskStudent'
import { Field } from './Field'
import { fmtDate, fmtTime, fmtWeekday, toFen, toYuan, yuan } from './format'
import { attempt, useApi, useIdempotencyKey, useSubmitting } from './hooks'
import { type LessonPick, LessonTimePicker, pickBody } from './LessonTimePicker'
import { offlineMethodLabel } from './labels'
import { useCan } from './me'
import type { Coach, LessonType, Person, Slot } from './types'

interface Quote {
  price: PriceTag
  package: { id: number; name: string; lessonsRemaining: number; expiresAt: string } | null
  /** Why the student's package can't pay for this slot, when they have one. */
  packageNote: string | null
}

type Method = keyof typeof offlineMethodLabel

/** A student picker that searches by name or phone as the desk types. */
function StudentPicker({
  value,
  onChange,
}: {
  value: Person | null
  onChange: (p: Person | null) => void
}) {
  const [typed, setTyped] = useState('')
  const [q, setQ] = useState('')
  // Searches once typing pauses, not on every keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setQ(typed), 300)
    return () => clearTimeout(timer)
  }, [typed])
  const found = useApi<(Person & { deletedAt: string | null })[]>(
    `/admin/students?q=${encodeURIComponent(q)}`,
  )
  const [creating, setCreating] = useState(false)
  const canAdd = useCan('students')
  const label = (p: Person) => `${p.name || '未填写姓名'} ${p.phone} · 编号 ${p.id}`
  const options = [
    ...(value ? [value] : []),
    // A student who deleted their account cannot be booked for.
    ...(found.data ?? []).filter((p) => p.id !== value?.id && !p.deletedAt),
  ]
  return (
    <div className="picker-row">
      <Select
        filterable
        clearable
        placeholder="输入姓名或手机号搜索"
        loading={found.loading}
        value={value?.id}
        empty={found.error ?? (q ? '没有找到学员' : '还没有学员')}
        // The server filters; showing every result it sends keeps typed digits matching phones.
        filter={() => true}
        onSearch={(v) => setTyped(v.trim())}
        options={options.map((p) => ({ label: label(p), value: p.id }))}
        onChange={(v) => onChange(options.find((p) => p.id === Number(v)) ?? null)}
      />
      {canAdd && (
        <Button variant="outline" onClick={() => setCreating(true)}>
          前台建档
        </Button>
      )}
      {creating && (
        <NewStudentDialog
          initial={typed}
          onClose={() => setCreating(false)}
          onDone={(p) => {
            setCreating(false)
            onChange(p)
          }}
        />
      )}
    </div>
  )
}

/**
 * 代约: the front desk books a lesson for a student. Opened from a group session, from a time on
 * the 日程 board, from a student, or with nothing chosen yet. The booking is paid from the
 * student's package or recorded as paid at the desk.
 */
export function BookForStudent({
  session,
  at,
  date,
  student: givenStudent,
  onClose,
  onDone,
}: {
  /** A group session to book a seat in. */
  session?: Slot
  /** A coach and start time picked on the 日程 board, and whether it is outside their 排班. */
  at?: { coachId: number; startsAt: string; outside: boolean }
  /** The day to show times for first, such as the day on the 日程 board. */
  date?: string
  student?: Person
  onClose: () => void
  onDone: () => void
}) {
  const coaches = useApi<Coach[]>('/admin/coaches')
  const types = useApi<LessonType[]>('/admin/lesson-types')
  const [student, setStudent] = useState<Person | null>(givenStudent ?? null)
  const canAdd = useCan('students')
  const [lessonTypeId, setLessonTypeId] = useState<number | undefined>(
    session?.lessonTypeId ?? undefined,
  )
  const [pick, setPick] = useState<LessonPick | null>(
    session ? { kind: 'session', slot: session } : null,
  )
  const [quote, setQuote] = useState<Quote | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const [payWith, setPayWith] = useState<'package' | 'offline'>('offline')
  const [amount, setAmount] = useState<number | undefined>()
  // Only 管理员 may charge other than the listed price.
  const canPrice = useCan('manage')
  // Picked each time: a default would record cash taken as whatever it was.
  const [method, setMethod] = useState<Method | null>(null)
  const [methodMissing, setMethodMissing] = useState(false)
  const [note, setNote] = useState('')
  const submitting = useSubmitting()
  // A retry after a lost response gets the booking already made.
  const requestKey = useIdempotencyKey()

  const activeCoaches = (coaches.data ?? []).filter((c) => c.active)
  const atCoach = activeCoaches.find((c) => c.id === at?.coachId)
  // Lesson types the desk can book: those an active coach teaches, the board's coach's when a
  // time was picked there. Regular lessons first: the desk books those far more often than trials.
  const bookable = useMemo(() => {
    const taught = new Set((atCoach ? [atCoach] : activeCoaches).flatMap((c) => c.lessonTypeIds))
    return (types.data ?? [])
      .filter((t) => t.active && taught.has(t.id) && (!at || t.capacity === 1))
      .sort((a, b) => Number(a.isTrial) - Number(b.isTrial) || a.capacity - b.capacity)
  }, [types.data, activeCoaches, atCoach, at])
  const lessonType = session
    ? (types.data ?? []).find((t) => t.id === session.lessonTypeId)
    : bookable.find((t) => t.id === lessonTypeId)
  const teaching = activeCoaches.filter(
    (c) => lessonType && c.lessonTypeIds.includes(lessonType.id),
  )

  useEffect(() => {
    if (session || !types.data || !coaches.data) return
    if (!bookable.some((t) => t.id === lessonTypeId)) setLessonTypeId(bookable[0]?.id)
  }, [session, types.data, coaches.data, bookable, lessonTypeId])

  // A time from the board is picked once its lesson type is known, at that type's length.
  const placed = useRef(false)
  useEffect(() => {
    if (!at || placed.current || !lessonType) return
    placed.current = true
    setPick({
      kind: 'time',
      coachId: at.coachId,
      startsAt: at.startsAt,
      endsAt: new Date(Date.parse(at.startsAt) + lessonType.durationMinutes * 60_000).toISOString(),
      outside: at.outside,
    })
  }, [at, lessonType])

  // Asks the server what the booking would cost, and whether it is allowed at all; again after a
  // refused booking (`refresh`), as the price or the student's package may have changed.
  const seq = useRef(0)
  // The booking the last quote was for, so a fresh quote for the same one keeps a typed amount.
  const quoted = useRef<string | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh asks again for the same booking
  useEffect(() => {
    setQuote(null)
    setQuoteError(null)
    if (!student || !pick || !lessonTypeId) return
    const mine = ++seq.current
    const body = { studentId: student.id, lessonTypeId, ...pickBody(pick) }
    const same = quoted.current === JSON.stringify(body)
    api<Quote>('POST', '/admin/bookings/quote', body)
      .then((q) => {
        if (mine !== seq.current) return
        quoted.current = JSON.stringify(body)
        setQuote(q)
        setPayWith((was) => ((same && was === 'offline') || !q.package ? 'offline' : 'package'))
        // Only 管理员 types an amount; others always charge the price quoted.
        setAmount((was) => (same && canPrice && was !== undefined ? was : toYuan(q.price.price)))
      })
      .catch((e) => {
        if (mine === seq.current) {
          setQuoteError(e instanceof RequestError ? e.message : '操作失败，请重试')
        }
      })
  }, [student, pick, lessonTypeId, refresh])

  const fen = toFen(amount)
  const ready =
    quote !== null &&
    (payWith === 'package' ? quote.package !== null : fen !== null && fen <= 10_000_000)

  const submit = async () => {
    if (!ready || !student || !pick || !lessonTypeId) return
    if (payWith === 'offline' && fen !== 0 && !method) {
      setMethodMissing(true)
      // The field is below the times, out of sight on a phone.
      void MessagePlugin.warning('请选择收款方式')
      return
    }
    const target = { studentId: student.id, lessonTypeId, ...pickBody(pick) }
    const body =
      payWith === 'package'
        ? // The package shown: another one picked meanwhile is refused, not used unseen.
          { ...target, payWith, expectedPackageId: quote.package?.id }
        : { ...target, payWith, amount: fen, method: fen === 0 ? undefined : method, note }
    const booked = await attempt(
      () => api('POST', '/admin/bookings', body, { key: requestKey }),
      '已代约',
      // The time may have gone meanwhile, or the price or package changed: the list drops the
      // time and the quote is asked for again.
      { onRefused: () => setRefresh((n) => n + 1) },
    )
    if (booked) onDone()
  }

  return (
    <Dialog
      visible
      width={560}
      header="代约"
      confirmBtn={{ content: '确认代约', disabled: !ready, loading: submitting }}
      cancelBtn="返回"
      onConfirm={submit}
      onClose={onClose}
    >
      <div className="fields">
        <Field
          label="学员"
          help={
            givenStudent || !canAdd ? undefined : '找不到学员时可以前台建档，学员不必先打开小程序'
          }
        >
          {givenStudent ? (
            <span className="field-text">
              {givenStudent.name || '未填写姓名'} {givenStudent.phone}
            </span>
          ) : (
            <StudentPicker value={student} onChange={setStudent} />
          )}
        </Field>
        <Field label="课程">
          {coaches.error || types.error ? (
            <span className="field-text danger-text">{coaches.error ?? types.error}</span>
          ) : !coaches.data || !types.data ? (
            <span className="field-text muted">加载中</span>
          ) : session ? (
            <span className="field-text">{lessonType?.name}</span>
          ) : bookable.length === 0 ? (
            <span className="field-text muted">没有可预约的课程</span>
          ) : (
            <Select
              value={lessonTypeId}
              options={bookable.map((t) => ({
                label: `${t.isTrial && !t.name.includes('体验') ? `${t.name}（体验课）` : t.name}${t.capacity > 1 ? '（小班课）' : ''}`,
                value: t.id,
              }))}
              onChange={(v) => {
                setLessonTypeId(Number(v))
                // Another length or kind of lesson needs its own time.
                if (!at) setPick(null)
                else placed.current = false
              }}
            />
          )}
        </Field>
        <Field label="时间">
          {session ? (
            <span className="field-text">
              {fmtDate(session.startsAt).slice(5)} {fmtWeekday(session.startsAt)}{' '}
              {fmtTime(session.startsAt)}-{fmtTime(session.endsAt)}{' '}
              {activeCoaches.find((c) => c.id === session.coachId)?.name}
            </span>
          ) : lessonType ? (
            <LessonTimePicker
              key={lessonType.id}
              lessonType={lessonType}
              coaches={teaching}
              minutes={lessonType.durationMinutes}
              allowOutside
              initialCoachId={at?.coachId}
              initialDate={at ? venueDateKey(new Date(at.startsAt)) : date}
              snap={!!at && !at.outside}
              refresh={refresh}
              value={pick}
              onChange={setPick}
            />
          ) : (
            <span className="field-text muted">先选择课程</span>
          )}
        </Field>
        {quoteError && (
          <Field>
            <span className="field-text danger-text">{quoteError}</span>
          </Field>
        )}
        {quote && (
          <>
            <Field label="支付">
              <Radio.Group value={payWith} onChange={(v) => setPayWith(v as 'package' | 'offline')}>
                <Radio value="package" disabled={!quote.package}>
                  {quote.package
                    ? `课时包「${quote.package.name}」剩 ${quote.package.lessonsRemaining} 节`
                    : (quote.packageNote ?? '没有可用课时包')}
                </Radio>
                <Radio value="offline">线下收款（标价 {yuan(quote.price.price)}）</Radio>
              </Radio.Group>
            </Field>
            {payWith === 'offline' && (
              <>
                <Field
                  label="实收金额"
                  help={
                    canPrice && (fen === null || fen > 10_000_000)
                      ? '请填写 0 到 100000 元之间的金额'
                      : canPrice
                        ? '填 0 即为免费'
                        : '按标价收款，改价请联系管理员'
                  }
                >
                  <InputNumber
                    theme="normal"
                    status={canPrice && (fen === null || fen > 10_000_000) ? 'error' : 'default'}
                    value={amount}
                    disabled={!canPrice}
                    min={0}
                    max={100_000}
                    decimalPlaces={2}
                    suffix="元"
                    onChange={(v) => setAmount(v as number)}
                  />
                </Field>
                {fen !== 0 && (
                  <Field
                    label="收款方式"
                    help={methodMissing && !method ? '请选择收款方式' : undefined}
                  >
                    <Select
                      value={method ?? undefined}
                      placeholder="请选择"
                      status={methodMissing && !method ? 'error' : 'default'}
                      options={Object.entries(offlineMethodLabel).map(([value, label]) => ({
                        value,
                        label,
                      }))}
                      onChange={(v) => setMethod(v as Method)}
                    />
                  </Field>
                )}
                <Field label="备注">
                  <Input value={note} maxlength={100} onChange={(v) => setNote(String(v))} />
                </Field>
              </>
            )}
          </>
        )}
      </div>
    </Dialog>
  )
}
