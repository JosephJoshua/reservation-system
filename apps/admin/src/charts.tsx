import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

/*
 * Small SVG charts for the 报表 page. Colors come from the --viz-* tokens in app.css, which
 * follow the admin's light and dark modes. Every chart takes the same labels as its steps.
 */

export interface Series {
  name: string
  /** A --viz-* token. */
  color: string
  values: number[]
}

/** Width of an element, kept up to date. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(el.clientWidth)
    const observer = new ResizeObserver(() => setWidth(el.clientWidth))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return { ref, width }
}

/** Round tick values from 0 up to at least `max`. */
export function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0, 1]
  const raw = max / count
  const power = 10 ** Math.floor(Math.log10(raw))
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * power >= raw) ?? 10) * power
  const ticks: number[] = []
  for (let v = 0; v < max + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6)
  if ((ticks.at(-1) ?? 0) < max) ticks.push((ticks.at(-1) ?? 0) + step)
  return ticks
}

/** Which step labels fit under the x axis, at about `room` pixels each. */
function labelEvery(count: number, plotWidth: number, room = 44) {
  return Math.max(1, Math.ceil((count * room) / Math.max(plotWidth, 1)))
}

/** True when there is nothing to draw, so a chart shows its empty text instead. */
const blank = (series: Series[]) => series.every((s) => s.values.every((v) => v === 0))

const PLOT_HEIGHT = 180
const AXIS_BAND = 24
const LEFT = 52
const RIGHT = 12
const TOP = 8

export function Legend({ series, kind }: { series: Series[]; kind: 'line' | 'box' }) {
  if (series.length < 2) return null
  return (
    <div className="viz-legend">
      {series.map((s) => (
        <span key={s.name}>
          <i
            className={kind === 'line' ? 'viz-key-line' : 'viz-key-box'}
            style={{ background: `var(${s.color})` }}
          />
          {s.name}
        </span>
      ))}
    </div>
  )
}

function Tooltip({
  left,
  title,
  rows,
  width,
}: {
  left: number
  title: string
  rows: { name: string; color: string; value: string }[]
  width: number
}) {
  // Keeps the box inside the chart, flipping to the left of the pointer near the right edge.
  const flip = left > width / 2
  return (
    <div
      className="viz-tooltip"
      style={flip ? { right: width - left + 12 } : { left: left + 12 }}
      role="status"
    >
      <div className="viz-tooltip-title">{title}</div>
      {rows.map((r) => (
        <div key={r.name} className="viz-tooltip-row">
          <i className="viz-key-line" style={{ background: `var(${r.color})` }} />
          <strong>{r.value}</strong>
          <span>{r.name}</span>
        </div>
      ))}
    </div>
  )
}

interface PlotProps {
  labels: string[]
  empty: string
  series: Series[]
  format: (v: number) => string
  /** Axis ticks, shorter than `format`. */
  tick?: (v: number) => string
}

/** Keyboard and pointer state for "which step is the reader looking at". */
function useHover(count: number, plotWidth: number, stepOf: (x: number) => number) {
  const [index, setIndex] = useState<number | null>(null)
  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - box.left - LEFT
    if (x < -8 || x > plotWidth + 8) return setIndex(null)
    setIndex(Math.min(count - 1, Math.max(0, stepOf(x))))
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const delta = e.key === 'ArrowLeft' ? -1 : 1
    setIndex((i) => Math.min(count - 1, Math.max(0, (i ?? (delta > 0 ? -1 : count)) + delta)))
  }
  return {
    index,
    handlers: {
      onPointerMove,
      onPointerLeave: () => setIndex(null),
      onKeyDown,
      onBlur: () => setIndex(null),
      tabIndex: 0,
    },
  }
}

function Axes({
  ticks,
  y,
  labels,
  xOf,
  plotWidth,
  tick,
}: {
  ticks: number[]
  y: (v: number) => number
  labels: string[]
  xOf: (i: number) => number
  plotWidth: number
  tick: (v: number) => string
}) {
  const every = labelEvery(labels.length, plotWidth)
  return (
    <g className="viz-axes">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={LEFT} x2={LEFT + plotWidth} y1={y(t)} y2={y(t)} className="viz-grid" />
          <text x={LEFT - 8} y={y(t)} dy="0.32em" textAnchor="end">
            {tick(t)}
          </text>
        </g>
      ))}
      {labels.map((l, i) =>
        i % every === 0 ? (
          <text key={l} x={xOf(i)} y={TOP + PLOT_HEIGHT + 16} textAnchor="middle">
            {l}
          </text>
        ) : null,
      )}
    </g>
  )
}

/** Lines over time on one axis. A single series gets a light wash under it. */
export function LineChart({ labels, series, format, tick = format, empty }: PlotProps) {
  const { ref, width } = useWidth()
  const plotWidth = Math.max(0, width - LEFT - RIGHT)
  const max = Math.max(0, ...series.flatMap((s) => s.values))
  const ticks = niceTicks(max)
  const top = ticks.at(-1) ?? 1
  const y = (v: number) => TOP + PLOT_HEIGHT - (v / top) * PLOT_HEIGHT
  const step = labels.length > 1 ? plotWidth / (labels.length - 1) : 0
  const xOf = (i: number) => LEFT + (labels.length > 1 ? i * step : plotWidth / 2)
  const { index, handlers } = useHover(labels.length, plotWidth, (x) =>
    step ? Math.round(x / step) : 0,
  )
  const path = (values: number[]) =>
    values.map((v, i) => `${i ? 'L' : 'M'}${xOf(i).toFixed(1)},${y(v).toFixed(1)}`).join('')
  return (
    <div className="viz">
      {!blank(series) && <Legend series={series} kind="line" />}
      <div ref={ref} className="viz-plot">
        {blank(series) && <div className="viz-empty">{empty}</div>}
        {width > 0 && !blank(series) && (
          <svg
            width={width}
            height={TOP + PLOT_HEIGHT + AXIS_BAND}
            role="img"
            aria-label={series.map((s) => s.name).join('、')}
            {...handlers}
          >
            <Axes ticks={ticks} y={y} labels={labels} xOf={xOf} plotWidth={plotWidth} tick={tick} />
            {series.length === 1 && series[0] && (
              <path
                d={`${path(series[0].values)}L${xOf(labels.length - 1)},${y(0)}L${xOf(0)},${y(0)}Z`}
                style={{ fill: `var(${series[0].color})` }}
                className="viz-area"
              />
            )}
            {series.map((s) => (
              <path
                key={s.name}
                d={path(s.values)}
                className="viz-line"
                style={{ stroke: `var(${s.color})` }}
              />
            ))}
            {index !== null && (
              <g>
                <line
                  x1={xOf(index)}
                  x2={xOf(index)}
                  y1={TOP}
                  y2={TOP + PLOT_HEIGHT}
                  className="viz-crosshair"
                />
                {series.map((s) => (
                  <circle
                    key={s.name}
                    cx={xOf(index)}
                    cy={y(s.values[index] ?? 0)}
                    r={4}
                    className="viz-dot"
                    style={{ fill: `var(${s.color})` }}
                  />
                ))}
              </g>
            )}
          </svg>
        )}
        {index !== null && !blank(series) && (
          <Tooltip
            left={xOf(index)}
            width={width}
            title={labels[index] ?? ''}
            rows={series.map((s) => ({
              name: s.name,
              color: s.color,
              value: format(s.values[index] ?? 0),
            }))}
          />
        )}
      </div>
    </div>
  )
}

/** Columns per step; several series stack, the first at the bottom. */
export function ColumnChart({ labels, series, format, tick = format, empty }: PlotProps) {
  const { ref, width } = useWidth()
  const plotWidth = Math.max(0, width - LEFT - RIGHT)
  const totals = labels.map((_, i) => series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0))
  const ticks = niceTicks(Math.max(0, ...totals))
  const top = ticks.at(-1) ?? 1
  const h = (v: number) => (v / top) * PLOT_HEIGHT
  const band = labels.length ? plotWidth / labels.length : 0
  const barWidth = Math.max(2, Math.min(24, band - 2))
  const xOf = (i: number) => LEFT + band * i + band / 2
  const { index, handlers } = useHover(labels.length, plotWidth, (x) => Math.floor(x / band))
  return (
    <div className="viz">
      {!blank(series) && <Legend series={series} kind="box" />}
      <div ref={ref} className="viz-plot">
        {blank(series) && <div className="viz-empty">{empty}</div>}
        {width > 0 && !blank(series) && (
          <svg
            width={width}
            height={TOP + PLOT_HEIGHT + AXIS_BAND}
            role="img"
            aria-label={series.map((s) => s.name).join('、')}
            {...handlers}
          >
            <Axes
              ticks={ticks}
              y={(v) => TOP + PLOT_HEIGHT - h(v)}
              labels={labels}
              xOf={xOf}
              plotWidth={plotWidth}
              tick={tick}
            />
            {labels.map((label, i) => {
              let base = TOP + PLOT_HEIGHT
              const parts = series.map((s) => ({ s, v: s.values[i] ?? 0 })).filter((p) => p.v > 0)
              return (
                <g key={label} className={index === i ? 'viz-hover' : undefined}>
                  {parts.map(({ s, v }, j) => {
                    // A 2px gap between stacked parts, and a rounded end on the top one only.
                    const full = h(v)
                    const height = Math.max(1, j < parts.length - 1 ? full - 2 : full)
                    base -= full
                    const y = base + (full - height)
                    const r = j === parts.length - 1 ? Math.min(4, height / 2, barWidth / 2) : 0
                    const x = xOf(i) - barWidth / 2
                    const w = barWidth
                    const d = r
                      ? `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + height}Z`
                      : `M${x},${y + height}V${y}H${x + w}V${y + height}Z`
                    return <path key={s.name} d={d} style={{ fill: `var(${s.color})` }} />
                  })}
                </g>
              )
            })}
          </svg>
        )}
        {index !== null && !blank(series) && (
          <Tooltip
            left={xOf(index)}
            width={width}
            title={labels[index] ?? ''}
            rows={[...series].reverse().map((s) => ({
              name: s.name,
              color: s.color,
              value: format(s.values[index] ?? 0),
            }))}
          />
        )}
      </div>
    </div>
  )
}

/** Rows of label, a filled track for a share, and the numbers. */
export function MeterList({
  rows,
  empty,
}: {
  rows: {
    key: string | number
    label: string
    share: number | null
    value: string
    detail?: string
  }[]
  empty: string
}) {
  if (rows.length === 0) return <div className="viz-empty">{empty}</div>
  return (
    <div className="viz-meters">
      {rows.map((r) => (
        <div key={r.key} className="viz-meter">
          <div className="viz-meter-label" title={r.label}>
            {r.label}
          </div>
          <div className="viz-meter-track">
            {r.share !== null && (
              <div
                className="viz-meter-fill"
                style={{ width: `${Math.min(100, Math.max(0, r.share * 100))}%` }}
              />
            )}
          </div>
          <div className="viz-meter-value">
            <strong>{r.value}</strong>
            {r.detail && <span className="muted">{r.detail}</span>}
          </div>
        </div>
      ))}
    </div>
  )
}

/** A grid of cells shaded by value, from the lightest step at 0 to the darkest at `max`. */
export function Heatmap({
  rows,
  columns,
  cell,
  legend,
}: {
  rows: string[]
  columns: string[]
  /** The value and tooltip text of a cell, or null where there is nothing. */
  cell: (row: number, column: number) => { value: number; max: number; text: string } | null
  legend: ReactNode
}) {
  const [hover, setHover] = useState<{ text: string; row: number; column: number } | null>(null)
  return (
    <div className="viz">
      <div className="viz-heat-scroll">
        <div
          className="viz-heat"
          style={{ gridTemplateColumns: `32px repeat(${columns.length}, minmax(28px, 1fr))` }}
          onPointerLeave={() => setHover(null)}
        >
          <span />
          {columns.map((c) => (
            <span key={c} className="viz-heat-col">
              {c}
            </span>
          ))}
          {rows.map((r, i) => [
            <span key={r} className="viz-heat-row">
              {r}
            </span>,
            ...columns.map((c, j) => {
              const v = cell(i, j)
              const level = v && v.max > 0 ? Math.ceil((v.value / v.max) * 5) : 0
              const show = () => v && setHover({ text: `${r} ${c}：${v.text}`, row: i, column: j })
              return (
                <button
                  type="button"
                  key={`${r}-${c}`}
                  className={`viz-heat-cell${v ? ` viz-heat-${level}` : ' viz-heat-none'}${
                    hover?.row === i && hover.column === j ? ' viz-hover' : ''
                  }`}
                  aria-label={v ? `${r} ${c}：${v.text}` : `${r} ${c}：没有排课`}
                  tabIndex={v ? 0 : -1}
                  onPointerEnter={show}
                  onFocus={show}
                  onBlur={() => setHover(null)}
                />
              )
            }),
          ])}
        </div>
      </div>
      <div className="viz-heat-footer">
        <span className="muted">{hover ? hover.text : legend}</span>
        <span className="viz-heat-scale" aria-hidden>
          <span className="muted">少</span>
          {[1, 2, 3, 4, 5].map((l) => (
            <i key={l} className={`viz-heat-${l}`} />
          ))}
          <span className="muted">多</span>
        </span>
      </div>
    </div>
  )
}
