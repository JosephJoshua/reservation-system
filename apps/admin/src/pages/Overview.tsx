import { Card } from 'tdesign-react'
import { useApi } from '../hooks'

interface Summary {
  upcomingBookings: number
  pendingPayments: number
  refundRequests: number
  failedRefunds: number
}

export function Overview() {
  const { data } = useApi<Summary>('/admin/summary')
  const items: [string, number | undefined, string][] = [
    ['待上课预约', data?.upcomingBookings, '#/bookings'],
    ['待支付', data?.pendingPayments, '#/bookings'],
    ['待审核退款', data?.refundRequests, '#/refunds'],
    ['退款失败', data?.failedRefunds, '#/refunds'],
  ]
  return (
    <div className="stat-grid">
      {items.map(([label, value, href]) => (
        <a key={label} href={href} style={{ textDecoration: 'none' }}>
          <Card bordered hoverShadow>
            <div className="muted">{label}</div>
            <div className="stat">{value ?? '-'}</div>
          </Card>
        </a>
      ))}
    </div>
  )
}
