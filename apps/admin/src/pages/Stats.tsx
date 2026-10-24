import {
  DORMANT_DAYS,
  type DormantStudent,
  daysBetween,
  STATS_MAX_DAYS,
  type StatsReport,
} from '@rs/shared'
import { type ReactNode, useState } from 'react'
import { Button, Card, DateRangePicker, MessagePlugin, Radio } from 'tdesign-react'
import { ColumnChart, Heatmap, LineChart, MeterList, type Series } from '../charts'
import { DataTable, LoadMore } from '../DataTable'
import { addDays, fmtDate, today, yuanGrouped as yuan } from '../format'
import { useApi, usePagedApi } from '../hooks'
import { Delta } from '../StatDelta'
import { StudentCell } from '../StudentCell'

type Range = [string, string]

const presets: { key: string; label: string; range: () => Range }[] = [
  { key: '7', label: '近7天', range: () => [addDays(today(), -6), today()] },
  { key: '30', label: '近30天', range: () => [addDays(today(), -29), today()] },
  { key: '90', label: '近90天', range: () => [addDays(today(), -89), today()] },
  { key: 'month', label: '本月', range: () => [`${today().slice(0, 7)}-01`, today()] },
  {
    key: 'last',
    label: '上月',
    range: () => {
      const first = `${today().slice(0, 7)}-01`
      const end = addDays(first, -1)
      return [`${end.slice(0, 7)}-01`, end]
    },
  },
  { key: 'year', label: '今年', range: () => [`${today().slice(0, 4)}-01-01`, today()] },
]

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
const percent = (part: number, whole: number) =>
  whole > 0 ? `${Math.round((part / whole) * 100)}%` : '-'
const hours = (minutes: number) => `${Math.round((minutes / 60) * 10) / 10}`

/** ¥ on the axis, in 万 from ten thousand up. */
function yuanTick(fen: number) {
  const y = fen / 100
  if (y >= 10000) return `¥${Math.round((y / 10000) * 10) / 10}万`
  return `¥${Math.round(y)}`
}

/** A chart in a card, with a switch to the same numbers as a table. */
function ChartCard({
  title,
  note,
  table,
  children,
}: {
  title: string
  note?: string
  table?: { columns: { colKey: string; title: string }[]; rows: Record<string, string | number>[] }
  children: ReactNode
}) {
  const [asTable, setAsTable] = useState(false)
  return (
    <Card
      bordered
      title={title}
      actions={
        table && (
          <Button variant="text" size="small" onClick={() => setAsTable(!asTable)}>
            {asTable ? '图表' : '数据'}
          </Button>
        )
      }
    >
      {asTable && table ? (
        <DataTable rowKey="key" data={table.rows} columns={table.columns} maxHeight={320} />
      ) : (
        children
      )}
      {note && (
        <div className="muted" style={{ marginTop: 8 }}>
          {note}
        </div>
      )}
    </Card>
  )
}

function seriesTable(labels: string[], series: Series[], format: (v: number) => string) {
  return {
    columns: [
      { colKey: 'label', title: '时间' },
      ...series.map((s, i) => ({ colKey: `s${i}`, title: s.name })),
    ],
    rows: labels.map((label, i) => ({
      key: label,
      label,
      ...Object.fromEntries(series.map((s, j) => [`s${j}`, format(s.values[i] ?? 0)])),
    })),
  }
}

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

function BusyTimes({ cells, empty }: { cells: StatsReport['heatmap']; empty: string }) {
  if (cells.length === 0) return <div className="viz-empty">{empty}</div>
  const first = Math.min(...cells.map((c) => c.hour))
  const last = Math.max(...cells.map((c) => c.hour))
  const hoursShown = Array.from({ length: last - first + 1 }, (_, i) => first + i)
  const byKey = new Map(cells.map((c) => [`${c.weekday}:${c.hour}`, c]))
  const max = Math.max(...cells.map((c) => c.booked))
  return (
    <Heatmap
      rows={WEEKDAYS}
      columns={hoursShown.map((h) => `${h}点`)}
      cell={(row, column) => {
        const c = byKey.get(`${row}:${hoursShown[column]}`)
        if (!c) return null
        return {
          value: c.booked,
          max,
          text: `已约 ${c.booked} 节 / 开放 ${c.offered} 节`,
        }
      }}
      legend="点按格子看数字。"
    />
  )
}

function Dormant() {
  const list = usePagedApi<DormantStudent>('/admin/reports/dormant', 'offset')
  return (
    <Card bordered title="沉睡学员">
      <DataTable
        rowKey="key"
        loading={list.loading && !list.loaded}
        data={list.rows.map((d) => ({ ...d, key: d.student.id }))}
        empty={list.error ?? `没有超过 ${DORMANT_DAYS} 天未上课的学员`}
        columns={[
          {
            colKey: 'student',
            title: '学员',
            cell: ({ row }) => <StudentCell student={row.student} />,
          },
          { colKey: 'lessonsLeft', title: '剩余课时', cell: ({ row }) => `${row.lessonsLeft} 节` },
          {
            colKey: 'lastLessonAt',
            title: '最近上课',
            cell: ({ row }) => (row.lastLessonAt ? fmtDate(row.lastLessonAt) : '还没上过课'),
          },
          { colKey: 'expiresAt', title: '课时包到期', cell: ({ row }) => fmtDate(row.expiresAt) },
        ]}
      />
      <LoadMore
        shown={list.rows.length}
        more={list.more}
        loading={list.loading}
        onMore={list.loadMore}
      />
      <div className="muted" style={{ marginTop: 8 }}>
        截至今天，有剩余课时、{DORMANT_DAYS} 天内没上课也没有预约的学员，不受上方日期影响。
      </div>
    </Card>
  )
}

export function Stats() {
  const [preset, setPreset] = useState('30')
  const [range, setRange] = useState<Range>(() => presets[1]?.range() ?? [today(), today()])
  const days = daysBetween(range[0], range[1])
  const prev: Range = [addDays(range[0], -days), addDays(range[0], -1)]
  const { data, loading, error } = useApi<StatsReport>(
    `/admin/reports/stats?from=${range[0]}&to=${range[1]}`,
  )
  const before = useApi<StatsReport>(`/admin/reports/stats?from=${prev[0]}&to=${prev[1]}`).data
  // While a new range loads, the old figures stay up, dimmed; after a failed load they go.
  // The API cuts the range at its own today, which can be a day behind this browser's clock.
  const current = data?.from === range[0] && data.to <= range[1]
  const r = current || loading ? data : null
  const b = current && before?.from === prev[0] ? before : null

  const pick = (key: string) => {
    const p = presets.find((x) => x.key === key)
    if (!p) return
    setPreset(key)
    setRange(p.range())
  }

  const labels = r?.buckets.map((x) => x.label) ?? []
  const revenue: Series[] = r
    ? [
        { name: '收款', color: '--viz-1', values: r.revenue.paid },
        { name: '课消', color: '--viz-2', values: r.revenue.consumed },
      ]
    : []
  const lessons: Series[] = r ? [{ name: '上课节数', color: '--viz-1', values: r.lessons }] : []
  const learners: Series[] = r
    ? [
        { name: '老学员', color: '--viz-1', values: r.students.returning },
        { name: '新学员', color: '--viz-2', values: r.students.new },
      ]
    : []
  const liability: Series[] = r
    ? [{ name: '预收未上课时', color: '--viz-1', values: r.packages.liability }]
    : []
  const net = (x: StatsReport) => sum(x.revenue.paid) - sum(x.revenue.refunded)
  const marked = r ? r.attendance.attended + r.attendance.noShow : 0
  const maxSale = Math.max(0, ...(r?.packages.sales.map((s) => s.amount) ?? []))
  const people = (n: number) => `${n} 人`
  const grainNote = r ? { day: '按天', week: '按周', month: '按月' }[r.grain] : ''
  // Before the first figures arrive, a chart says so rather than that there is nothing.
  const none = (text: string) => (r ? text : error ? '加载失败' : '加载中…')

  return (
    <div className="stats-body">
      <div className="toolbar" style={{ marginBottom: 0 }}>
        <Radio.Group
          className="range-presets"
          variant="default-filled"
          value={preset}
          onChange={(v) => pick(String(v))}
        >
          {presets.map((p) => (
            <Radio.Button key={p.key} value={p.key}>
              {p.label}
            </Radio.Button>
          ))}
        </Radio.Group>
        <DateRangePicker
          allowInput
          clearable={false}
          value={range}
          disableDate={{ after: today() }}
          onChange={(v) => {
            const [from, picked] = (v as string[]).map(String)
            if (!from || !picked) return
            // A typed date can get past the disabled days; nothing after today has happened.
            const to = [picked, today()].sort()[0] ?? picked
            if (from > to) return
            if (daysBetween(from, to) > STATS_MAX_DAYS) {
              void MessagePlugin.warning(`最多统计 ${STATS_MAX_DAYS} 天`)
              return
            }
            setPreset('')
            setRange([from, to])
          }}
        />
      </div>
      {error && <div className="danger-text">{error}</div>}

      <div className={loading && r ? 'stats-body reloading' : 'stats-body'}>
        <div className="stat-grid kpi-grid">
          <Card bordered>
            <div className="muted">净收款</div>
            <div className="stat">{r ? yuan(net(r)) : '-'}</div>
            {b && r ? (
              <Delta now={net(r)} before={net(b)} label="比上一周期" format={yuan} />
            ) : (
              <div className="stat-sub">-</div>
            )}
          </Card>
          <Card bordered>
            <div className="muted">课消</div>
            <div className="stat">{r ? yuan(sum(r.revenue.consumed)) : '-'}</div>
            {b && r ? (
              <Delta
                now={sum(r.revenue.consumed)}
                before={sum(b.revenue.consumed)}
                label="比上一周期"
                format={yuan}
              />
            ) : (
              <div className="stat-sub">-</div>
            )}
          </Card>
          <Card bordered>
            <div className="muted">上课</div>
            <div className="stat">{r ? `${sum(r.lessons)} 节` : '-'}</div>
            {b && r ? (
              <Delta
                now={sum(r.lessons)}
                before={sum(b.lessons)}
                label="比上一周期"
                format={(v) => `${v} 节`}
              />
            ) : (
              <div className="stat-sub">-</div>
            )}
          </Card>
          <Card bordered>
            <div className="muted">上课学员</div>
            <div className="stat">
              {r ? people(r.students.total.new + r.students.total.returning) : '-'}
            </div>
            <div className="stat-sub">{r ? `新学员 ${r.students.total.new} 人` : '-'}</div>
          </Card>
          <Card bordered>
            <div className="muted">到课率</div>
            <div className="stat">{r ? percent(r.attendance.attended, marked) : '-'}</div>
            <div className="stat-sub">
              {r ? `缺席 ${r.attendance.noShow} 次，未签到 ${r.attendance.unmarked} 次` : '-'}
            </div>
          </Card>
          <Card bordered>
            <div className="muted">续费率</div>
            <div className="stat">{r ? percent(r.renewal.renewed, r.renewal.ended) : '-'}</div>
            <div className="stat-sub">
              {r ? `用完或到期 ${r.renewal.ended} 个，续买 ${r.renewal.renewed} 个` : '-'}
            </div>
          </Card>
        </div>

        <ChartCard
          title="收入趋势"
          note={`${grainNote}统计。收款按付款时间，未扣退款；课消是已上和逾时取消的课的价值，课时包按单节均价计。`}
          table={seriesTable(labels, revenue, yuan)}
        >
          <LineChart
            empty={none('这段时间没有收款和上课')}
            labels={labels}
            series={revenue}
            format={yuan}
            tick={yuanTick}
          />
        </ChartCard>

        <div className="chart-grid">
          <ChartCard
            title="上课节数"
            note="已结束的课，小班课每节计一节。"
            table={seriesTable(labels, lessons, (v) => `${v} 节`)}
          >
            <ColumnChart
              empty={none('这段时间没有上课')}
              labels={labels}
              series={lessons}
              format={(v) => `${v} 节`}
              tick={String}
            />
          </ChartCard>
          <ChartCard
            title="上课学员"
            note="新学员指第一次上课的学员。"
            table={seriesTable(labels, learners, people)}
          >
            <ColumnChart
              empty={none('这段时间没有学员上课')}
              labels={labels}
              series={learners}
              format={people}
              tick={String}
            />
          </ChartCard>
        </div>

        <div className="chart-grid">
          <ChartCard title="教练排课占用" note="已结束的排课中被约的小时数，教练关闭的空时段不计。">
            <MeterList
              empty={none('这段时间没有排课')}
              rows={(r?.coaches ?? []).map((c) => ({
                key: c.id,
                label: c.name,
                share: c.offeredMinutes ? c.bookedMinutes / c.offeredMinutes : null,
                value: percent(c.bookedMinutes, c.offeredMinutes),
                detail: `${hours(c.bookedMinutes)} / ${hours(c.offeredMinutes)} 小时`,
              }))}
            />
          </ChartCard>
          <ChartCard title="热门时段" note="按开课时间统计已结束的排课。">
            <BusyTimes cells={r?.heatmap ?? []} empty={none('这段时间没有排课')} />
          </ChartCard>
        </div>

        <div className="chart-grid">
          <ChartCard title="课时包销售" note="按付款时间统计。">
            <MeterList
              empty={none('这段时间没有卖出课时包')}
              rows={(r?.packages.sales ?? []).map((s) => ({
                key: s.productId,
                label: s.name,
                share: maxSale ? s.amount / maxSale : 0,
                value: yuan(s.amount),
                detail: `${s.count} 个`,
              }))}
            />
          </ChartCard>
          <ChartCard
            title="预收未上课时"
            note="每段结束时课时包里还没用的课时，按单节均价计。"
            table={seriesTable(labels, liability, yuan)}
          >
            <LineChart
              empty={none('这段时间没有预收课时')}
              labels={labels}
              series={liability}
              format={yuan}
              tick={yuanTick}
            />
          </ChartCard>
        </div>

        <ChartCard title="小班课满班率" note="已结束的小班课里，约满的座位占比。">
          <MeterList
            empty={none('这段时间没有小班课')}
            rows={(r?.groups ?? []).map((g) => ({
              key: g.lessonTypeId,
              label: g.name,
              share: g.seats ? g.booked / g.seats : null,
              value: percent(g.booked, g.seats),
              detail: `${g.sessions} 节，${g.booked}/${g.seats} 座`,
            }))}
          />
        </ChartCard>
      </div>

      <Dormant />
    </div>
  )
}
