import { useEffect, useState } from 'react'
import { Button, ConfigProvider, Drawer, Layout, Menu } from 'tdesign-react'
import zhCN from 'tdesign-react/es/locale/zh_CN'
import { api, getToken, handleUnauthorized, setToken } from './api'
import { useApi, useIsPhone } from './hooks'
import { ActionLog } from './pages/ActionLog'
import { Banners } from './pages/Banners'
import { Bookings } from './pages/Bookings'
import { Catalog } from './pages/Catalog'
import { Invoices } from './pages/Invoices'
import { Login } from './pages/Login'
import { Orders } from './pages/Orders'
import { Overview } from './pages/Overview'
import { Products } from './pages/Products'
import { Refunds } from './pages/Refunds'
import { Reports } from './pages/Reports'
import { Schedule } from './pages/Schedule'
import { Settings } from './pages/Settings'
import { STAFF_CHANGED, Staff } from './pages/Staff'
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
  invoices: ['发票', Invoices],
  reports: ['报表', Reports],
  banners: ['首页内容', Banners],
  settings: ['设置', Settings],
  staff: ['员工', Staff],
  actions: ['操作记录', ActionLog],
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
  // Set when the API turned the session away, so the login page can say why it is back.
  const [expired, setExpired] = useState(false)
  const phone = useIsPhone()
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    handleUnauthorized(() => {
      setAuthed(false)
      setExpired(true)
    })
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

  const menu = (
    <Menu
      value={page}
      width="100%"
      onChange={(v) => {
        window.location.hash = `/${String(v)}`
      }}
    >
      {Object.entries(pages).map(([key, [label]]) => (
        // Closes the phone menu on every tap, the current page included.
        <Menu.MenuItem key={key} value={key} onClick={() => setMenuOpen(false)}>
          {label}
        </Menu.MenuItem>
      ))}
    </Menu>
  )

  return (
    <ConfigProvider globalConfig={zhCN}>
      {!authed ? (
        <Login
          notice={expired ? '登录已过期，请重新登录' : undefined}
          onDone={() => {
            setAuthed(true)
            setExpired(false)
          }}
        />
      ) : (
        <Layout className="admin-layout">
          {phone ? (
            <Drawer
              visible={menuOpen}
              placement="left"
              size="240px"
              header="球馆管理"
              footer={false}
              className="admin-menu-drawer"
              onClose={() => setMenuOpen(false)}
            >
              {menu}
            </Drawer>
          ) : (
            <Layout.Aside width="200px" className="admin-aside">
              <div className="admin-brand">球馆管理</div>
              {menu}
            </Layout.Aside>
          )}
          <Layout className="admin-main">
            <Layout.Header className="admin-header">
              <span className="admin-title">
                {phone && (
                  <Button
                    variant="text"
                    shape="square"
                    aria-label="菜单"
                    className="admin-menu-button"
                    onClick={() => setMenuOpen(true)}
                  >
                    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                      <path
                        d="M4 6h16M4 12h16M4 18h16"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                      />
                    </svg>
                  </Button>
                )}
                {pages[page][0]}
              </span>
              <span className="header-actions">
                <SignedIn />
                <Button variant="text" onClick={logout}>
                  退出登录
                </Button>
              </span>
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

/** The signed-in staff member's name, so a shared front-desk computer shows whose session it is. */
function SignedIn() {
  const { data, reload } = useApi<{ name: string }>('/admin/me')
  useEffect(() => {
    const onChange = () => void reload()
    window.addEventListener(STAFF_CHANGED, onChange)
    return () => window.removeEventListener(STAFF_CHANGED, onChange)
  }, [reload])
  return data ? <span className="muted signed-in">{data.name}</span> : null
}
