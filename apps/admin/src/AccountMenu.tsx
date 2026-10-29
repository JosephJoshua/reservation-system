import type { StaffDto } from '@rs/shared'
import { useCallback, useRef, useState } from 'react'
import { LockOnIcon, LogoutIcon, UserCircleIcon } from 'tdesign-icons-react'
import { Button, Dialog, Input, MessagePlugin, Popup } from 'tdesign-react'
import { api, setToken } from './api'
import { Field } from './Field'
import { attempt, useSubmitting } from './hooks'

export const passwordHelp = '至少 8 位'
/** As the API checks a new password: 8 to 100 characters, no space at either end. */
export const passwordOk = (p: string) => p.length >= 8 && p.length <= 100 && p.trim() === p
/** Shown under a new password that the API would refuse, once something is typed. */
export const passwordProblem = (p: string) =>
  p !== '' && p.trim() !== p ? '密码不能以空格开头或结尾' : null

/**
 * The header's account button, for every role: who is signed in, 修改我的密码 and 退出登录.
 * On a phone it shows as an icon, with the name inside the menu.
 */
export function AccountMenu({ me, onLogout }: { me: StaffDto | null; onLogout: () => void }) {
  const [open, setOpen] = useState(false)
  const [changing, setChanging] = useState(false)
  const wrap = useRef<HTMLSpanElement>(null)
  // Stable, as a new attach function moves the popup and drops focus from the items.
  const attach = useCallback(() => wrap.current ?? document.body, [])

  const close = () => {
    setOpen(false)
    wrap.current?.querySelector<HTMLButtonElement>('.account-menu-button')?.focus()
  }

  return (
    <span ref={wrap} className="account-menu-wrap">
      <Popup
        trigger="click"
        placement="bottom-right"
        showArrow={false}
        visible={open}
        onVisibleChange={setOpen}
        attach={attach}
        overlayInnerClassName="theme-menu account-menu"
        content={
          // biome-ignore lint/a11y/noStaticElementInteractions: closes the menu on Escape and Tab
          <div
            className="theme-menu-choices"
            onKeyDown={(e) => {
              if (e.key === 'Escape') close()
            }}
            onBlur={(e) => {
              if (e.relatedTarget && !wrap.current?.contains(e.relatedTarget)) setOpen(false)
            }}
          >
            {me && (
              <div className="theme-menu-title account-menu-who">
                {me.name}（{me.username}）
              </div>
            )}
            <button
              type="button"
              className="theme-menu-item"
              onClick={() => {
                setOpen(false)
                setChanging(true)
              }}
            >
              <LockOnIcon />
              <span>修改我的密码</span>
            </button>
            <button
              type="button"
              className="theme-menu-item"
              onClick={() => {
                setOpen(false)
                onLogout()
              }}
            >
              <LogoutIcon />
              <span>退出登录</span>
            </button>
          </div>
        }
      >
        <Button
          variant="text"
          className="account-menu-button"
          aria-label={me ? `账号：${me.name}` : '账号'}
          aria-expanded={open}
          title="账号"
          icon={<UserCircleIcon size="20px" />}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && open) close()
          }}
        >
          {me && <span className="signed-in">{me.name}</span>}
        </Button>
      </Popup>
      {changing && <OwnPassword onClose={() => setChanging(false)} />}
    </span>
  )
}

// Sends a password, so it takes no Idempotency-Key: the server keeps a plain hash of a keyed
// request's body, which must never be a hash of a password. A repeat just sets the same password.
function OwnPassword({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState('')
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const submitting = useSubmitting()
  const mismatch = again !== '' && again !== password
  const ready = current !== '' && passwordOk(password) && password === again
  const submit = async () => {
    if (!ready) return
    if (
      await attempt(
        () => api('PUT', '/admin/me/password', { current, password }),
        '已修改，其他设备需要重新登录',
      )
    )
      onClose()
  }
  return (
    <Dialog
      visible
      header="修改我的密码"
      confirmBtn={{ content: '保存', disabled: !ready, loading: submitting }}
      cancelBtn="返回"
      onConfirm={submit}
      onClose={onClose}
    >
      <form
        className="fields"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <Field label="当前密码">
          <Input
            type="password"
            autocomplete="current-password"
            value={current}
            onChange={(v) => setCurrent(String(v))}
          />
        </Field>
        <Field label="新密码" help={passwordProblem(password) ?? passwordHelp}>
          <Input
            type="password"
            autocomplete="new-password"
            status={passwordProblem(password) ? 'error' : 'default'}
            value={password}
            onChange={(v) => setPassword(String(v))}
          />
        </Field>
        <Field label="再输一次" help={mismatch ? '两次输入不一致' : undefined}>
          <Input
            type="password"
            autocomplete="new-password"
            value={again}
            status={mismatch ? 'error' : 'default'}
            onChange={(v) => setAgain(String(v))}
          />
        </Field>
        {/* Enter in a field saves, as on the login page. */}
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}

/**
 * Shown over the page when the session has ended: the same staff member logs in again and the
 * page, with anything typed in it, stays as it was. `onDone` gets true once logged in, or false
 * when they would rather log in with another account, which leaves the page.
 */
export function ReLogin({ me, onDone }: { me: StaffDto; onDone: (ok: boolean) => void }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    if (!password || busy) return
    setBusy(true)
    try {
      const { token } = await api<{ token: string }>('POST', '/admin/login', {
        username: me.username,
        password,
      })
      setToken(token)
      void MessagePlugin.success('已重新登录，请继续操作')
      onDone(true)
    } catch (e) {
      void MessagePlugin.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      visible
      header="登录已过期"
      closeBtn={false}
      closeOnEscKeydown={false}
      closeOnOverlayClick={false}
      confirmBtn={{ content: '登录', disabled: !password, loading: busy }}
      cancelBtn={{ content: '换个账号登录', disabled: busy }}
      onConfirm={submit}
      onCancel={() => onDone(false)}
      className="relogin-dialog"
    >
      <form
        className="fields"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <p className="muted">请输入密码重新登录，页面上未保存的内容会保留。</p>
        <Field label="登录名">
          <Input name="username" autocomplete="username" value={me.username} readonly />
        </Field>
        <Field label="密码">
          <Input
            name="password"
            type="password"
            autocomplete="current-password"
            value={password}
            onChange={(v) => setPassword(String(v))}
            autofocus
          />
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}
