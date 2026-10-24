import { useState } from 'react'
import { Button, Card, DatePicker, Space, Tabs } from 'tdesign-react'
import { DataTable } from '../DataTable'
import { today, yuan, yuanGrouped } from '../format'
import { useApi } from '../hooks'
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
    }
  }[]
  payRules: { noShows: boolean; lateCancels: boolean }
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

function payNote(rules: MonthlyReport['payRules']) {
  return `课时费按当前标准和教练类别计算：学员缺席${counts(rules.noShows)}，学员逾时取消${counts(rules.lateCancels)}，场馆取消不计入；小班课每节计一节。`
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
      {row.pay.unrated > 0 && <div className="warning-text">{row.pay.unrated} 节未设课时费</div>}
    </div>
  )
}

/** A UTF-8 CSV with a BOM, so Excel shows the Chinese headers correctly. */
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
    [payNote(report.payRules)],
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
  const cell = (v: string | number) => {
    const s = String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const csv = `﻿${lines.map((l) => l.map(cell).join(',')).join('\r\n')}`
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
  const { data, loading, error } = useApi<MonthlyReport>(`/admin/reports/monthly?month=${month}`)
  const r = data?.month === month ? data : null

  const stats: [string, string, string?][] = r
    ? [
        ['净收入', yuanGrouped(r.revenue.net), `退款 ${yuan(r.revenue.refunded)}`],
        ['微信支付', yuanGrouped(r.revenue.wechat)],
        ['线下收款', yuanGrouped(r.revenue.offline)],
        [
          '未上课时',
          `${r.packagesOutstanding.lessons} 节`,
          `预收 ${yuanGrouped(r.packagesOutstanding.value)}，按当前计`,
        ],
        [
          '教练课时费',
          yuanGrouped(r.coaches.reduce((sum, c) => sum + c.pay.amount, 0)),
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
        <span className="spacer" />
        <Button variant="outline" disabled={!r} onClick={() => r && downloadCsv(r)}>
          导出 CSV
        </Button>
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
      <Card bordered title="教练课时">
        <DataTable
          rowKey="id"
          loading={loading}
          data={r ? coachRows(r) : []}
          empty="这个月没有课程"
          columns={[
            ...coachColumns
              .filter(([key]) => key !== 'payAmount' && key !== 'unrated')
              .map(([colKey, title]) => ({ colKey, title })),
            {
              colKey: 'pay',
              title: '课时费',
              width: 200,
              cell: ({ row }) => <PayCell row={row} />,
            },
          ]}
        />
        <div className="muted" style={{ marginTop: 8 }}>
          按上课日期统计已结束的课程。缺席计入已上课时，学员逾时取消不计入。
          {r && payNote(r.payRules)}
        </div>
      </Card>
    </Space>
  )
}

export function Reports() {
  const [tab, setTab] = useState('stats')
  // The monthly report loads when first opened, then keeps its month while switching back and forth.
  const [monthlyOpened, setMonthlyOpened] = useState(false)
  return (
    <Tabs
      value={tab}
      onChange={(v) => {
        setTab(String(v))
        if (v === 'monthly') setMonthlyOpened(true)
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
