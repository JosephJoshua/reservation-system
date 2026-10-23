import { useState } from 'react'
import { Select, Table, Tag } from 'tdesign-react'
import { fmtDateTime, yuan } from '../format'
import { useApi } from '../hooks'
import { offlineMethodLabel, orderKindLabel, orderStatusLabel } from '../labels'
import type { Order } from '../types'

export function Orders() {
  const [status, setStatus] = useState('')
  const { data, loading } = useApi<Order[]>(`/admin/orders${status ? `?status=${status}` : ''}`)
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
      </div>
      <Table
        rowKey="id"
        loading={loading}
        data={data ?? []}
        empty="没有订单"
        columns={[
          { colKey: 'createdAt', title: '下单时间', cell: ({ row }) => fmtDateTime(row.createdAt) },
          {
            colKey: 'student',
            title: '学员',
            cell: ({ row }) => (
              <a href={`#/students?id=${row.student.id}`}>
                {row.student.name || '未填写'} {row.student.phone}
              </a>
            ),
          },
          {
            colKey: 'kind',
            title: '类型',
            cell: ({ row }) => `${orderKindLabel[row.kind]} · ${row.description}`,
          },
          { colKey: 'amount', title: '金额', cell: ({ row }) => yuan(row.amount) },
          {
            colKey: 'provider',
            title: '支付方式',
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
            cell: ({ row }) => <span className="muted">{row.outTradeNo}</span>,
          },
        ]}
      />
    </div>
  )
}
