import { healthResponse } from '@rs/shared'
import { useEffect, useState } from 'react'
import { Tag } from 'tdesign-mobile-react'

type Status = 'checking' | 'ok' | 'down'

export function ServiceStatus() {
  const [status, setStatus] = useState<Status>('checking')

  useEffect(() => {
    fetch('/api/health')
      .then((res) => res.json())
      .then((body) => setStatus(healthResponse.safeParse(body).success ? 'ok' : 'down'))
      .catch(() => setStatus('down'))
  }, [])

  if (status === 'checking') return <Tag variant="light">正在连接服务</Tag>
  if (status === 'ok')
    return (
      <Tag theme="success" variant="light">
        服务正常
      </Tag>
    )
  return (
    <Tag theme="danger" variant="light">
      无法连接服务
    </Tag>
  )
}
