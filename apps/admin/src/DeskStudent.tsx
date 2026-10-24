import { useEffect, useRef, useState } from 'react'
import { Button, Dialog, Input, Loading, Space } from 'tdesign-react'
import { api, RequestError } from './api'
import { Field } from './Field'
import { fmtDateTime } from './format'
import { attempt, useApi, useIdempotencyKey, useSubmitting } from './hooks'
import type { Person, StudentRow } from './types'

const PHONE = /^1\d{10}$/

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
  const typedPhone = /^\d+$/.test(initial)
  const [name, setName] = useState(typedPhone ? '' : initial)
  const [phone, setPhone] = useState(typedPhone ? initial : '')
  const submitting = useSubmitting()
  const key = useIdempotencyKey()
  const validPhone = PHONE.test(phone.trim())
  // Students already holding the phone, so the desk opens them instead of adding a duplicate.
  const same = useApi<StudentRow[]>(
    validPhone ? `/admin/students?q=${encodeURIComponent(phone.trim())}` : null,
  )
  const duplicates = validPhone
    ? (same.data ?? []).filter((s) => s.phone === phone.trim() && !s.deletedAt)
    : []
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
        <Field label="手机号" help="用于上课联系。请先告知学员会登记这些信息。">
          <Input
            value={phone}
            maxlength={11}
            placeholder="11 位手机号"
            autofocus={typedPhone}
            status={phone && !validPhone && phone.length >= 11 ? 'error' : 'default'}
            onChange={(v) => setPhone(String(v).replace(/\D/g, ''))}
          />
        </Field>
        {duplicates.length > 0 && (
          <Field>
            <div className="field-text warning-text">
              该手机号已是学员
              {duplicates.map((d) => (
                <a key={d.id} href={`#/students?id=${d.id}`} onClick={onClose}>
                  「{d.name || '未填写姓名'}」
                </a>
              ))}
              ，同一人请直接打开，不要重复建档。
            </div>
          </Field>
        )}
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
            在小程序「我的 &gt; 同步前台记录」输入绑定码。绑定码只给学员本人。
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
