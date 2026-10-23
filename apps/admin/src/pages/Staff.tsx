import { useState } from 'react'
import { Button, Dialog, Input, Space, Tag } from 'tdesign-react'
import { api } from '../api'
import { DataTable } from '../DataTable'
import { Field } from '../Field'
import { fmtDate } from '../format'
import { attempt, useApi, useIdempotencyKey, useSubmitting } from '../hooks'
import type { Staff as StaffMember } from '../types'

export const STAFF_CHANGED = 'staff-changed'

type Editing =
  | { kind: 'create' }
  | { kind: 'rename'; member: StaffMember }
  | { kind: 'reset'; member: StaffMember }
  | { kind: 'toggle'; member: StaffMember }
  | { kind: 'own-password' }

export function Staff() {
  const list = useApi<StaffMember[]>('/admin/staff')
  const me = useApi<StaffMember>('/admin/me')
  const [editing, setEditing] = useState<Editing | null>(null)
  const done = () => {
    setEditing(null)
    void list.reload()
    // The header shows the signed-in name, which a rename may have changed.
    window.dispatchEvent(new Event(STAFF_CHANGED))
  }

  return (
    <div>
      <div className="toolbar">
        <span className="muted">
          每位员工用自己的账号登录，退款、售卖、代约等操作都会记下是谁做的。
        </span>
        <span className="spacer" />
        <Button variant="outline" onClick={() => setEditing({ kind: 'own-password' })}>
          修改我的密码
        </Button>
        <Button onClick={() => setEditing({ kind: 'create' })}>新增员工</Button>
      </div>
      <DataTable
        rowKey="id"
        loading={list.loading}
        data={list.data ?? []}
        empty={list.error ?? '还没有员工'}
        columns={[
          {
            colKey: 'name',
            title: '姓名',
            cell: ({ row }) => (
              <Space size={4}>
                <span>{row.name}</span>
                {row.id === me.data?.id && (
                  <Tag size="small" variant="light">
                    我
                  </Tag>
                )}
              </Space>
            ),
          },
          { colKey: 'username', title: '登录名' },
          {
            colKey: 'active',
            title: '状态',
            cell: ({ row }) =>
              row.active ? (
                <Tag theme="success" variant="light">
                  启用
                </Tag>
              ) : (
                <Tag variant="light">已停用</Tag>
              ),
          },
          { colKey: 'createdAt', title: '添加时间', cell: ({ row }) => fmtDate(row.createdAt) },
          {
            colKey: 'op',
            title: '操作',
            width: 220,
            cell: ({ row }) => (
              <div className="nowrap">
                <Button
                  variant="text"
                  theme="primary"
                  onClick={() => setEditing({ kind: 'rename', member: row })}
                >
                  改名
                </Button>
                {row.id !== me.data?.id && (
                  <>
                    <Button
                      variant="text"
                      theme="primary"
                      onClick={() => setEditing({ kind: 'reset', member: row })}
                    >
                      重置密码
                    </Button>
                    <Button
                      variant="text"
                      theme={row.active ? 'danger' : 'primary'}
                      onClick={() => setEditing({ kind: 'toggle', member: row })}
                    >
                      {row.active ? '停用' : '启用'}
                    </Button>
                  </>
                )}
              </div>
            ),
          },
        ]}
      />
      {editing?.kind === 'create' && <CreateStaff onClose={() => setEditing(null)} onDone={done} />}
      {editing?.kind === 'rename' && (
        <Rename member={editing.member} onClose={() => setEditing(null)} onDone={done} />
      )}
      {editing?.kind === 'reset' && (
        <ResetPassword member={editing.member} onClose={() => setEditing(null)} onDone={done} />
      )}
      {editing?.kind === 'toggle' && (
        <Toggle member={editing.member} onClose={() => setEditing(null)} onDone={done} />
      )}
      {editing?.kind === 'own-password' && (
        <OwnPassword onClose={() => setEditing(null)} onDone={() => setEditing(null)} />
      )}
    </div>
  )
}

const passwordHelp = '至少 8 位'
const passwordOk = (p: string) => p.length >= 8 && p.length <= 100
const usernameOk = (u: string) => /^[a-z0-9_.-]{3,20}$/i.test(u.trim())

type DialogProps = { onClose: () => void; onDone: () => void }

// Dialogs that send a password take no Idempotency-Key: the server keeps a plain hash of a keyed
// request's body, which must never be a hash of a password. A repeat there is refused instead,
// or (for a password) just sets the same password again.

function CreateStaff({ onClose, onDone }: DialogProps) {
  const [name, setName] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const submitting = useSubmitting()
  const ready = name.trim() !== '' && usernameOk(username) && passwordOk(password)
  const submit = async () => {
    if (!ready) return
    if (
      await attempt(
        () => api('POST', '/admin/staff', { name, username, password }),
        '已添加，请把登录名和密码告诉对方',
      )
    )
      onDone()
  }
  return (
    <Dialog
      visible
      header="新增员工"
      confirmBtn={{ content: '添加', disabled: !ready, loading: submitting }}
      cancelBtn="返回"
      onConfirm={submit}
      onClose={onClose}
    >
      <div className="fields">
        <Field label="姓名">
          <Input value={name} maxlength={20} onChange={(v) => setName(String(v))} />
        </Field>
        <Field label="登录名" help="3 到 20 位字母、数字或 _ . -">
          <Input
            value={username}
            maxlength={20}
            status={username && !usernameOk(username) ? 'error' : 'default'}
            onChange={(v) => setUsername(String(v))}
          />
        </Field>
        <Field label="初始密码" help={passwordHelp}>
          <Input
            type="password"
            autocomplete="new-password"
            value={password}
            onChange={(v) => setPassword(String(v))}
          />
        </Field>
      </div>
    </Dialog>
  )
}

function Rename({ member, onClose, onDone }: DialogProps & { member: StaffMember }) {
  const [name, setName] = useState(member.name)
  const submitting = useSubmitting()
  const key = useIdempotencyKey()
  const ready = name.trim() !== '' && name.trim() !== member.name
  const submit = async () => {
    if (!ready) return
    if (
      await attempt(() => api('PATCH', `/admin/staff/${member.id}`, { name }, { key }), '已保存', {
        onStale: onDone,
      })
    )
      onDone()
  }
  return (
    <Dialog
      visible
      header="修改姓名"
      confirmBtn={{ content: '保存', disabled: !ready, loading: submitting }}
      cancelBtn="返回"
      onConfirm={submit}
      onClose={onClose}
    >
      <Field label="姓名">
        <Input value={name} maxlength={20} onChange={(v) => setName(String(v))} />
      </Field>
    </Dialog>
  )
}

function ResetPassword({ member, onClose, onDone }: DialogProps & { member: StaffMember }) {
  const [password, setPassword] = useState('')
  const submitting = useSubmitting()
  const submit = async () => {
    if (!passwordOk(password)) return
    if (
      await attempt(
        () => api('PUT', `/admin/staff/${member.id}/password`, { password }),
        '已重置，对方需用新密码重新登录',
        { onStale: onDone },
      )
    )
      onDone()
  }
  return (
    <Dialog
      visible
      header={`重置 ${member.name} 的密码`}
      confirmBtn={{ content: '重置', disabled: !passwordOk(password), loading: submitting }}
      cancelBtn="返回"
      onConfirm={submit}
      onClose={onClose}
    >
      <Field label="新密码" help={`${passwordHelp}，对方已登录的设备会退出`}>
        <Input
          type="password"
          autocomplete="new-password"
          value={password}
          onChange={(v) => setPassword(String(v))}
        />
      </Field>
    </Dialog>
  )
}

function Toggle({ member, onClose, onDone }: DialogProps & { member: StaffMember }) {
  const submitting = useSubmitting()
  const key = useIdempotencyKey()
  const submit = async () => {
    if (
      await attempt(
        () => api('PATCH', `/admin/staff/${member.id}`, { active: !member.active }, { key }),
        member.active ? '已停用' : '已启用',
        { onStale: onDone },
      )
    )
      onDone()
  }
  return (
    <Dialog
      visible
      header={member.active ? `停用 ${member.name}` : `启用 ${member.name}`}
      confirmBtn={{
        content: member.active ? '停用' : '启用',
        theme: member.active ? 'danger' : 'primary',
        loading: submitting,
      }}
      cancelBtn="返回"
      onConfirm={submit}
      onClose={onClose}
    >
      <p>
        {member.active
          ? '停用后对方立即退出，不能再登录。操作记录会保留。'
          : '启用后对方可用原密码登录。'}
      </p>
    </Dialog>
  )
}

function OwnPassword({ onClose, onDone }: DialogProps) {
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
        '已修改，其他设备需重新登录',
      )
    )
      onDone()
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
      <div className="fields">
        <Field label="当前密码">
          <Input
            type="password"
            autocomplete="current-password"
            value={current}
            onChange={(v) => setCurrent(String(v))}
          />
        </Field>
        <Field label="新密码" help={passwordHelp}>
          <Input
            type="password"
            autocomplete="new-password"
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
      </div>
    </Dialog>
  )
}
