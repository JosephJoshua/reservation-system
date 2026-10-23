import { useState } from 'react'
import { Button, Card, Input, MessagePlugin } from 'tdesign-react'
import { api, setToken } from '../api'

/** `notice` explains why the login shows, such as an expired session. */
export function Login({ notice, onDone }: { notice?: string; onDone: () => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const ready = username.trim() !== '' && password !== ''

  const submit = async () => {
    if (!ready || busy) return
    setBusy(true)
    try {
      const { token } = await api<{ token: string }>('POST', '/admin/login', {
        username,
        password,
      })
      setToken(token)
      onDone()
    } catch (e) {
      void MessagePlugin.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login">
      <Card className="login-card" title="球馆管理" bordered>
        {notice && <p className="login-notice">{notice}</p>}
        <form
          className="fields"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <Input
            name="username"
            autocomplete="username"
            placeholder="登录名"
            value={username}
            onChange={(v) => setUsername(String(v))}
            autofocus
          />
          <Input
            name="password"
            type="password"
            autocomplete="current-password"
            placeholder="密码"
            value={password}
            onChange={(v) => setPassword(String(v))}
          />
          <Button type="submit" block loading={busy} disabled={!ready}>
            登录
          </Button>
        </form>
      </Card>
    </div>
  )
}
