import type { RefundStatus } from '@rs/shared'
import { useState } from 'react'
import {
  Button,
  Dialog,
  InputNumber,
  MessagePlugin,
  Popconfirm,
  Select,
  Space,
  Tag,
  Textarea,
} from 'tdesign-react'
import { api } from '../api'
import { DataTable, LoadMore } from '../DataTable'
import { ExportButton } from '../ExportButton'
import { Field } from '../Field'
import { fmtDate, fmtDateTime, toFen, toYuan, yuan } from '../format'
import { attempt, hashParam, useIdempotencyKey, usePagedApi, useSubmitting } from '../hooks'
import { refundLabel } from '../labels'
import { StudentCell } from '../StudentCell'
import type { Refund } from '../types'

const statusOptions = [
  { value: 'requested', label: '待审核' },
  { value: 'pending', label: '待提交/待退还' },
  { value: 'processing', label: '退款中' },
  { value: 'succeeded', label: '已退款' },
  { value: 'failed', label: '退款失败' },
  { value: 'rejected', label: '已拒绝' },
]

interface RefundOutcome {
  status: RefundStatus
  failure: string | null
}

/** WeChat Pay can refuse a refund at once (balance too low, say), so say so instead of success. */
function tellOutcome(outcome: RefundOutcome | undefined, success: string) {
  if (outcome?.status === 'failed') {
    void MessagePlugin.warning(
      `退款没有成功${outcome.failure ? `：${outcome.failure}` : ''}，可在“退款失败”中重试`,
      5000,
    )
  } else {
    void MessagePlugin.success(success)
  }
}

export function Refunds() {
  // The overview links here with the status it counted.
  const [status, setStatus] = useState(() => hashParam('status') ?? 'requested')
  const list = usePagedApi<Refund>(`/admin/refunds${status ? `?status=${status}` : ''}`, 'before')
  const { reload } = list
  const [deciding, setDeciding] = useState<{ refund: Refund; approve: boolean } | null>(null)

  const paidBack = async (r: Refund) => {
    if (
      await attempt(() => api('POST', `/admin/refunds/${r.id}/paid-back`), '已记录退还', {
        onStale: reload,
        key: `paid-back-${r.id}`,
      })
    )
      await reload()
  }

  const retry = async (r: Refund) => {
    let outcome: RefundOutcome | undefined
    if (
      await attempt(
        async () => {
          outcome = await api<RefundOutcome>('POST', `/admin/refunds/${r.id}/retry`)
        },
        undefined,
        { onStale: reload, key: `retry-${r.id}` },
      )
    ) {
      tellOutcome(outcome, '已重新提交')
      await reload()
    }
  }

  return (
    <div>
      <div className="toolbar">
        <Select
          style={{ width: 140 }}
          clearable
          placeholder="全部状态"
          value={status || undefined}
          onChange={(v) => setStatus(String(v ?? ''))}
          options={statusOptions}
        />
        <div className="toolbar-actions">
          <ExportButton
            kind="refunds"
            filters={{ status }}
            filterText={
              status ? `状态：${statusOptions.find((o) => o.value === status)?.label}` : undefined
            }
          />
        </div>
      </div>
      <DataTable
        rowKey="id"
        loading={list.loading && !list.loaded}
        data={list.rows}
        empty={list.error ?? '没有记录'}
        columns={[
          { colKey: 'createdAt', title: '申请时间', cell: ({ row }) => fmtDateTime(row.createdAt) },
          {
            colKey: 'student',
            title: '学员',
            cell: ({ row }) => <StudentCell student={row.student} />,
          },
          {
            colKey: 'what',
            title: '内容',
            cell: ({ row }) =>
              row.package ? (
                <span>
                  {row.package.name}，剩 {row.package.lessonsRemaining}/
                  {row.package.lessonsPurchased + row.package.lessonsGranted} 节，实付{' '}
                  {yuan(row.package.pricePaid)}
                  <br />
                  <span className="muted">
                    有效期至 {fmtDate(new Date(new Date(row.package.expiresAt).getTime() - 1))}
                  </span>
                </span>
              ) : (
                `${row.reason} · ${row.order.description}`
              ),
          },
          {
            colKey: 'amount',
            title: '金额',
            cell: ({ row }) =>
              row.status === 'requested' ? <span>建议 {yuan(row.amount)}</span> : yuan(row.amount),
          },
          {
            colKey: 'status',
            title: '状态',
            cell: ({ row }) => {
              const [label, theme] = refundLabel(row.status, row.order.provider === 'offline')
              return (
                <span>
                  <Tag theme={theme} variant="light">
                    {label}
                  </Tag>
                  {row.failure && row.status !== 'succeeded' && (
                    <div className="muted">{row.failure}</div>
                  )}
                  {row.order.provider === 'offline' && (
                    <div className="muted">前台付款，线下退还</div>
                  )}
                  {row.invoiceStatus && (
                    <div>
                      <a href="#/invoices" className="warning-text">
                        {row.invoiceStatus === 'issued' ? '该订单已开票' : '该订单正在申请开票'}
                      </a>
                    </div>
                  )}
                </span>
              )
            },
          },
          {
            colKey: 'op',
            title: '操作',
            cell: ({ row }) =>
              row.status === 'requested' ? (
                <Space size={0}>
                  <Button
                    variant="text"
                    theme="primary"
                    onClick={() => setDeciding({ refund: row, approve: true })}
                  >
                    同意
                  </Button>
                  <Button
                    variant="text"
                    theme="danger"
                    onClick={() => setDeciding({ refund: row, approve: false })}
                  >
                    拒绝
                  </Button>
                </Space>
              ) : row.status === 'pending' && row.order.provider === 'offline' ? (
                <Popconfirm
                  content={`确认已当面退还 ${yuan(row.amount)}？`}
                  confirmBtn="已退还"
                  cancelBtn="返回"
                  onConfirm={() => paidBack(row)}
                >
                  <Button variant="text" theme="primary">
                    已退还
                  </Button>
                </Popconfirm>
              ) : row.status === 'failed' ? (
                <Button variant="text" theme="primary" onClick={() => retry(row)}>
                  重试
                </Button>
              ) : null,
          },
        ]}
      />
      <LoadMore
        shown={list.rows.length}
        more={list.more}
        loading={list.loading}
        onMore={list.loadMore}
      />
      {deciding && (
        <Decide
          refund={deciding.refund}
          approve={deciding.approve}
          onClose={() => setDeciding(null)}
          onDone={() => {
            setDeciding(null)
            void reload()
          }}
        />
      )}
    </div>
  )
}

function Decide({
  refund,
  approve,
  onClose,
  onDone,
}: {
  refund: Refund
  approve: boolean
  onClose: () => void
  onDone: () => void
}) {
  const [amount, setAmount] = useState<number | undefined>(toYuan(refund.amount || undefined))
  const [note, setNote] = useState('')
  const submitting = useSubmitting()
  const key = useIdempotencyKey()
  const fen = toFen(amount)
  const amountValid = fen !== null && fen > 0 && fen <= refund.order.amount

  const submit = async () => {
    let outcome: RefundOutcome | undefined
    const ok = approve
      ? amountValid &&
        (await attempt(
          async () => {
            outcome = await api<RefundOutcome>(
              'POST',
              `/admin/refunds/${refund.id}/approve`,
              { amount: fen },
              { key },
            )
          },
          undefined,
          { onStale: onDone },
        ))
      : await attempt(
          () => api('POST', `/admin/refunds/${refund.id}/reject`, { note }, { key }),
          '已拒绝',
          { onStale: onDone },
        )
    if (ok && approve) tellOutcome(outcome, '已同意退款')
    if (ok) onDone()
  }

  return (
    <Dialog
      visible
      header={approve ? '同意退款' : '拒绝退款'}
      confirmBtn={{
        content: approve ? '确认退款' : '确认拒绝',
        theme: approve ? 'primary' : 'danger',
        disabled: approve ? !amountValid : !note.trim(),
        loading: submitting,
      }}
      cancelBtn="返回"
      onConfirm={submit}
      onClose={onClose}
    >
      {approve ? (
        <div className="fields">
          <Field
            label="退款金额"
            help={`建议金额 = 实付 − 已上课时按所上教练的单次价合计。最多 ${yuan(refund.order.amount)}`}
          >
            <InputNumber
              theme="normal"
              value={amount}
              min={0.01}
              max={refund.order.amount / 100}
              decimalPlaces={2}
              suffix="元"
              onChange={(v) => setAmount(v as number)}
            />
          </Field>
          <p className="muted">
            {refund.order.provider === 'offline'
              ? '该课时包为前台付款，当面退还后在列表中点“已退还”。'
              : '将原路退回学员微信。退款后课时包作废。'}
          </p>
        </div>
      ) : (
        <Textarea
          placeholder="拒绝原因，学员可见"
          value={note}
          maxlength={100}
          onChange={(v) => setNote(String(v))}
        />
      )}
    </Dialog>
  )
}
