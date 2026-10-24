import type { PriceTag } from '@rs/shared'
import { venueInstant } from '@rs/shared'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, DatePicker, Dialog, Input, InputNumber, Radio, Select } from 'tdesign-react'
import { api, RequestError } from './api'
import { Field } from './Field'
import { addDays, fmtDate, fmtTime, fmtWeekday, today, toFen, toYuan, yuan } from './format'
import { attempt, useApi, useIdempotencyKey, useSubmitting } from './hooks'
import { offlineMethodLabel } from './labels'
import type { Coach, LessonType, Person, Slot } from './types'

interface Quote {
  price: PriceTag
  package: { id: number; name: string; lessonsRemaining: number; expiresAt: string } | null
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
  const label = (p: Person) => `${p.name || '未填写姓名'} ${p.phone}`.trim()
  const options = [
    ...(value ? [value] : []),
    // A student who deleted their account cannot be booked for.
    ...(found.data ?? []).filter((p) => p.id !== value?.id && !p.deletedAt),
  ]
  return (
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
  )
}

function localDateKey(d: Date) {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Free, open slots of one coach on one venue date that have not started. */
function SlotPicker({
  coaches,
  value,
  onChange,
}: {
  coaches: Coach[]
  value: Slot | null
  onChange: (s: Slot | null) => void
}) {
  const [coachId, setCoachId] = useState<number | undefined>(coaches[0]?.id)
  const [date, setDate] = useState(today())
  useEffect(() => {
    if (coachId === undefined && coaches[0]) setCoachId(coaches[0].id)
  }, [coaches, coachId])
  const from = venueInstant(date, 0).toISOString()
  const to = venueInstant(addDays(date, 1), 0).toISOString()
  const slots = useApi<Slot[]>(
    coachId
      ? `/admin/slots?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&coachId=${coachId}`
      : null,
  )
  const free = (slots.data ?? []).filter(
    (s) =>
      s.open &&
      !s.cancelledAt &&
      s.bookings.length < s.capacity &&
      new Date(s.startsAt) > new Date(),
  )
  return (
    <div className="fields">
      <Select
        value={coachId}
        placeholder="选择教练"
        options={coaches.map((c) => ({ label: c.name, value: c.id }))}
        onChange={(v) => {
          setCoachId(Number(v))
          onChange(null)
        }}
      />
      <DatePicker
        value={date}
        clearable={false}
        // The picker hands over local calendar days; past venue dates have nothing to book.
        disableDate={(d) => localDateKey(d as Date) < today()}
        onChange={(v) => {
          setDate(String(v || today()))
          onChange(null)
        }}
      />
      {slots.error ? (
        <span className="muted">{slots.error}</span>
      ) : slots.loading ? (
        <span className="muted">加载中</span>
      ) : free.length === 0 ? (
        <span className="muted">这天没有可约时段</span>
      ) : (
        // A grid of times rather than a radio group, so it wraps evenly on a phone too.
        <div className="slot-picks">
          {free.map((s) => (
            <Button
              key={s.id}
              variant={s.id === value?.id ? 'base' : 'outline'}
              theme={s.id === value?.id ? 'primary' : 'default'}
              aria-pressed={s.id === value?.id}
              onClick={() => onChange(s)}
            >
              {fmtTime(s.startsAt)}-{fmtTime(s.endsAt)}
              {s.lessonTypeId !== null && ` 小班课 剩 ${s.capacity - s.bookings.length} 位`}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * 代约: the front desk books a lesson for a student. Opened from a free slot, from a student,
 * or with nothing chosen yet. The booking is paid from the student's package or recorded as
 * paid at the desk.
 */
export function BookForStudent({
  slot: givenSlot,
  student: givenStudent,
  onClose,
  onDone,
}: {
  slot?: Slot
  student?: Person
  onClose: () => void
  onDone: () => void
}) {
  const coaches = useApi<Coach[]>('/admin/coaches')
  const types = useApi<LessonType[]>('/admin/lesson-types')
  const [student, setStudent] = useState<Person | null>(givenStudent ?? null)
  const [slot, setSlot] = useState<Slot | null>(givenSlot ?? null)
  const [lessonTypeId, setLessonTypeId] = useState<number | undefined>()
  const [quote, setQuote] = useState<Quote | null>(null)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const [payWith, setPayWith] = useState<'package' | 'offline'>('offline')
  const [amount, setAmount] = useState<number | undefined>()
  const [method, setMethod] = useState<Method>('alipay')
  const [note, setNote] = useState('')
  const submitting = useSubmitting()
  // A retry after a lost response gets the booking already made.
  const requestKey = useIdempotencyKey()

  const activeCoaches = (coaches.data ?? []).filter((c) => c.active)
  const coach = (coaches.data ?? []).find((c) => c.id === slot?.coachId)
  // Lesson types this coach teaches that fit the slot's length.
  const fitting = useMemo(() => {
    if (!slot || !coach) return []
    const minutes = (Date.parse(slot.endsAt) - Date.parse(slot.startsAt)) / 60_000
    const taught = new Set(coach.lessonTypeIds)
    // A group session teaches its own class; a private slot takes private lessons.
    const fits = (t: LessonType) =>
      slot.lessonTypeId !== null ? t.id === slot.lessonTypeId : t.capacity === 1
    // Regular lessons first: the desk books those far more often than trials.
    return (types.data ?? [])
      .filter((t) => t.active && taught.has(t.id) && t.durationMinutes === minutes && fits(t))
      .sort((a, b) => Number(a.isTrial) - Number(b.isTrial))
  }, [slot, coach, types.data])

  useEffect(() => {
    if (!fitting.some((t) => t.id === lessonTypeId)) setLessonTypeId(fitting[0]?.id)
  }, [fitting, lessonTypeId])

  // Asks the server what the booking would cost, and whether it is allowed at all.
  const seq = useRef(0)
  useEffect(() => {
    setQuote(null)
    setQuoteError(null)
    if (!student || !slot || !lessonTypeId) return
    const mine = ++seq.current
    api<Quote>('POST', '/admin/bookings/quote', {
      studentId: student.id,
      slotId: slot.id,
      lessonTypeId,
    })
      .then((q) => {
        if (mine !== seq.current) return
        setQuote(q)
        setPayWith(q.package ? 'package' : 'offline')
        setAmount(toYuan(q.price.price))
      })
      .catch((e) => {
        if (mine === seq.current) {
          setQuoteError(e instanceof RequestError ? e.message : '操作失败，请重试')
        }
      })
  }, [student, slot, lessonTypeId])

  const fen = toFen(amount)
  const ready =
    quote !== null &&
    (payWith === 'package' ? quote.package !== null : fen !== null && fen <= 10_000_000)

  const submit = async () => {
    if (!ready || !student || !slot || !lessonTypeId) return
    const target = { studentId: student.id, slotId: slot.id, lessonTypeId }
    const body =
      payWith === 'package'
        ? { ...target, payWith }
        : { ...target, payWith, amount: fen, method, note }
    const booked = await attempt(
      () => api('POST', '/admin/bookings', body, { key: requestKey }),
      '已代约',
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
        <Field label="学员" help="学员需先打开过小程序">
          {givenStudent ? (
            <span className="field-text">
              {givenStudent.name || '未填写姓名'} {givenStudent.phone}
            </span>
          ) : (
            <StudentPicker value={student} onChange={setStudent} />
          )}
        </Field>
        <Field label="时段">
          {givenSlot ? (
            <span className="field-text">
              {fmtDate(givenSlot.startsAt).slice(5)} {fmtWeekday(givenSlot.startsAt)}{' '}
              {fmtTime(givenSlot.startsAt)}-{fmtTime(givenSlot.endsAt)} {coach?.name}
            </span>
          ) : (
            <SlotPicker coaches={activeCoaches} value={slot} onChange={setSlot} />
          )}
        </Field>
        {slot && (
          <Field label="课程">
            {coaches.error || types.error ? (
              <span className="field-text danger-text">{coaches.error ?? types.error}</span>
            ) : !coaches.data || !types.data ? (
              <span className="field-text muted">加载中</span>
            ) : fitting.length === 0 ? (
              <span className="field-text muted">该教练没有与时段时长一致的课程</span>
            ) : (
              <Select
                value={lessonTypeId}
                options={fitting.map((t) => ({
                  label: t.isTrial && !t.name.includes('体验') ? `${t.name}（体验课）` : t.name,
                  value: t.id,
                }))}
                onChange={(v) => setLessonTypeId(Number(v))}
              />
            )}
          </Field>
        )}
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
                    : '没有可用课时包'}
                </Radio>
                <Radio value="offline">线下收款（标价 {yuan(quote.price.price)}）</Radio>
              </Radio.Group>
            </Field>
            {payWith === 'offline' && (
              <>
                <Field label="实收金额" help="填 0 为免费">
                  <InputNumber
                    theme="normal"
                    value={amount}
                    min={0}
                    max={100_000}
                    decimalPlaces={2}
                    suffix="元"
                    onChange={(v) => setAmount(v as number)}
                  />
                </Field>
                {fen !== 0 && (
                  <Field label="收款方式">
                    <Select
                      value={method}
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
