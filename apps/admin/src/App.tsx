import { useEffect, useState } from 'react'
import { Button, ConfigProvider, Layout, Menu } from 'tdesign-react'
import zhCN from 'tdesign-react/es/locale/zh_CN'
import { api, getToken, handleUnauthorized, setToken } from './api'
import { Banners } from './pages/Banners'
import { Bookings } from './pages/Bookings'
import { Catalog } from './pages/Catalog'
import { Login } from './pages/Login'
import { Orders } from './pages/Orders'
import { Overview } from './pages/Overview'
import { Products } from './pages/Products'
import { Refunds } from './pages/Refunds'
import { Reports } from './pages/Reports'
import { Schedule } from './pages/Schedule'
import { Settings } from './pages/Settings'
import { Students } from './pages/Students'

const pages = {
  overview: ['概览', Overview],
  schedule: ['排课', Schedule],
  bookings: ['预约', Bookings],
  students: ['学员', Students],
  catalog: ['课程与教练', Catalog],
  products: ['课时包', Products],
  orders: ['订单', Orders],
  refunds: ['退款', Refunds],
  reports: ['报表', Reports],
  banners: ['首页内容', Banners],
  settings: ['设置', Settings],
} as const

type PageKey = keyof typeof pages

function currentPage(): PageKey {
  const key = window.location.hash.replace(/^#\/?/, '').split('?')[0] ?? ''
  return key in pages ? (key as PageKey) : 'overview'
}

/** Follows the system light or dark preference. */
function useThemeMode() {
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () =>
      document.documentElement.setAttribute('theme-mode', media.matches ? 'dark' : 'light')
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [])
}

export function App() {
  useThemeMode()
  const [authed, setAuthed] = useState(() => !!getToken())
  const [page, setPage] = useState<PageKey>(currentPage)

  useEffect(() => {
    handleUnauthorized(() => setAuthed(false))
    const onHash = () => setPage(currentPage())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const logout = async () => {
    await api('POST', '/admin/logout').catch(() => {})
    setToken(null)
    setAuthed(false)
  }

  const Page = pages[page][1]

  return (
    <ConfigProvider globalConfig={zhCN}>
      {!authed ? (
        <Login onDone={() => setAuthed(true)} />
      ) : (
        <Layout className="admin-layout">
          <Layout.Aside width="200px" className="admin-aside">
            <div className="admin-brand">球馆管理</div>
            <Menu
              value={page}
              width="200px"
              onChange={(v) => {
                window.location.hash = `/${String(v)}`
              }}
            >
              {Object.entries(pages).map(([key, [label]]) => (
                <Menu.MenuItem key={key} value={key}>
                  {label}
                </Menu.MenuItem>
              ))}
            </Menu>
          </Layout.Aside>
          <Layout className="admin-main">
            <Layout.Header className="admin-header">
              <span>{pages[page][0]}</span>
              <Button variant="text" onClick={logout}>
                退出登录
              </Button>
            </Layout.Header>
            <Layout.Content className="admin-content">
              <Page />
            </Layout.Content>
          </Layout>
        </Layout>
      )}
    </ConfigProvider>
  )
}
