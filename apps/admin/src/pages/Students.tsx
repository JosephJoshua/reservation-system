import { useEffect, useState } from 'react'
import {
  Button,
  Card,
  Dialog,
  Drawer,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Textarea,
} from 'tdesign-react'
import { api } from '../api'
import { Field } from '../Field'
import { fmtDate, fmtDateTime, toFen, toYuan, yuan } from '../format'
import { attempt, useApi } from '../hooks'
import {
  bookingStatusLabel,
  ledgerKindLabel,
  offlineMethodLabel,
  packageStatusLabel,
} from '../labels'
import type { LedgerEntry, PackageProduct, StudentDetail, StudentRow } from '../types'

function idFromHash() {
  const id = Number(new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('id'))
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

export function Students() {
  const [q, setQ] = useState('')
  const [query, setQuery] = useState('')
  const [openId, setOpenId] = useState<number | null>(idFromHash)
  const list = useApi<StudentRow[]>(`/admin/students?q=${encodeURIComponent(query)}`)

  useEffect(() => {
    const onHash = () => setOpenId(idFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  return (
    <div>
      <form
        className="toolbar"
        onSubmit={(e) => {
          e.preventDefault()
          setQuery(q)
        }}
      >
        <Input
          style={{ width: 240 }}
          placeholder="姓名或手机号"
          value={q}
          onChange={(v) => setQ(String(v))}
          clearable
          onClear={() => setQuery('')}
        />
        <Button type="submit">搜索</Button>
      </form>
      <Table
        rowKey="id"
        loading={list.loading}
        data={list.data ?? []}
        empty={query ? '没有找到学员' : '还没有学员'}
        columns={[
          {
            colKey: 'name',
            title: '姓名',
            cell: ({ row }) => row.name || <span className="muted">未填写</span>,
          },
          { colKey: 'phone', title: '手机号', cell: ({ row }) => row.phone || '-' },
          { colKey: 'createdAt', title: '注册时间', cell: ({ row }) => fmtDate(row.createdAt) },
          {
            colKey: 'tester',
            title: '',
            cell: ({ row }) => (row.tester ? <Tag variant="light">测试</Tag> : null),
          },
          {
            colKey: 'op',
            title: '操作',
            cell: ({ row }) => (
              <Button variant="text" theme="primary" onClick={() => setOpenId(row.id)}>
                查看
              </Button>
            ),
          },
        ]}
      />
      {openId && (
        <StudentDrawer
          id={openId}
          onClose={() => {
            setOpenId(null)
            if (window.location.hash.includes('?')) window.location.hash = '/students'
            void list.reload()
          }}
        />
      )}
    </div>
  )
}

function StudentDrawer({ id, onClose }: { id: number; onClose: () => void }) {
  const detail = useApi<StudentDetail>(`/admin/students/${id}`)
  const products = useApi<PackageProduct[]>('/admin/package-products')
  const [selling, setSelling] = useState(false)
  const [action, setAction] = useState<{
    kind: 'grant' | 'extend' | 'ledger'
    packageId: number
  } | null>(null)
  const s = detail.data

  return (
    <Drawer
      visible
      size="720px"
      header={s ? s.name || '学员' : '学员'}
      footer={false}
      onClose={onClose}
    >
      {s && (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Space align="center">
            <span>{s.phone || '未填写手机号'}</span>
            <span className="muted">注册于 {fmtDate(s.createdAt)}</span>
            <span className="muted">测试学员</span>
            <Switch
              size="small"
              value={s.tester}
              onChange={async (v) => {
                if (await attempt(() => api('PATCH', `/admin/students/${s.id}`, { tester: v })))
                  await detail.reload()
              }}
            />
          </Space>

          <Card
            title="课时包"
            bordered
            actions={
              <Button size="small" onClick={() => setSelling(true)}>
                前台售卖
              </Button>
            }
          >
            <Table
              rowKey="id"
              data={s.packages}
              empty="没有课时包"
              columns={[
                { colKey: 'name', title: '名称' },
                {
                  colKey: 'left',
                  title: '剩余',
                  cell: ({ row }) => `${row.lessonsRemaining}/${row.lessonsPurchased}`,
                },
                {
                  colKey: 'expiresAt',
                  title: '有效期至',
                  cell: ({ row }) => fmtDate(new Date(new Date(row.expiresAt).getTime() - 1)),
                },
                { colKey: 'pricePaid', title: '实付', cell: ({ row }) => yuan(row.pricePaid) },
                {
                  colKey: 'status',
                  title: '状态',
                  cell: ({ row }) => {
                    const [label, theme] = packageStatusLabel[row.status]
                    return (
                      <Tag theme={theme} variant="light">
                        {label}
                      </Tag>
                    )
                  },
                },
                {
                  colKey: 'op',
                  title: '操作',
                  cell: ({ row }) => (
                    <Space size={0}>
                      {row.status === 'active' ||
                      row.status === 'used_up' ||
                      row.status === 'expired' ? (
                        <>
                          <Button
                            size="small"
                            variant="text"
                            theme="primary"
                            onClick={() => setAction({ kind: 'grant', packageId: row.id })}
                          >
                            加课时
                          </Button>
                          <Button
                            size="small"
                            variant="text"
                            theme="primary"
                            onClick={() => setAction({ kind: 'extend', packageId: row.id })}
                          >
                            延期
                          </Button>
                        </>
                      ) : null}
                      <Button
                        size="small"
                        variant="text"
                        onClick={() => setAction({ kind: 'ledger', packageId: row.id })}
                      >
                        记录
                      </Button>
                    </Space>
                  ),
                },
              ]}
            />
          </Card>

          <Card title="预约记录" bordered>
            <Table
              rowKey="id"
              data={s.bookings}
              empty="没有预约"
              columns={[
                { colKey: 'startsAt', title: '时间', cell: ({ row }) => fmtDateTime(row.startsAt) },
                {
                  colKey: 'lesson',
                  title: '课程',
                  cell: ({ row }) => `${row.lessonType.name} · ${row.coach.name}`,
                },
                {
                  colKey: 'status',
                  title: '状态',
                  cell: ({ row }) => {
                    const [label, theme] = bookingStatusLabel[row.status]
                    return (
                      <Tag theme={theme} variant="light">
                        {label}
                      </Tag>
                    )
                  },
                },
              ]}
            />
          </Card>
        </Space>
      )}

      {selling && s && (
        <OfflineSale
          studentId={s.id}
          products={products.data ?? []}
          onClose={() => setSelling(false)}
          onDone={() => {
            setSelling(false)
            void detail.reload()
          }}
        />
      )}
      {action && action.kind !== 'ledger' && (
        <PackageAction
          kind={action.kind}
          packageId={action.packageId}
          onClose={() => setAction(null)}
          onDone={() => {
            setAction(null)
            void detail.reload()
          }}
        />
      )}
      {action?.kind === 'ledger' && (
        <Ledger packageId={action.packageId} onClose={() => setAction(null)} />
      )}
    </Drawer>
  )
}

function OfflineSale({
  studentId,
  products,
  onClose,
  onDone,
}: {
  studentId: number
  products: PackageProduct[]
  onClose: () => void
  onDone: () => void
}) {
  const onSale = products.filter((p) => p.onSale)
  const [productId, setProductId] = useState<number | undefined>(onSale[0]?.id)
  const product = products.find((p) => p.id === productId)
  const [amount, setAmount] = useState<number | undefined>(toYuan(product?.price))
  const [method, setMethod] = useState<keyof typeof offlineMethodLabel>('alipay')
  const [note, setNote] = useState('')

  const submit = async () => {
    const fen = toFen(amount)
    if (!productId || fen === null) return
    const ok = await attempt(
      () =>
        api('POST', '/admin/packages/offline-sale', {
          studentId,
          productId,
          amount: fen,
          method,
          note,
        }),
      '已记录',
    )
    if (ok) onDone()
  }

  return (
    <Dialog
      visible
      header="前台售卖课时包"
      confirmBtn="确认收款"
      onConfirm={submit}
      onClose={onClose}
    >
      <div className="fields">
        <Field label="课时包">
          <Select
            value={productId}
            options={onSale.map((p) => ({ label: `${p.name}（${yuan(p.price)}）`, value: p.id }))}
            onChange={(v) => {
              const p = products.find((x) => x.id === Number(v))
              setProductId(Number(v))
              setAmount(toYuan(p?.price))
            }}
          />
        </Field>
        <Field label="实收金额">
          <InputNumber
            theme="normal"
            value={amount}
            min={0}
            decimalPlaces={2}
            suffix="元"
            onChange={(v) => setAmount(v as number)}
          />
        </Field>
        <Field label="收款方式">
          <Select
            value={method}
            options={Object.entries(offlineMethodLabel).map(([value, label]) => ({ value, label }))}
            onChange={(v) => setMethod(v as keyof typeof offlineMethodLabel)}
          />
        </Field>
        <Field label="备注">
          <Input value={note} maxlength={100} onChange={(v) => setNote(String(v))} />
        </Field>
      </div>
    </Dialog>
  )
}

function PackageAction({
  kind,
  packageId,
  onClose,
  onDone,
}: {
  kind: 'grant' | 'extend'
  packageId: number
  onClose: () => void
  onDone: () => void
}) {
  const [n, setN] = useState(1)
  const [note, setNote] = useState('')
  const submit = async () => {
    const body = kind === 'grant' ? { lessons: n, note } : { days: n, note }
    if (await attempt(() => api('POST', `/admin/packages/${packageId}/${kind}`, body), '已保存'))
      onDone()
  }
  return (
    <Dialog
      visible
      header={kind === 'grant' ? '赠送课时' : '延长有效期'}
      confirmBtn={{ content: '确认', disabled: kind === 'grant' && !note.trim() }}
      onConfirm={submit}
      onClose={onClose}
    >
      <div className="fields">
        <Field label={kind === 'grant' ? '课时数' : '天数'}>
          <InputNumber
            theme="normal"
            value={n}
            min={1}
            max={kind === 'grant' ? 50 : 365}
            suffix={kind === 'grant' ? '节' : '天'}
            onChange={(v) => setN(Number(v) || 1)}
          />
        </Field>
        <Field label="原因">
          <Textarea
            value={note}
            maxlength={100}
            placeholder={kind === 'grant' ? '必填，如 教练请假补课' : '选填'}
            onChange={(v) => setNote(String(v))}
          />
        </Field>
      </div>
    </Dialog>
  )
}

function Ledger({ packageId, onClose }: { packageId: number; onClose: () => void }) {
  const { data } = useApi<LedgerEntry[]>(`/admin/packages/${packageId}/ledger`)
  return (
    <Dialog visible width={560} header="课时记录" footer={false} onClose={onClose}>
      <Table
        rowKey="id"
        data={data ?? []}
        columns={[
          { colKey: 'createdAt', title: '时间', cell: ({ row }) => fmtDateTime(row.createdAt) },
          { colKey: 'kind', title: '类型', cell: ({ row }) => ledgerKindLabel[row.kind] },
          {
            colKey: 'delta',
            title: '课时',
            cell: ({ row }) => (row.delta > 0 ? `+${row.delta}` : row.delta || '-'),
          },
          { colKey: 'note', title: '备注' },
        ]}
      />
    </Dialog>
  )
}
