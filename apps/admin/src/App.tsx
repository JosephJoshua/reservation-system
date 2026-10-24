import { canOpenPage, type StaffDto } from '@rs/shared'
import { useEffect, useState } from 'react'
import { Button, ConfigProvider, Drawer, Layout, Loading, Menu } from 'tdesign-react'
import zhCN from 'tdesign-react/es/locale/zh_CN'
import { api, getToken, handleUnauthorized, setToken } from './api'
import { useApi, useIsPhone } from './hooks'
import { MeContext, STAFF_CHANGED } from './me'
import { ActionLog } from './pages/ActionLog'
import { Banners } from './pages/Banners'
import { Bookings } from './pages/Bookings'
import { Catalog } from './pages/Catalog'
import { Feedback } from './pages/Feedback'
import { Invoices } from './pages/Invoices'
import { Login } from './pages/Login'
import { Orders } from './pages/Orders'
import { Overview } from './pages/Overview'
import { Products } from './pages/Products'
import { Refunds } from './pages/Refunds'
import { Reports } from './pages/Reports'
import { Schedule } from './pages/Schedule'
import { Settings } from './pages/Settings'
import { Staff } from './pages/Staff'
import { Students } from './pages/Students'

const pages = {
  overview: ['概览', Overview],
  schedule: ['排课', Schedule],
  bookings: ['预约', Bookings],
  students: ['学员', Students],
  feedback: ['课后点评', Feedback],
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
        <SignedInApp page={page} phone={phone} onLogout={logout} />
      )}
    </ConfigProvider>
  )
}

function SignedInApp({
  page: requested,
  phone,
  onLogout,
}: {
  page: PageKey
  phone: boolean
  onLogout: () => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const me = useApi<StaffDto>('/admin/me')
  const { reload } = me
  useEffect(() => {
    const onChange = () => void reload()
    window.addEventListener(STAFF_CHANGED, onChange)
    // Also on each page change, so a role another 管理员 changed applies without logging out.
    window.addEventListener('hashchange', onChange)
    return () => {
      window.removeEventListener(STAFF_CHANGED, onChange)
      window.removeEventListener('hashchange', onChange)
    }
  }, [reload])

  const roles = me.data?.roles ?? []
  const allowed = (Object.keys(pages) as PageKey[]).filter((key) => canOpenPage(roles, key))
  // A page the roles do not cover, such as from an old link, opens the first one they do.
  const page = allowed.includes(requested) ? requested : allowed[0]
  const Page = page ? pages[page][1] : null

  const menu = (
    <Menu
      value={page}
      width="100%"
      onChange={(v) => {
        window.location.hash = `/${String(v)}`
      }}
    >
      {allowed.map((key) => (
        // Closes the phone menu on every tap, the current page included.
        <Menu.MenuItem key={key} value={key} onClick={() => setMenuOpen(false)}>
          {pages[key][0]}
        </Menu.MenuItem>
      ))}
    </Menu>
  )

  return (
    <MeContext.Provider value={me.data}>
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
              {page && pages[page][0]}
            </span>
            <span className="header-actions">
              {me.data && <span className="muted signed-in">{me.data.name}</span>}
              <Button variant="text" onClick={onLogout}>
                退出登录
              </Button>
            </span>
          </Layout.Header>
          <Layout.Content className="admin-content">
            {Page ? <Page /> : me.error ? <p className="muted">{me.error}</p> : <Loading />}
          </Layout.Content>
        </Layout>
      </Layout>
    </MeContext.Provider>
  )
}
