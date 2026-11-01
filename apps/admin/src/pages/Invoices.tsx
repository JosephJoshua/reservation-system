import { invoiceStatusLabels, invoiceTitleKindLabels, orderTitle } from '@rs/shared'
import { useRef, useState } from 'react'
import {
  Button,
  Checkbox,
  Dialog,
  MessagePlugin,
  Popconfirm,
  Select,
  Space,
  Tag,
  Textarea,
} from 'tdesign-react'
import { api, openFile, RequestError } from '../api'
import { DataTable } from '../DataTable'
import { ExportButton } from '../ExportButton'
import { Field } from '../Field'
import { fmtDateTime, yuan } from '../format'
import { attempt, onceKey, useIdempotencyKey, useSubmitting } from '../hooks'
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
import type { AdminInvoice } from '../types'

const statusTheme = { requested: 'warning', issued: 'success', rejected: 'default' } as const

// The API refuses larger files too; checking here saves uploading one first.
const MAX_PDF = 10 * 1024 * 1024

async function viewPdf(id: number) {
  try {
    await openFile(`/admin/invoices/${id}/pdf`)
  } catch (e) {
    void MessagePlugin.error(e instanceof RequestError ? e.message : '打开失败，请重试')
  }
}

const statusOptions = Object.entries(invoiceStatusLabels).map(([value, label]) => ({
  value,
  label,
}))
const titleOptions = Object.entries(invoiceTitleKindLabels).map(([value, label]) => ({
  value,
  label,
}))

export function Invoices() {
  const filters = useListFilters(
    { status: 'requested', flagged: '', from: '', to: '', q: '', title: '' },
    {
      path: '#/invoices',
      valid: {
        status: oneOf(...statusOptions.map((o) => o.value)),
        flagged: oneOf('1'),
        from: isDay,
        to: isDay,
        title: oneOf(...titleOptions.map((o) => o.value)),
      },
    },
  )
  const f = filters.values
  const flagged = f.flagged === '1'
  const params = new URLSearchParams()
  setRange(params, f.from, f.to)
  if (f.status) params.set('status', f.status)
  if (flagged) params.set('flagged', '1')
  if (f.q) params.set('q', f.q)
  if (f.title) params.set('titleKind', f.title)
  const list = usePagedList<AdminInvoice>(`/admin/invoices?${params}`, filters)
  const more = ['status', 'title', 'flagged'] as const
  const { reload } = list
  const [uploading, setUploading] = useState<AdminInvoice | null>(null)
  const [rejecting, setRejecting] = useState<AdminInvoice | null>(null)

  const refundSeen = async (row: AdminInvoice) => {
    if (
      await attempt(
        () =>
          api('POST', `/admin/invoices/${row.id}/refund-seen`, undefined, {
            key: onceKey(`refund-seen-${row.id}`),
          }),
        '已标记处理',
        { onStale: reload, key: `refund-seen-${row.id}` },
      )
    )
      await reload()
  }

  const done = () => {
    setUploading(null)
    setRejecting(null)
    void reload()
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
                style={{ width: 120 }}
                clearable
                placeholder="全部状态"
                value={f.status || undefined}
                onChange={(v) => filters.set({ status: String(v ?? '') })}
                options={statusOptions}
              />
            </Filter>
            <Filter label="抬头类型">
              <Select
                style={{ width: 120 }}
                clearable
                placeholder="全部抬头"
                value={f.title || undefined}
                onChange={(v) => filters.set({ title: String(v ?? '') })}
                options={titleOptions}
              />
            </Filter>
            <Filter label="">
              <Checkbox checked={flagged} onChange={(v) => filters.set({ flagged: v ? '1' : '' })}>
                开票后有退款
              </Checkbox>
            </Filter>
          </>
        }
        set={filters.changed([...more])}
        onClear={() => filters.reset([...more])}
        actions={
          <ExportButton
            kind="invoices"
            range={f.from && f.to ? [f.from, f.to] : undefined}
            filters={{ q: f.q, status: f.status, titleKind: f.title, flagged: flagged ? 1 : null }}
            filterText={
              [
                f.q && `搜索“${f.q}”`,
                f.status && `状态：${invoiceStatusLabels[f.status as 'requested']}`,
                f.title && `抬头：${invoiceTitleKindLabels[f.title as 'personal']}`,
                flagged && '开票后有退款',
              ]
                .filter(Boolean)
                .join('，') || undefined
            }
          />
        }
      />
      <DataTable
        rowKey="id"
        loading={list.loading}
        data={list.rows}
        empty={
          list.error ??
          (filters.changed(['from', 'q', 'title'])
            ? '没有符合条件的发票申请'
            : flagged
              ? '没有待处理的退款'
              : f.status === 'requested'
                ? '没有待开票的申请'
                : '没有记录')
        }
        columns={[
          {
            colKey: 'createdAt',
            title: '申请时间',
            width: 110,
            cell: ({ row }) => fmtDateTime(row.createdAt),
          },
          {
            colKey: 'student',
            title: '学员',
            cell: ({ row }) => <StudentCell student={row.student} />,
          },
          {
            colKey: 'order',
            title: '订单',
            width: 160,
            cell: ({ row }) => (
              <span>
                {orderTitle(row.order.kind, row.order.description)}
                <div className="muted">
                  {row.order.provider === 'wechat' ? '微信支付' : '前台付款'}{' '}
                  {yuan(row.order.amount)}
                  {row.order.refunded > 0 && `，已退 ${yuan(row.order.refunded)}`}
                </div>
              </span>
            ),
          },
          {
            colKey: 'title',
            title: '抬头',
            width: 200,
            cell: ({ row }) =>
              row.title.name ? (
                <span>
                  <Tag variant="outline" size="small">
                    {invoiceTitleKindLabels[row.title.kind]}
                  </Tag>{' '}
                  {row.title.name}
                  {row.title.taxNumber && <div className="muted nowrap">{row.title.taxNumber}</div>}
                </span>
              ) : (
                <span className="muted">已注销</span>
              ),
          },
          {
            colKey: 'email',
            title: '邮箱',
            width: 170,
            cell: ({ row }) => row.title.email || <span className="muted">-</span>,
          },
          { colKey: 'amount', title: '开票金额', cell: ({ row }) => yuan(row.amount) },
          {
            colKey: 'status',
            title: '状态',
            cell: ({ row }) => (
              <span>
                <Tag theme={statusTheme[row.status]} variant="light">
                  {invoiceStatusLabels[row.status]}
                </Tag>
                {row.refundFlag && (
                  <Tag theme="danger" variant="light" className="tag-gap">
                    开票后有退款
                  </Tag>
                )}
                {row.status === 'issued' && row.issuedAt && (
                  <div className="muted">{fmtDateTime(row.issuedAt)} 开票</div>
                )}
                {row.rejectReason && <div className="muted">{row.rejectReason}</div>}
              </span>
            ),
          },
          {
            colKey: 'op',
            title: '操作',
            width: 130,
            // Nothing to do on a rejected request, so the phone card leaves the row out.
            cell: ({ row }) =>
              (row.status === 'requested' || row.hasPdf || row.refundFlag) && (
                <Space size={0} breakLine>
                  {row.status === 'requested' && (
                    <>
                      <Button variant="text" theme="primary" onClick={() => setUploading(row)}>
                        上传发票
                      </Button>
                      <Button variant="text" theme="danger" onClick={() => setRejecting(row)}>
                        拒绝
                      </Button>
                    </>
                  )}
                  {row.hasPdf && (
                    <Button variant="text" theme="primary" onClick={() => viewPdf(row.id)}>
                      查看
                    </Button>
                  )}
                  {row.status === 'issued' && row.title.name && (
                    <Button variant="text" onClick={() => setUploading(row)}>
                      重新上传
                    </Button>
                  )}
                  {row.refundFlag && (
                    <Popconfirm
                      content="已按退款冲红或重新开具发票了吗？"
                      confirmBtn="已处理"
                      cancelBtn="返回"
                      onConfirm={() => refundSeen(row)}
                    >
                      <Button variant="text" theme="warning">
                        退款已处理
                      </Button>
                    </Popconfirm>
                  )}
                </Space>
              ),
          },
        ]}
      />
      <Pager list={list} filters={filters} />
      {uploading && <Upload invoice={uploading} onClose={() => setUploading(null)} onDone={done} />}
      {rejecting && <Reject invoice={rejecting} onClose={() => setRejecting(null)} onDone={done} />}
    </div>
  )
}

/** The facts to copy into the tax system, then the PDF it produced. */
function Upload({
  invoice,
  onClose,
  onDone,
}: {
  invoice: AdminInvoice
  onClose: () => void
  onDone: () => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [fileError, setFileError] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const submitting = useSubmitting()
  const key = useIdempotencyKey()
  const replacing = invoice.status === 'issued'
  // Each file picked is its own upload, so it gets its own key.
  const [picks, setPicks] = useState(0)

  const pick = (f: File | undefined) => {
    if (!f) return
    if (f.type !== 'application/pdf' && !f.name.toLowerCase().endsWith('.pdf')) {
      setFileError('请选择 PDF 文件')
      setFile(null)
    } else if (f.size > MAX_PDF) {
      setFileError('文件不能超过 10MB')
      setFile(null)
    } else {
      setFileError('')
      setFile(f)
      setPicks((n) => n + 1)
    }
  }

  const submit = async () => {
    if (!file) return
    const form = new FormData()
    form.append('file', file)
    // Only a replacement may swap an issued PDF; a first issue another admin beat is refused.
    if (replacing) form.append('replace', '1')
    if (
      await attempt(
        () => api('POST', `/admin/invoices/${invoice.id}/issue`, form, { key: `${key}-${picks}` }),
        replacing ? '已更换发票' : '已开票',
        { onStale: onDone },
      )
    )
      onDone()
  }

  const t = invoice.title
  return (
    <Dialog
      visible
      header={replacing ? '重新上传发票' : '上传发票'}
      confirmBtn={{
        content: replacing ? '确认更换' : '确认开票',
        disabled: !file,
        loading: submitting,
      }}
      cancelBtn="返回"
      onConfirm={submit}
      onClose={onClose}
    >
      <div className="fields">
        <dl className="facts">
          <dt>抬头类型</dt>
          <dd>{invoiceTitleKindLabels[t.kind]}</dd>
          <dt>{t.kind === 'company' ? '单位名称' : '抬头'}</dt>
          <dd>{t.name}</dd>
          {t.kind === 'company' && (
            <>
              <dt>税号</dt>
              <dd>{t.taxNumber}</dd>
            </>
          )}
          <dt>邮箱</dt>
          <dd>{t.email || '-'}</dd>
          <dt>开票金额</dt>
          <dd>{yuan(invoice.amount)}</dd>
          <dt>项目</dt>
          <dd>{invoice.order.description}</dd>
        </dl>
        <Field label="发票 PDF" help="在税务系统开具发票后下载的 PDF，不超过 10MB">
          <input
            ref={input}
            hidden
            type="file"
            accept="application/pdf,.pdf"
            onChange={(e) => {
              pick(e.target.files?.[0])
              // Lets the same file be picked again after a failed upload.
              e.target.value = ''
            }}
          />
          <Space align="center" breakLine>
            <Button variant="outline" onClick={() => input.current?.click()}>
              {file ? '更换文件' : '选择文件'}
            </Button>
            {file && <span className="file-name">{file.name}</span>}
          </Space>
          {fileError && <div className="field-error">{fileError}</div>}
        </Field>
        {!replacing && <p className="muted">上传后，学员可以在小程序中查看发票。</p>}
      </div>
    </Dialog>
  )
}

function Reject({
  invoice,
  onClose,
  onDone,
}: {
  invoice: AdminInvoice
  onClose: () => void
  onDone: () => void
}) {
  const [reason, setReason] = useState('')
  const submitting = useSubmitting()
  const key = useIdempotencyKey()

  const submit = async () => {
    if (!reason.trim()) return
    if (
      await attempt(
        () => api('POST', `/admin/invoices/${invoice.id}/reject`, { reason }, { key }),
        '已拒绝',
        { onStale: onDone },
      )
    )
      onDone()
  }

  return (
    <Dialog
      visible
      header="拒绝开票"
      confirmBtn={{
        content: '确认拒绝',
        theme: 'danger',
        disabled: !reason.trim(),
        loading: submitting,
      }}
      cancelBtn="返回"
      onConfirm={submit}
      onClose={onClose}
    >
      <Textarea
        placeholder="拒绝原因（学员可见），如：税号有误，请核对后重新申请"
        value={reason}
        maxlength={100}
        onChange={(v) => setReason(String(v))}
      />
    </Dialog>
  )
}
