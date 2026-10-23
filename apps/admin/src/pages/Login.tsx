import { useState } from 'react'
import { Button, Card, Input, MessagePlugin } from 'tdesign-react'
import { api, setToken } from '../api'

export function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (!password) return
    setBusy(true)
    try {
      const { token } = await api<{ token: string }>('POST', '/admin/login', { password })
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
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <Input
            type="password"
            placeholder="管理密码"
            value={password}
            onChange={(v) => setPassword(String(v))}
            autofocus
          />
          <Button type="submit" block loading={busy} style={{ marginTop: 16 }} disabled={!password}>
            登录
          </Button>
        </form>
      </Card>
    </div>
  )
}
