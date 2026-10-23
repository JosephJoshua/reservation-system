import { Navbar } from 'tdesign-mobile-react'
import { ServiceStatus } from './ServiceStatus'

export function App() {
  return (
    <>
      <Navbar title="今日课程" fixed={false} />
      <main className="page">
        <ServiceStatus />
      </main>
    </>
  )
}
