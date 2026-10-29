import { orderKindLabels, orderTitle } from '@rs/shared'
import { useState } from 'react'
import { Button, Checkbox, Dialog, Input, Select, Tag } from 'tdesign-react'
import { api } from '../api'
import { DataTable } from '../DataTable'
import { ExportButton } from '../ExportButton'
import { Field } from '../Field'
import { fmtDateTime, yuan } from '../format'
import { attempt, useSubmitting } from '../hooks'
import {
  offlineMethodLabel,
  orderAnomalyLabel,
  orderStatusLabel,
  packageStatusLabel,
  providerOptions,
} from '../labels'
import {
  DateFilter,
  Filter,
  FilterBar,
  isDay,
  oneOf,
  Pager,
  SearchInput,
  setRange,
  useListFilters,
  usePagedList,
} from '../lists'
import { StudentCell } from '../StudentCell'
import type { Order } from '../types'

const kindOptions = Object.entries(orderKindLabels).map(([value, label]) => ({ value, label }))
const statusOptions = Object.entries(orderStatusLabel).map(([value, [label]]) => ({ value, label }))

/** Every order, or with `studentId` one student's, as on their 学员详情. */
export function Orders({ studentId }: { studentId?: number } = {}) {
  const filters = useListFilters(
    { from: '', to: '', q: '', status: '', kind: '', provider: '', anomaly: '' },
    {
      path: studentId ? undefined : '#/orders',
      valid: {
        from: isDay,
        to: isDay,
        status: oneOf(...statusOptions.map((o) => o.value)),
        kind: oneOf(...kindOptions.map((o) => o.value)),
        provider: oneOf(...providerOptions.map((o) => o.value)),
        anomaly: oneOf('1'),
      },
    },
  )
  const f = filters.values
  // The overview links here for payments that need a person.
  const anomaly = f.anomaly === '1'
  const params = new URLSearchParams()
  if (studentId) params.set('studentId', String(studentId))
  setRange(params, f.from, f.to)
  for (const key of ['q', 'status', 'kind', 'provider', 'anomaly'] as const)
    if (f[key]) params.set(key, f[key])
  const list = usePagedList<Order>(`/admin/orders?${params}`, filters)
  const { reload } = list
  const more = ['status', 'kind', 'provider', 'anomaly'] as const
  const filtersSet = filters.changed([...more, 'from', 'q'])
  const open = (o: Order) => o.anomaly !== null && o.anomalyHandledAt === null
  const [handling, setHandling] = useState<Order | null>(null)
  return (
    <div className="paged-list">
      <FilterBar
        main={
          <>
            <DateFilter
              from={f.from}
              to={f.to}
              placeholder={['下单日期', '结束日期']}
              onChange={(from, to) => filters.set({ from, to })}
            />
            {!studentId && <SearchInput value={f.q} onChange={(q) => filters.set({ q })} />}
          </>
        }
        more={
          <>
            <Filter label="状态">
              <Select
                style={{ width: 120 }}
                clearable
                placeholder="全部状态"
                value={f.status || undefined}
                onChange={(v) => filters.set({ status: String(v ?? '') })}
                options={statusOptions}
              />
            </Filter>
            <Filter label="类型">
              <Select
                style={{ width: 120 }}
                clearable
                placeholder="全部类型"
                value={f.kind || undefined}
                onChange={(v) => filters.set({ kind: String(v ?? '') })}
                options={kindOptions}
              />
            </Filter>
            <Filter label="支付方式">
              <Select
                style={{ width: 130 }}
                clearable
                placeholder="全部支付方式"
                value={f.provider || undefined}
                onChange={(v) => filters.set({ provider: String(v ?? '') })}
                options={providerOptions}
              />
            </Filter>
            <Filter label="">
              <Checkbox checked={anomaly} onChange={(v) => filters.set({ anomaly: v ? '1' : '' })}>
                支付异常待处理
              </Checkbox>
            </Filter>
          </>
        }
        set={filters.changed([...more])}
        onClear={() => filters.reset([...more])}
        actions={
          // The exports have no student or 支付异常 filter, so they stay on the plain 订单 page.
          !studentId &&
          !anomaly && (
            <>
              {/* 课时包 too, as 财务 can't open the 课时包 page, which is for setting them up. */}
              <ExportButton
                kind="packages"
                label="导出课时包"
                statuses={Object.entries(packageStatusLabel).map(([value, [label]]) => ({
                  value,
                  label,
                }))}
              />
              <ExportButton
                kind="orders"
                range={f.from && f.to ? [f.from, f.to] : undefined}
                filters={{ q: f.q, status: f.status, kind: f.kind, provider: f.provider }}
                filterText={
                  [
                    f.q && `搜索“${f.q}”`,
                    f.status && `状态：${orderStatusLabel[f.status as 'paid'][0]}`,
                    f.kind && `类型：${orderKindLabels[f.kind as 'class']}`,
                    f.provider &&
                      `支付方式：${providerOptions.find((o) => o.value === f.provider)?.label}`,
                  ]
                    .filter(Boolean)
                    .join('，') || undefined
                }
              />
            </>
          )
        }
      />
      <DataTable
        rowKey="id"
        loading={list.loading}
        data={list.rows}
        empty={
          list.error ??
          (anomaly && !filters.changed(['status', 'kind', 'provider', 'from', 'q'])
            ? '没有待处理的支付异常'
            : filtersSet
              ? '没有符合条件的订单'
              : studentId
                ? '还没有订单'
                : '没有订单')
        }
        columns={[
          {
            colKey: 'createdAt',
            title: '下单时间',
            width: 120,
            cell: ({ row }) => fmtDateTime(row.createdAt),
          },
          ...(studentId
            ? []
            : [
                {
                  colKey: 'student',
                  title: '学员',
                  cell: ({ row }: { row: Order }) => <StudentCell student={row.student} />,
                },
              ]),
          {
            colKey: 'kind',
            title: '类型',
            // A trial order is described by its lesson name, which is often just 体验课.
            cell: ({ row }) => orderTitle(row.kind, row.description),
          },
          { colKey: 'amount', title: '金额', width: 90, cell: ({ row }) => yuan(row.amount) },
          {
            colKey: 'provider',
            title: '支付方式',
            width: 110,
            cell: ({ row }) =>
              row.provider === 'wechat'
                ? '微信支付'
                : `前台 ${offlineMethodLabel[row.offlineMethod ?? 'cash']}`,
          },
          {
            colKey: 'status',
            title: '状态',
            cell: ({ row }) => {
              const [label, theme] = orderStatusLabel[row.status]
              return (
                <span>
                  <Tag theme={theme} variant="light">
                    {label}
                  </Tag>
                  {row.refunded > 0 && <span className="muted"> 已退 {yuan(row.refunded)}</span>}
                  {row.anomaly && (
                    <div>
                      <Tag theme={open(row) ? 'danger' : 'default'} variant="light">
                        {open(row) ? '支付异常' : '异常已处理'}
                      </Tag>
                      <div className="muted">
                        {orderAnomalyLabel[row.anomaly]}
                        {row.anomaly === 'amount_mismatch' && row.anomalyAmount !== null
                          ? `（实付 ${yuan(row.anomalyAmount)}）`
                          : ''}
                      </div>
                      {row.anomalyNote && <div className="muted">处理：{row.anomalyNote}</div>}
                    </div>
                  )}
                </span>
              )
            },
          },
          {
            colKey: 'outTradeNo',
            title: '订单号',
            // 25 characters of a monospace-like id, kept on one line.
            width: 210,
            cell: ({ row }) => <span className="muted nowrap">{row.outTradeNo}</span>,
          },
          ...(list.rows.some(open)
            ? [
                {
                  colKey: 'actions',
                  title: '操作',
                  width: 120,
                  cell: ({ row }: { row: Order }) =>
                    open(row) && (
                      <Button variant="text" theme="warning" onClick={() => setHandling(row)}>
                        标为已处理
                      </Button>
                    ),
                },
              ]
            : []),
        ]}
      />
      <Pager list={list} filters={filters} />
      {handling && (
        <AnomalyHandled
          order={handling}
          onClose={() => setHandling(null)}
          onDone={() => {
            setHandling(null)
            void reload()
          }}
        />
      )}
    </div>
  )
}

/** Staff say what they did about a flagged payment, which is kept and logged. */
function AnomalyHandled({
  order,
  onClose,
  onDone,
}: {
  order: Order
  onClose: () => void
  onDone: () => void
}) {
  const [note, setNote] = useState('')
  const submitting = useSubmitting()
  const submit = async () => {
    if (
      await attempt(
        () => api('POST', `/admin/orders/${order.id}/anomaly-handled`, { note: note.trim() }),
        '已标记处理',
        { onStale: onDone },
      )
    )
      onDone()
  }
  return (
    <Dialog
      visible
      header="标为已处理"
      cancelBtn="返回"
      confirmBtn={{ content: '确认', disabled: !note.trim(), loading: submitting }}
      onConfirm={submit}
      onClose={onClose}
    >
      <div className="fields">
        <p className="muted">
          订单 {order.outTradeNo}。请先在微信支付商户平台核对这笔付款，需要时在商户平台退款。
        </p>
        <Field label="处理说明">
          <Input
            value={note}
            maxlength={100}
            placeholder="如：已在商户平台全额退款"
            onChange={(v) => setNote(String(v))}
          />
        </Field>
      </div>
    </Dialog>
  )
}
