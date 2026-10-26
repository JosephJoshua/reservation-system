import { orderKindLabels, orderTitle } from '@rs/shared'
import { Select, Tag } from 'tdesign-react'
import { DataTable } from '../DataTable'
import { ExportButton } from '../ExportButton'
import { fmtDateTime, yuan } from '../format'
import { offlineMethodLabel, orderStatusLabel, providerOptions } from '../labels'
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
    { from: '', to: '', q: '', status: '', kind: '', provider: '' },
    {
      path: studentId ? undefined : '#/orders',
      valid: {
        from: isDay,
        to: isDay,
        status: oneOf(...statusOptions.map((o) => o.value)),
        kind: oneOf(...kindOptions.map((o) => o.value)),
        provider: oneOf(...providerOptions.map((o) => o.value)),
      },
    },
  )
  const f = filters.values
  const params = new URLSearchParams()
  if (studentId) params.set('studentId', String(studentId))
  setRange(params, f.from, f.to)
  for (const key of ['q', 'status', 'kind', 'provider'] as const)
    if (f[key]) params.set(key, f[key])
  const list = usePagedList<Order>(`/admin/orders?${params}`, filters)
  const more = ['status', 'kind', 'provider'] as const
  const filtersSet = filters.changed([...more, 'from', 'q'])
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
          </>
        }
        set={filters.changed([...more])}
        onClear={() => filters.reset([...more])}
        actions={
          // The export has no student filter, so it stays on the 订单 page.
          !studentId && (
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
          )
        }
      />
      <DataTable
        rowKey="id"
        loading={list.loading}
        data={list.rows}
        empty={
          list.error ?? (filtersSet ? '没有符合条件的订单' : studentId ? '还没有订单' : '没有订单')
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
        ]}
      />
      <Pager list={list} filters={filters} />
    </div>
  )
}
