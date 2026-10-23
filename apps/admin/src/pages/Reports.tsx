import { useState } from 'react'
import { Button, Card, DatePicker, Space } from 'tdesign-react'
import { DataTable } from '../DataTable'
import { today, yuan } from '../format'
import { useApi } from '../hooks'

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
  }[]
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
] as const

function coachRows(report: MonthlyReport) {
  return report.coaches.map((c) => ({ ...c, hours: hours(c.minutes) }))
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

export function Reports() {
  const [month, setMonth] = useState(today().slice(0, 7))
  const { data, loading, error } = useApi<MonthlyReport>(`/admin/reports/monthly?month=${month}`)
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
          columns={coachColumns.map(([colKey, title]) => ({ colKey, title }))}
        />
        <div className="muted" style={{ marginTop: 8 }}>
          按上课日期统计已结束的课程。缺席照常计课；学员逾时取消不计入已上课时。
        </div>
      </Card>
    </Space>
  )
}
