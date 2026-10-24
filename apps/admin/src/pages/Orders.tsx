import { orderTitle } from '@rs/shared'
import { useState } from 'react'
import { Select, Tag } from 'tdesign-react'
import { DataTable, LoadMore } from '../DataTable'
import { ExportButton } from '../ExportButton'
import { fmtDateTime, yuan } from '../format'
import { usePagedApi } from '../hooks'
import { offlineMethodLabel, orderStatusLabel } from '../labels'
import { StudentCell } from '../StudentCell'
import type { Order } from '../types'

export function Orders() {
  const [status, setStatus] = useState('')
  const list = usePagedApi<Order>(`/admin/orders${status ? `?status=${status}` : ''}`, 'before')
  return (
    <div>
      <div className="toolbar">
        <Select
          style={{ width: 140 }}
          clearable
          placeholder="全部状态"
          value={status || undefined}
          onChange={(v) => setStatus(String(v ?? ''))}
          options={Object.entries(orderStatusLabel).map(([value, [label]]) => ({ value, label }))}
        />
        <div className="toolbar-actions">
          <ExportButton
            kind="orders"
            filters={{ status }}
            filterText={status ? `状态：${orderStatusLabel[status as 'paid'][0]}` : undefined}
          />
        </div>
      </div>
      <DataTable
        rowKey="id"
        loading={list.loading && !list.loaded}
        data={list.rows}
        empty={list.error ?? '没有订单'}
        columns={[
          {
            colKey: 'createdAt',
            title: '下单时间',
            width: 120,
            cell: ({ row }) => fmtDateTime(row.createdAt),
          },
          {
            colKey: 'student',
            title: '学员',
            cell: ({ row }) => <StudentCell student={row.student} />,
          },
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
            cell: ({ row }) => <span className="muted nowrap">{row.outTradeNo}</span>,
          },
        ]}
      />
      <LoadMore
        shown={list.rows.length}
        more={list.more}
        loading={list.loading}
        onMore={list.loadMore}
      />
    </div>
  )
}
