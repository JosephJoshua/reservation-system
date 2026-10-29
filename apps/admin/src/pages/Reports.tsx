import { toCsv } from '@rs/shared'
import { useState } from 'react'
import { Button, Card, DatePicker, Dialog, Popconfirm, Space, Tabs, Tag } from 'tdesign-react'
import { api } from '../api'
import { DataTable } from '../DataTable'
import { fmtDate, fmtDateTime, today, yuan } from '../format'
import { attempt, hashParam, newKey, useApi, useSubmitting } from '../hooks'
import { useCan } from '../me'
import { Stats } from './Stats'

interface MonthlyReport {
  month: string
  coaches: {
    id: number
    name: string
    taught: number
    minutes: number
    attended: number
    noShow: number
    unmarked: number
    venueCancelled: number
    lateCancelled: number
    pay: {
      amount: number
      lessons: number
      unrated: number
      lines: {
        lessonTypeId: number
        name: string
        lessons: number
        rate: number | null
        amount: number
      }[]
      adjustments: {
        lessonTypeId: number
        name: string
        startsAt: string
        lessons: number
        rate: number | null
        amount: number
      }[]
    }
  }[]
  payStatus: {
    confirmed: { at: string; staff: string } | null
    blocked: string | null
    version: string
    rules: { noShows: boolean; lateCancels: boolean }
  }
  revenue: {
    wechat: number
    offline: number
    byKind: { class: number; trial: number; package: number }
    refunded: number
    net: number
  }
  packagesOutstanding: { lessons: number; value: number }
}

const hours = (minutes: number) => `${Math.round((minutes / 60) * 10) / 10}`

const coachColumns = [
  ['name', '教练'],
  ['taught', '已上课时'],
  ['hours', '时长（小时）'],
  ['attended', '到课'],
  ['noShow', '缺席'],
  ['unmarked', '未签到'],
  ['venueCancelled', '场馆取消'],
  ['lateCancelled', '学员逾时取消'],
  ['payLessons', '计费课时'],
  ['payAmount', '课时费（元）'],
  ['unrated', '未设课时费'],
] as const

type CoachRow = ReturnType<typeof coachRows>[number]

function coachRows(report: MonthlyReport) {
  return report.coaches.map((c) => ({
    ...c,
    hours: hours(c.minutes),
    payLessons: c.pay.lessons,
    payAmount: (c.pay.amount / 100).toFixed(2),
    unrated: c.pay.unrated,
  }))
}

function payLessonsText(r: MonthlyReport) {
  const lessons = r.coaches.reduce((sum, c) => sum + c.pay.lessons, 0)
  const unrated = r.coaches.reduce((sum, c) => sum + c.pay.unrated, 0)
  return unrated ? `${lessons} 节计费，${unrated} 节未设课时费` : `${lessons} 节计费`
}

const counts = (on: boolean) => (on ? '计入' : '不计入')

function payNote({ confirmed, rules }: MonthlyReport['payStatus']) {
  const counted = `学员缺席${counts(rules.noShows)}，学员逾时取消${counts(rules.lateCancels)}，场馆取消不计入；小班课每节计一节。`
  return confirmed
    ? `课时费已确认，按确认时的标准计算：${counted}之后的签到或取消变动计入下个月。`
    : `课时费按当前标准和教练类别计算：${counted}确认本月后金额固定。`
}

type Adjustment = MonthlyReport['coaches'][number]['pay']['adjustments'][number]

/** "调整 10/20 一对一私教 -¥80", for a lesson of an earlier month taken back or paid now. */
function adjustmentText(a: Adjustment) {
  const sign = a.amount < 0 ? '-' : '+'
  return `调整 ${fmtDate(a.startsAt).slice(5).replace('-', '/')} ${a.name} ${a.rate === null ? '未设课时费' : `${sign}${yuan(Math.abs(a.amount))}`}`
}

function PayCell({ row }: { row: CoachRow }) {
  return (
    <div>
      <div>{yuan(row.pay.amount)}</div>
      {row.pay.lines.map((l) => (
        <div key={l.lessonTypeId} className="muted">
          {l.name} {l.lessons} 节 × {l.rate === null ? '未设置' : yuan(l.rate)}
        </div>
      ))}
      {row.pay.adjustments.map((a, i) => (
        // Two adjustments can share a lesson and a sign, so the position keys them.
        // biome-ignore lint/suspicious/noArrayIndexKey: the list is rebuilt whole on each load
        <div key={i} className="muted">
          {adjustmentText(a)}
        </div>
      ))}
      {row.pay.unrated > 0 && <div className="warning-text">{row.pay.unrated} 节未设课时费</div>}
    </div>
  )
}

/** The month as a UTF-8 CSV with a BOM, so Excel shows the Chinese headers correctly. */
function downloadCsv(report: MonthlyReport) {
  const y = (fen: number) => (fen / 100).toFixed(2)
  const lines: (string | number)[][] = [
    [`${report.month} 月报`],
    [],
    coachColumns.map(([, title]) => title),
    ...coachRows(report).map((r) => coachColumns.map(([key]) => r[key])),
    [],
    ['课时费明细'],
    ['教练', '课程', '计费课时', '单价（元）', '金额（元）'],
    ...report.coaches.flatMap((c) =>
      c.pay.lines.map((l) => [
        c.name,
        l.name,
        l.lessons,
        l.rate === null ? '未设置' : y(l.rate),
        l.rate === null ? '' : y(l.amount),
      ]),
    ),
    ...report.coaches.flatMap((c) =>
      c.pay.adjustments.map((a) => [
        c.name,
        `${a.name}（${fmtDate(a.startsAt)} 调整）`,
        a.lessons,
        a.rate === null ? '未设置' : y(a.rate),
        a.rate === null ? '' : y(a.amount),
      ]),
    ),
    [
      report.payStatus.confirmed
        ? `已确认：${report.payStatus.confirmed.staff}，${fmtDateTime(report.payStatus.confirmed.at)}`
        : '未确认',
    ],
    [payNote(report.payStatus)],
    [],
    ['收入（元）'],
    ['微信支付', y(report.revenue.wechat)],
    ['线下收款', y(report.revenue.offline)],
    ['其中单次课', y(report.revenue.byKind.class)],
    ['其中体验课', y(report.revenue.byKind.trial)],
    ['其中课时包', y(report.revenue.byKind.package)],
    ['退款', y(report.revenue.refunded)],
    ['净收入', y(report.revenue.net)],
    [],
    ['未上课时（当前）', report.packagesOutstanding.lessons],
    ['对应预收金额（元）', y(report.packagesOutstanding.value)],
  ]
  // Coach and lesson names are typed by staff; the shared helper keeps formulas from running.
  const csv = toCsv(lines)
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `report-${report.month}.csv`
  document.body.append(a)
  a.click()
  a.remove()
  // Revoking at once can cost the file its name in Chromium.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function Monthly() {
  const [month, setMonth] = useState(today().slice(0, 7))
  const { data, loading, error, reload, setData } = useApi<MonthlyReport>(
    `/admin/reports/monthly?month=${month}`,
  )
  const r = data?.month === month ? data : null

  const stats: [string, string, string?][] = r
    ? [
        ['净收入', yuan(r.revenue.net), `退款 ${yuan(r.revenue.refunded)}`],
        ['微信支付', yuan(r.revenue.wechat)],
        ['线下收款', yuan(r.revenue.offline)],
        [
          '未上课时',
          `${r.packagesOutstanding.lessons} 节`,
          `预收 ${yuan(r.packagesOutstanding.value)}，按当前计`,
        ],
        [
          '教练课时费',
          yuan(r.coaches.reduce((sum, c) => sum + c.pay.amount, 0)),
          payLessonsText(r),
        ],
      ]
    : []

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div className="toolbar">
        <DatePicker
          mode="month"
          clearable={false}
          value={month}
          onChange={(v) => setMonth(String(v || today().slice(0, 7)))}
        />
        <div className="toolbar-actions">
          <Button variant="outline" disabled={!r} onClick={() => r && downloadCsv(r)}>
            导出 CSV
          </Button>
        </div>
      </div>
      {error && <div className="danger-text">{error}</div>}
      <div className="stat-grid">
        {stats.map(([label, value, sub]) => (
          <Card key={label} bordered>
            <div className="muted">{label}</div>
            <div className="stat">{value}</div>
            {sub && <div className="muted">{sub}</div>}
          </Card>
        ))}
      </div>
      {r && (
        <Card bordered title="收入构成">
          <Space size={32}>
            <span>单次课 {yuan(r.revenue.byKind.class)}</span>
            <span>体验课 {yuan(r.revenue.byKind.trial)}</span>
            <span>课时包 {yuan(r.revenue.byKind.package)}</span>
          </Space>
          <div className="muted" style={{ marginTop: 8 }}>
            按付款时间统计；课时包在售出当月计入。
          </div>
        </Card>
      )}
      <Card
        bordered
        title="教练课时"
        actions={r && <PayMonth report={r} onChange={setData} onStale={reload} />}
      >
        <DataTable
          rowKey="id"
          loading={loading}
          data={r ? coachRows(r) : []}
          empty="这个月没有课程"
          // Columns as wide as their headings, which a fixed layout cut off, as 学员逾时取消.
          tableLayout="auto"
          className="coach-hours"
          columns={[
            ...coachColumns
              .filter(([key]) => key !== 'payAmount' && key !== 'unrated')
              .map(([colKey, title]) => ({ colKey, title })),
            {
              colKey: 'pay',
              title: '课时费',
              width: 240,
              cell: ({ row }) => <PayCell row={row} />,
            },
          ]}
        />
        <div className="muted" style={{ marginTop: 8 }}>
          按上课日期统计已结束的课程。缺席计入已上课时，学员逾时取消不计入。
          {r && payNote(r.payStatus)}
        </div>
      </Card>
    </Space>
  )
}

/** Whether the month's coach pay is confirmed, with 确认本月 and, for 管理员, 撤销确认. */
function PayMonth({
  report: r,
  onChange,
  onStale,
}: {
  report: MonthlyReport
  onChange: (r: MonthlyReport) => void
  onStale: () => void
}) {
  const canConfirm = useCan('finance')
  const canReopen = useCan('manage')
  const [confirming, setConfirming] = useState<string | null>(null)
  const submitting = useSubmitting()
  const { confirmed, blocked } = r.payStatus
  const total = r.coaches.reduce((sum, c) => sum + c.pay.amount, 0)
  const paid = r.coaches.filter((c) => c.pay.amount !== 0 || c.pay.lessons > 0).length
  const adjustments = r.coaches.reduce((sum, c) => sum + c.pay.adjustments.length, 0)

  const confirm = async () => {
    if (!confirming) return
    let next: MonthlyReport | null = null
    const ok = await attempt(
      async () => {
        next = await api<MonthlyReport>(
          'POST',
          `/admin/reports/pay-months/${r.month}/confirm`,
          { version: r.payStatus.version },
          { key: confirming },
        )
      },
      '已确认',
      {
        stale: ['pay_not_confirmable', 'edited_elsewhere'],
        onStale: () => {
          setConfirming(null)
          onStale()
        },
      },
    )
    if (ok && next) {
      setConfirming(null)
      onChange(next)
    }
  }

  const reopen = async () => {
    let next: MonthlyReport | null = null
    const ok = await attempt(
      async () => {
        next = await api<MonthlyReport>(
          'DELETE',
          `/admin/reports/pay-months/${r.month}`,
          undefined,
          {
            key: newKey(),
          },
        )
      },
      '已撤销确认',
      { key: `reopen-${r.month}`, stale: ['pay_not_last'], onStale },
    )
    if (ok && next) onChange(next)
  }

  if (confirmed) {
    return (
      <Space align="center" size={8} className="pay-month">
        <Tag theme="success" variant="light">
          已确认
        </Tag>
        <span className="muted">
          {confirmed.staff} {fmtDateTime(confirmed.at)}
        </span>
        {canReopen && (
          <Popconfirm
            placement="bottom-right"
            content="撤销后金额按当前数据重新计算，需要重新确认。"
            confirmBtn={{ content: '撤销确认', theme: 'danger' }}
            cancelBtn="返回"
            onConfirm={reopen}
          >
            <Button variant="text" theme="danger">
              撤销确认
            </Button>
          </Popconfirm>
        )}
      </Space>
    )
  }
  return (
    <Space align="center" size={8} className="pay-month">
      {blocked && <span className="muted">{blocked}</span>}
      {canConfirm && (
        <Button disabled={!!blocked} onClick={() => setConfirming(newKey())}>
          确认本月
        </Button>
      )}
      {confirming && (
        <Dialog
          visible
          header={`确认 ${r.month} 课时费`}
          // The second click of a double click on 确认本月 would land on the overlay.
          closeOnOverlayClick={false}
          confirmBtn={{ content: '确认', loading: submitting }}
          cancelBtn="返回"
          onConfirm={confirm}
          onClose={() => setConfirming(null)}
        >
          <div className="fields">
            <p>
              {paid} 位教练，合计 {yuan(total)}
              {adjustments > 0 ? `，含 ${adjustments} 条往月调整` : ''}。
            </p>
            <p className="muted">
              确认后金额固定，不再随课时费标准或设置变化；之后的签到或取消变动计入下个月。月份按顺序确认。
            </p>
          </div>
        </Dialog>
      )}
    </Space>
  )
}

export function Reports() {
  // In the address, so a refresh or a copied link opens the same tab.
  const [tab, setTab] = useState(() => (hashParam('tab') === 'monthly' ? 'monthly' : 'stats'))
  // The monthly report loads when first opened, then keeps its month while switching back and forth.
  const [monthlyOpened, setMonthlyOpened] = useState(tab === 'monthly')
  return (
    <Tabs
      value={tab}
      onChange={(v) => {
        setTab(String(v))
        if (v === 'monthly') setMonthlyOpened(true)
        // Without a step for the back button, as on the other pages with tabs.
        history.replaceState(
          history.state,
          '',
          v === 'monthly' ? '#/reports?tab=monthly' : '#/reports',
        )
      }}
      className="report-tabs"
    >
      <Tabs.TabPanel value="stats" label="经营分析" destroyOnHide={false}>
        <div className="report-tab">
          <Stats />
        </div>
      </Tabs.TabPanel>
      <Tabs.TabPanel value="monthly" label="月报与课时费" destroyOnHide={false}>
        <div className="report-tab">{monthlyOpened && <Monthly />}</div>
      </Tabs.TabPanel>
    </Tabs>
  )
}
