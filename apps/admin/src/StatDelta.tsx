/** A change against an earlier figure, such as 比上月同期 ↑12%, or the earlier figure itself when it is 0. */
export function Delta({
  now,
  before,
  label,
  format = String,
}: {
  now: number
  before: number
  label: string
  format?: (v: number) => string
}) {
  if (before <= 0 || now < 0) return <div className="stat-sub">{`${label} ${format(before)}`}</div>
  const change = Math.round(((now - before) / before) * 100)
  return (
    <div className="stat-sub">
      {label}{' '}
      <span className={change > 0 ? 'delta-up' : change < 0 ? 'delta-down' : undefined}>
        {change > 0 ? '↑' : change < 0 ? '↓' : ''}
        {change === 0 ? '持平' : `${Math.abs(change)}%`}
      </span>
    </div>
  )
}
