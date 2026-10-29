import { REFUND_PAID_TWICE, type RefundStatus } from '@rs/shared'
import { useState } from 'react'
import {
  Button,
  Checkbox,
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
import { DataTable } from '../DataTable'
import { ExportButton } from '../ExportButton'
import { Field } from '../Field'
import { fmtDate, fmtDateTime, toFen, toYuan, yuan } from '../format'
import { attempt, onceKey, useActionKeys, useIdempotencyKey, useSubmitting } from '../hooks'
import { providerOptions, refundLabel } from '../labels'
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
  /** Set by a retry: false when WeChat Pay already had the old refund done or on its way. */
  resent?: boolean
}

/** WeChat Pay can refuse a refund at once (balance too low, say), so say so instead of success. */
function tellOutcome(outcome: RefundOutcome | undefined, success: string) {
  if (outcome?.resent === false && outcome.status !== 'failed') {
    void MessagePlugin.success('原退款已在微信支付处理，已更新状态，未重复退款')
  } else if (outcome?.status === 'failed') {
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
  const filters = useListFilters(
    { status: 'requested', from: '', to: '', q: '', provider: '', abnormal: '' },
    {
      path: '#/refunds',
      valid: {
        status: oneOf(...statusOptions.map((o) => o.value)),
        abnormal: oneOf('1'),
        from: isDay,
        to: isDay,
        provider: oneOf(...providerOptions.map((o) => o.value)),
      },
    },
  )
  const f = filters.values
  const params = new URLSearchParams()
  setRange(params, f.from, f.to)
  for (const key of ['q', 'status', 'provider', 'abnormal'] as const)
    if (f[key]) params.set(key, f[key])
  const list = usePagedList<Refund>(`/admin/refunds?${params}`, filters)
  const more = ['status', 'provider', 'abnormal'] as const
  const { reload } = list
  const [deciding, setDeciding] = useState<{ refund: Refund; approve: boolean } | null>(null)
  const [settling, setSettling] = useState<Refund | null>(null)
  const keys = useActionKeys()

  const paidBack = async (r: Refund) => {
    if (
      await attempt(
        () =>
          api('POST', `/admin/refunds/${r.id}/paid-back`, undefined, {
            key: onceKey(`paid-back-${r.id}`),
          }),
        '已记录退还',
        { onStale: reload, key: `paid-back-${r.id}` },
      )
    )
      await reload()
  }

  const retry = async (r: Refund) => {
    let outcome: RefundOutcome | undefined
    if (
      await attempt(
        async () => {
          outcome = await api<RefundOutcome>('POST', `/admin/refunds/${r.id}/retry`, undefined, {
            key: keys.get(`retry-${r.id}`),
          })
        },
        undefined,
        { onStale: reload, key: `retry-${r.id}` },
      )
    ) {
      // A later retry, should this one fail again, is a new one.
      keys.done(`retry-${r.id}`)
      tellOutcome(outcome, '已重新提交')
      await reload()
    }
  }

  return (
    <div className="paged-list">
      <FilterBar
        main={
          <>
            <DateFilter
              from={f.from}
              to={f.to}
              placeholder={['申请日期', '结束日期']}
              onChange={(from, to) => filters.set({ from, to })}
            />
            <SearchInput value={f.q} onChange={(q) => filters.set({ q })} />
          </>
        }
        more={
          <>
            <Filter label="状态">
              <Select
                style={{ width: 140 }}
                clearable
                placeholder="全部状态"
                value={f.status || undefined}
                onChange={(v) => filters.set({ status: String(v ?? '') })}
                options={statusOptions}
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
              <Checkbox
                checked={f.abnormal === '1'}
                onChange={(v) => filters.set({ abnormal: v ? '1' : '' })}
              >
                退款异常
              </Checkbox>
            </Filter>
          </>
        }
        set={filters.changed([...more])}
        onClear={() => filters.reset([...more])}
        actions={
          // The export has no 退款异常 filter.
          f.abnormal !== '1' && (
            <ExportButton
              kind="refunds"
              range={f.from && f.to ? [f.from, f.to] : undefined}
              filters={{ q: f.q, status: f.status, provider: f.provider }}
              filterText={
                [
                  f.q && `搜索“${f.q}”`,
                  f.status && `状态：${statusOptions.find((o) => o.value === f.status)?.label}`,
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
          list.error ??
          (filters.changed(['from', 'q', 'provider']) ? '没有符合条件的退款' : '没有记录')
        }
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
                  {row.settledNote !== null && (
                    <div className="muted">另行退款：{row.settledNote}</div>
                  )}
                  {/* On a success, a warning that the order was refunded more than paid. Once
                  settled outside the system, WeChat Pay's earlier failure no longer applies. */}
                  {row.failure &&
                    (row.settledNote === null || row.failure === REFUND_PAID_TWICE) && (
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
                <Space size={0}>
                  <Button variant="text" theme="primary" onClick={() => retry(row)}>
                    重试
                  </Button>
                  <Button variant="text" theme="primary" onClick={() => setSettling(row)}>
                    已另行退款
                  </Button>
                </Space>
              ) : row.status === 'processing' && row.abnormal ? (
                // 退款异常: staff handle it on the merchant platform, or hand the money back.
                <Button variant="text" theme="primary" onClick={() => setSettling(row)}>
                  已另行退款
                </Button>
              ) : null,
          },
        ]}
      />
      <Pager list={list} filters={filters} />
      {settling && (
        <Settle
          refund={settling}
          onClose={() => setSettling(null)}
          onDone={() => {
            setSettling(null)
            void reload()
          }}
        />
      )}
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
            help={`建议金额 = 实付金额 − 已上课时按所上教练的单次价合计，最多 ${yuan(refund.order.amount)}`}
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
              ? '这个课时包是前台付款的，当面退还后请在列表中点“已退还”。'
              : '款项将原路退回学员的微信，退款后课时包作废。'}
          </p>
        </div>
      ) : (
        <Textarea
          placeholder="拒绝原因（学员可见）"
          value={note}
          maxlength={100}
          onChange={(v) => setNote(String(v))}
        />
      )}
    </Dialog>
  )
}

/** A failed WeChat Pay refund handed back outside the system, in cash or on the merchant platform. */
function Settle({
  refund,
  onClose,
  onDone,
}: {
  refund: Refund
  onClose: () => void
  onDone: () => void
}) {
  const [note, setNote] = useState('')
  const submitting = useSubmitting()
  const key = useIdempotencyKey()

  const submit = async () => {
    let outcome: (RefundOutcome & { settled: boolean; message: string | null }) | undefined
    const ok = await attempt(
      async () => {
        outcome = await api<RefundOutcome & { settled: boolean; message: string | null }>(
          'POST',
          `/admin/refunds/${refund.id}/settled`,
          { note },
          { key },
        )
      },
      undefined,
      { onStale: onDone },
    )
    if (!ok) return
    if (outcome?.settled === false) {
      void MessagePlugin.info(outcome.message ?? '退款状态已变更，请刷新后查看', 5000)
    } else {
      void MessagePlugin.success('已标为另行退款')
    }
    onDone()
  }

  return (
    <Dialog
      visible
      header="标为已另行退款"
      confirmBtn={{
        content: '确认',
        theme: 'primary',
        disabled: !note.trim(),
        loading: submitting,
      }}
      cancelBtn="返回"
      onConfirm={submit}
      onClose={onClose}
    >
      <div className="fields">
        <p className="muted">
          {yuan(refund.amount)}{' '}
          已通过现金或微信支付商户平台退给学员后再确认。确认后计为已退款，不再重试。
        </p>
        <Textarea
          placeholder="处理说明，例如：已现金退还"
          value={note}
          maxlength={100}
          onChange={(v) => setNote(String(v))}
        />
      </div>
    </Dialog>
  )
}
