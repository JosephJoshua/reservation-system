import { useEffect, useRef, useState } from 'react'
import { Button, Dialog, Input, Loading, Space } from 'tdesign-react'
import { api, RequestError } from './api'
import { Field } from './Field'
import { fmtDateTime } from './format'
import { attempt, newKey, useApi, useIdempotencyKey, useSubmitting } from './hooks'
import type { Person, StudentRow } from './types'

const PHONE = /^1\d{10}$/

/**
 * A phone as typed or pasted, such as ` 139 0000 0001 ` or `+86 139-0000-0001`, as its digits.
 * Not cut to 11, so a wrong number shows as wrong instead of quietly losing a digit.
 */
export const phoneDigits = (typed: string) =>
  typed.replace(/\D/g, '').replace(/^86(?=1\d{10}$)/, '')

/** Shown under a phone that can't be right: too long, or 11 digits that are not a mobile. */
const phoneProblem = (phone: string) =>
  phone && !PHONE.test(phone) && phone.length >= 11 ? '请填写 11 位手机号' : null

/** Other students holding `phone`, so the desk doesn't give one person two records. */
function useSamePhone(phone: string, except?: number) {
  const valid = PHONE.test(phone)
  const same = useApi<StudentRow[]>(valid ? `/admin/students?q=${encodeURIComponent(phone)}` : null)
  const list = valid
    ? (same.data ?? []).filter((s) => s.phone === phone && !s.deletedAt && s.id !== except)
    : []
  return { list, loading: valid && same.loading, reload: same.reload }
}

function SamePhoneNote({
  list,
  onOpen,
  what,
}: {
  list: StudentRow[]
  onOpen: () => void
  what: string
}) {
  if (list.length === 0) return null
  return (
    <Field>
      <div className="field-text warning-text">
        该手机号已是学员
        {list.map((d) => (
          <a key={d.id} href={`#/students?id=${d.id}`} onClick={onOpen}>
            「{d.name || '未填写姓名'}」
          </a>
        ))}
        ，{what}
      </div>
    </Field>
  )
}

/**
 * 前台建档: adds a student who has not used the mini program, so the desk can sell and book for
 * them now. They link their WeChat later with a bind code.
 */
export function NewStudentDialog({
  initial = '',
  onClose,
  onDone,
}: {
  /** What the desk typed in a search, used as the phone or name to start with. */
  initial?: string
  onClose: () => void
  onDone: (student: Person) => void
}) {
  const typedPhone = /^[+\d\s-]*\d[+\d\s-]*$/.test(initial)
  const [name, setName] = useState(typedPhone ? '' : initial)
  const [phone, setPhone] = useState(typedPhone ? phoneDigits(initial) : '')
  const submitting = useSubmitting()
  const key = useIdempotencyKey()
  const validPhone = PHONE.test(phone.trim())
  // Students already holding the phone, so the desk opens them instead of adding a duplicate.
  const same = useSamePhone(phone.trim())
  const duplicates = same.list
  // The server found a student with the phone that the lookup above did not show, such as one
  // another desk added a moment ago: the next submit adds anyway.
  const [refusedPhone, setRefusedPhone] = useState<string | null>(null)
  const confirmDuplicate = duplicates.length > 0 || refusedPhone === phone.trim()

  const submit = async () => {
    if (!name.trim() || !validPhone) return
    let created: { id: number } | undefined
    const ok = await attempt(async () => {
      try {
        created = await api<{ id: number }>(
          'POST',
          '/admin/students',
          { name: name.trim(), phone: phone.trim(), force: confirmDuplicate },
          { key },
        )
      } catch (e) {
        if (e instanceof RequestError && e.code === 'phone_exists') {
          setRefusedPhone(phone.trim())
          void same.reload()
        }
        throw e
      }
    }, '已建档')
    if (ok && created) onDone({ id: created.id, name: name.trim(), phone: phone.trim() })
  }

  return (
    <Dialog
      visible
      header="前台建档"
      confirmBtn={{
        content: confirmDuplicate ? '仍然新建' : '建档',
        disabled: !name.trim() || !validPhone || same.loading,
        loading: submitting,
      }}
      onConfirm={submit}
      onClose={onClose}
    >
      <div className="fields">
        <Field label="姓名">
          <Input
            value={name}
            maxlength={20}
            placeholder="上课学员姓名"
            autofocus={!typedPhone}
            onChange={(v) => setName(String(v))}
          />
        </Field>
        <Field
          label="手机号"
          help={phoneProblem(phone) ?? '用于上课时联系学员。登记前请先告知学员。'}
        >
          <Input
            value={phone}
            placeholder="11 位手机号"
            autofocus={typedPhone}
            status={phoneProblem(phone) ? 'error' : 'default'}
            onChange={(v) => setPhone(phoneDigits(String(v)))}
          />
        </Field>
        <SamePhoneNote list={duplicates} onOpen={onClose} what="同一人请直接打开，不要重复建档。" />
      </div>
    </Dialog>
  )
}

/**
 * Changes a student's name and phone, which the student also keeps in the mini program: a save
 * made on top of their change is refused (If-Match), and the dialog shows what they saved.
 */
export function EditStudentDialog({
  student,
  onClose,
  onDone,
}: {
  student: Person
  onClose: () => void
  onDone: () => void
}) {
  const [loaded, setLoaded] = useState({ name: student.name, phone: student.phone })
  const [name, setName] = useState(student.name)
  const [phone, setPhone] = useState(student.phone)
  const submitting = useSubmitting()
  const [key, setKey] = useState(newKey)
  const validPhone = PHONE.test(phone)
  // Only what changed is sent, so a phone the student never gave isn't required to fix a name.
  const body = {
    ...(name.trim() !== loaded.name ? { name: name.trim() } : {}),
    ...(phone !== loaded.phone ? { phone } : {}),
  }
  const nameMissing = 'name' in body && name.trim() === ''
  const phoneWrong = 'phone' in body && !validPhone
  // Another student with the new phone, as 前台建档 warns: the save asks to be pressed again.
  const same = useSamePhone('phone' in body ? phone : '', student.id)
  const ready = Object.keys(body).length > 0 && !nameMissing && !phoneWrong && !same.loading

  const submit = async () => {
    if (!ready) return
    const ok = await attempt(
      () =>
        api('PATCH', `/admin/students/${student.id}`, body, { key, ifMatch: loaded }).catch((e) => {
          throw e instanceof RequestError && e.code === 'edited_elsewhere'
            ? new RequestError(
                e.status,
                e.code,
                '学员刚刚修改了自己的信息，已载入最新内容，请核对后再保存',
              )
            : e
        }),
      '已保存',
      {
        stale: ['edited_elsewhere'],
        // The student changed it meanwhile: shows theirs, to edit again on top of it.
        onStale: async (e) => {
          if (e.code !== 'edited_elsewhere') return onDone()
          const now = await api<Person>('GET', `/admin/students/${student.id}`).catch(() => null)
          if (!now) return onDone()
          setLoaded({ name: now.name, phone: now.phone })
          setName(now.name)
          setPhone(now.phone)
          setKey(newKey())
        },
      },
    )
    if (ok) onDone()
  }

  return (
    <Dialog
      visible
      header="修改姓名和手机号"
      confirmBtn={{
        content: same.list.length ? '仍然保存' : '保存',
        disabled: !ready,
        loading: submitting,
      }}
      cancelBtn="返回"
      onConfirm={submit}
      onClose={onClose}
    >
      <div className="fields">
        <Field label="姓名" help={nameMissing ? '请填写姓名' : undefined}>
          <Input
            value={name}
            maxlength={20}
            status={nameMissing ? 'error' : 'default'}
            onChange={(v) => setName(String(v))}
          />
        </Field>
        <Field
          label="手机号"
          help={
            phoneWrong && phone.length > 0
              ? '请填写 11 位手机号'
              : '学员在小程序里也可以修改，以最后保存的为准'
          }
        >
          <Input
            value={phone}
            placeholder="11 位手机号"
            status={phoneWrong && phone.length > 0 ? 'error' : 'default'}
            onChange={(v) => setPhone(phoneDigits(String(v)))}
          />
        </Field>
        <SamePhoneNote list={same.list} onOpen={onClose} what="请确认不是同一人后再保存。" />
      </div>
    </Dialog>
  )
}

/**
 * Shows a front-desk student the code that links their WeChat, and watches for them to use it.
 */
export function BindWechatDialog({
  studentId,
  onClose,
  onBound,
}: {
  studentId: number
  onClose: () => void
  onBound: () => void
}) {
  const [code, setCode] = useState<{ code: string; expiresAt: string; qr: string | null } | null>(
    null,
  )
  const [error, setError] = useState<string | null>(null)
  const [bound, setBound] = useState(false)
  const markBound = () => {
    setBound(true)
    onBound()
  }

  // Each code replaces the last, so only one request runs at a time: a double click, or the
  // effect running twice in development, must not leave an outdated code on screen.
  const [generating, setGenerating] = useState(false)
  const inFlight = useRef(false)
  const generate = async () => {
    if (inFlight.current) return
    inFlight.current = true
    setGenerating(true)
    setError(null)
    try {
      setCode(
        await api<{ code: string; expiresAt: string; qr: string | null }>(
          'POST',
          `/admin/students/${studentId}/bind-code`,
        ),
      )
    } catch (e) {
      setError(e instanceof RequestError ? e.message : '生成失败，请重试')
      if (e instanceof RequestError && e.code === 'already_bound') markBound()
    } finally {
      inFlight.current = false
      setGenerating(false)
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: one code per opening
  useEffect(() => {
    void generate()
  }, [])

  // The student scans while the dialog is open: show it as soon as they are linked.
  // biome-ignore lint/correctness/useExhaustiveDependencies: markBound only reports upward
  useEffect(() => {
    if (!code || bound) return
    const timer = setInterval(async () => {
      try {
        const s = await api<{ wechatBound: boolean }>('GET', `/admin/students/${studentId}/bound`)
        if (s.wechatBound) markBound()
      } catch {
        // Checked again on the next tick.
      }
    }, 3000)
    return () => clearInterval(timer)
  }, [code, bound, studentId])

  return (
    <Dialog visible header="绑定微信" footer={false} width={440} onClose={onClose}>
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        {bound ? (
          <div className="bind-code-box">
            <div className="bind-done">已绑定微信</div>
            <div className="muted">前台登记的课时包、预约和订单已同步到学员的小程序。</div>
          </div>
        ) : error ? (
          <div className="danger-text">{error}</div>
        ) : !code ? (
          <Loading size="small" />
        ) : (
          <div className="bind-code-box">
            {code.qr && <img className="bind-qr" src={code.qr} alt="小程序码" />}
            <div className="bind-code">
              {code.code.slice(0, 4)} {code.code.slice(4)}
            </div>
            <div className="muted">有效期至 {fmtDateTime(code.expiresAt)}</div>
          </div>
        )}
        {!bound && (
          <div className="muted">
            {code?.qr ? '请学员用微信扫码，或' : '请学员'}
            在小程序「我的 &gt; 同步前台记录」输入绑定码。绑定码请只给学员本人。
          </div>
        )}
        <Space>
          {bound ? (
            <Button theme="primary" onClick={onClose}>
              完成
            </Button>
          ) : (
            <Button variant="outline" loading={generating} onClick={generate}>
              重新生成
            </Button>
          )}
        </Space>
      </Space>
    </Dialog>
  )
}
