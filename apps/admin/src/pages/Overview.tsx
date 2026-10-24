import { Card } from 'tdesign-react'
import { useApi } from '../hooks'

interface Summary {
  upcomingBookings: number
  pendingPayments: number
  refundRequests: number
  failedRefunds: number
  offlineRefundsOwed: number
}

export function Overview() {
  const { data, error } = useApi<Summary>('/admin/summary')
  const items: [string, number | undefined, string][] = [
    ['待上课预约', data?.upcomingBookings, '#/bookings?status=confirmed'],
    ['待支付', data?.pendingPayments, '#/bookings?status=pending_payment'],
    ['待审核退款', data?.refundRequests, '#/refunds?status=requested'],
    ['待线下退还', data?.offlineRefundsOwed, '#/refunds?status=pending'],
    ['退款失败', data?.failedRefunds, '#/refunds?status=failed'],
  ]
  if (error) return <p className="muted">{error}</p>
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
