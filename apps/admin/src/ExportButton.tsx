import { useState } from 'react'
import { Button, DateRangePicker, Dialog, Select } from 'tdesign-react'
import { downloadFile } from './api'
import { Field } from './Field'
import { today } from './format'
import { attempt, useSubmitting } from './hooks'

type Filters = Record<string, string | number | null | undefined>
type Kind = keyof typeof dateLabels

// Which date the range picks, per export.
const dateLabels = {
  students: '注册日期',
  bookings: '上课日期',
  orders: '下单日期',
  refunds: '申请日期',
  packages: '购买日期',
  invoices: '申请日期',
}

/**
 * 导出 on a list page: picks a date range and downloads that page's CSV with its current
 * filters. `filterText` says which filters apply; `statuses` adds a status choice to the dialog
 * on a page that has no status filter of its own.
 */
export function ExportButton({
  kind,
  label = '导出',
  filters = {},
  filterText,
  range,
  statuses,
}: {
  kind: Kind
  /** The button's text, for a page with more than one export. */
  label?: string
  filters?: Filters
  filterText?: string
  range?: [string, string]
  statuses?: { value: string; label: string }[]
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        {label}
      </Button>
      {open && (
        <ExportDialog
          kind={kind}
          filters={filters}
          filterText={filterText}
          range={range}
          statuses={statuses}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

function ExportDialog({
  kind,
  filters,
  filterText,
  range,
  statuses,
  onClose,
}: {
  kind: Kind
  filters: Filters
  filterText?: string
  range?: [string, string]
  statuses?: { value: string; label: string }[]
  onClose: () => void
}) {
  // This month so far, unless the page shows a range of its own.
  const [dates, setDates] = useState<[string, string]>(
    // A link may give the page its dates either way round.
    () => (range ? ([...range].sort() as [string, string]) : [`${today().slice(0, 8)}01`, today()]),
  )
  const [status, setStatus] = useState('')
  const submitting = useSubmitting()

  const submit = async () => {
    const params = new URLSearchParams({ from: dates[0], to: dates[1] })
    for (const [k, v] of Object.entries({ ...filters, ...(status ? { status } : {}) })) {
      if (v !== null && v !== undefined && v !== '') params.set(k, String(v))
    }
    if (await attempt(() => downloadFile(`/admin/exports/${kind}?${params}`), '已导出')) onClose()
  }

  return (
    <Dialog
      visible
      header="导出 CSV"
      confirmBtn={{ content: '导出', loading: submitting, disabled: !dates[0] || !dates[1] }}
      cancelBtn="取消"
      onConfirm={submit}
      onClose={onClose}
    >
      <div className="fields">
        <Field label={dateLabels[kind]} help="一次最多只能导出一年的数据">
          <DateRangePicker
            style={{ width: '100%' }}
            value={dates}
            onChange={(v) => setDates([String(v[0] ?? ''), String(v[1] ?? '')])}
          />
        </Field>
        {statuses && (
          <Field label="状态">
            <Select
              clearable
              placeholder="全部状态"
              value={status || undefined}
              options={statuses}
              onChange={(v) => setStatus(String(v ?? ''))}
            />
          </Field>
        )}
        <p className="muted">
          {filterText ? `按当前筛选导出：${filterText}。` : ''}
          导出会记入操作记录。
        </p>
      </div>
    </Dialog>
  )
}
