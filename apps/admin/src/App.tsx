import { canOpenPage, type StaffDto } from '@rs/shared'
import type { ComponentType } from 'react'
import { useEffect, useState } from 'react'
import {
  AssignmentIcon,
  BillIcon,
  CalendarIcon,
  CardIcon,
  ChartBarIcon,
  CheckCircleIcon,
  CourseIcon,
  DashboardIcon,
  FilePasteIcon,
  HistoryIcon,
  ImageIcon,
  RollbackIcon,
  SettingIcon,
  UserCircleIcon,
  UsergroupIcon,
  UserIcon,
} from 'tdesign-icons-react'
import { Button, ConfigProvider, Drawer, Loading } from 'tdesign-react'
import zhCN from 'tdesign-react/es/locale/zh_CN'
import { api, getToken, handleUnauthorized, setToken } from './api'
import { CommandMenu } from './CommandMenu'
import { useApi, useIsPhone } from './hooks'
import { LessonDrawer, LessonPage } from './LessonDetail'
import { useLessonParam, withoutLesson } from './lessonLink'
import { MeContext, STAFF_CHANGED } from './me'
import { ActionLog } from './pages/ActionLog'
import { Bookings } from './pages/Bookings'
import { CheckIn } from './pages/CheckIn'
import { Coaches } from './pages/Coaches'
import { Courses } from './pages/Courses'
import { HomeContent } from './pages/HomeContent'
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
import { confirmLeave, hasUnsaved, leaveTo, takeLeave } from './SaveBar'
import { SHOW_SECTION } from './SectionNav'
import { StudentSearch } from './StudentSearch'
import { ThemeMenu } from './ThemeMenu'
import { useThemeMode } from './theme'

type Page = { label: string; icon: ComponentType; component: ComponentType }

const pages = {
  overview: { label: '概览', icon: DashboardIcon, component: Overview },
  schedule: { label: '日程', icon: CalendarIcon, component: Schedule },
  checkin: { label: '今日', icon: CheckCircleIcon, component: CheckIn },
  bookings: { label: '预约', icon: AssignmentIcon, component: Bookings },
  students: { label: '学员', icon: UsergroupIcon, component: Students },
  // Opened from lists and links, not from the menu.
  lessons: { label: '课程详情', icon: AssignmentIcon, component: LessonPage },
  orders: { label: '订单', icon: BillIcon, component: Orders },
  refunds: { label: '退款', icon: RollbackIcon, component: Refunds },
  invoices: { label: '发票', icon: FilePasteIcon, component: Invoices },
  reports: { label: '报表', icon: ChartBarIcon, component: Reports },
  courses: { label: '课程', icon: CourseIcon, component: Courses },
  coaches: { label: '教练', icon: UserIcon, component: Coaches },
  products: { label: '课时包', icon: CardIcon, component: Products },
  banners: { label: '首页内容', icon: ImageIcon, component: HomeContent },
  settings: { label: '设置', icon: SettingIcon, component: Settings },
  staff: { label: '员工', icon: UserCircleIcon, component: Staff },
  actions: { label: '操作记录', icon: HistoryIcon, component: ActionLog },
} satisfies Record<string, Page>

type PageKey = keyof typeof pages

/** The sidebar: daily front-desk work first, then money, then setup. */
const navGroups: { title?: string; keys: PageKey[] }[] = [
  { keys: ['overview'] },
  { title: '日常', keys: ['schedule', 'checkin', 'bookings', 'students'] },
  { title: '财务', keys: ['orders', 'refunds', 'invoices', 'reports'] },
  { title: '课程与内容', keys: ['courses', 'coaches', 'products', 'banners'] },
  { title: '系统', keys: ['settings', 'staff', 'actions'] },
]

const inMenu = (key: PageKey) => navGroups.some((g) => g.keys.includes(key))

function currentPage(): PageKey {
  // 课程与教练 became 课程 and 教练: an old link opens 课程.
  if (/^#\/?catalog(?=[?/]|$)/.test(window.location.hash)) {
    history.replaceState(history.state, '', '#/courses')
  }
  // 课后点评 became a tab of 预约.
  if (/^#\/?feedback(?=[?/]|$)/.test(window.location.hash)) {
    history.replaceState(history.state, '', '#/bookings?tab=feedback')
    window.dispatchEvent(new Event(SHOW_SECTION))
  }
  // The first part names the page, as in `#/students/12`.
  const key = window.location.hash.replace(/^#\/?/, '').split(/[?/]/)[0] ?? ''
  return key in pages ? (key as PageKey) : 'overview'
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
    // Leaving a page with unsaved changes asks first. Links ask before the address changes; the
    // back and forward buttons have already changed it, so it is put back while the admin decides
    // and the browser goes there again if they leave.
    let shown = window.location.hash
    let asked = false
    const onHash = async () => {
      const next = window.location.hash
      // Back where it is, so a pass to leave given for this move is not kept for a later one.
      if (next === shown) {
        takeLeave()
        return
      }
      // A lesson opened over the page leaves the page and its form as they are.
      if (hasUnsaved() && !takeLeave() && withoutLesson(next) !== withoutLesson(shown)) {
        const held = shown
        // Without the mark of an opened lesson, which belongs to the step it was set on.
        const { lessonOpened: _, ...state } = history.state ?? {}
        history.pushState(state, '', shown)
        if (asked) return
        asked = true
        const leave = await confirmLeave()
        asked = false
        // The page may have moved on meanwhile, such as after a save that was on its way.
        if (leave && window.location.hash === held) history.back()
        else takeLeave()
        return
      }
      // A pass to leave not needed for this move is not kept for a later one.
      takeLeave()
      shown = next
      setPage(currentPage())
    }
    const onClick = (e: MouseEvent) => {
      if (!hasUnsaved() || e.defaultPrevented || e.button !== 0) return
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      // Links that open a lesson over the page keep it, and its form, as they are.
      const link = (e.target as Element | null)?.closest?.('a[href^="#"]:not([data-overlay])')
      const href = link?.getAttribute('href')
      if (!href || href === window.location.hash) return
      // The link's own click handler (closing a dialog, say) waits for the answer too.
      e.preventDefault()
      e.stopPropagation()
      void leaveTo(href)
    }
    document.addEventListener('click', onClick, true)
    // Another section of the page shown is put in the address without a hashchange.
    const onSection = () => {
      shown = window.location.hash
    }
    window.addEventListener('hashchange', onHash)
    window.addEventListener(SHOW_SECTION, onSection)
    return () => {
      window.removeEventListener('hashchange', onHash)
      window.removeEventListener(SHOW_SECTION, onSection)
      document.removeEventListener('click', onClick, true)
    }
  }, [])

  // A new page starts at its top, as the content scrolls with the window.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the page changes
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [page])

  const logout = async () => {
    if (!(await confirmLeave())) return
    takeLeave()
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
  // A menu tap that first asked about unsaved changes closes the menu once the page changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the page changes
  useEffect(() => setMenuOpen(false), [requested])
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
  const lessonId = useLessonParam()
  // 课程详情 belongs with 预约 in the menu.
  const current = page === 'lessons' ? 'bookings' : page
  const Page = page ? pages[page].component : null
  // Groups whose pages the roles all leave out are left out too.
  const groups = navGroups
    .map((g) => ({ ...g, keys: g.keys.filter((key) => allowed.includes(key)) }))
    .filter((g) => g.keys.length > 0)

  const nav = (
    <nav className="admin-nav" aria-label="主菜单">
      {groups.map((group) => (
        <div className="nav-group" key={group.title ?? 'home'}>
          {group.title && <div className="nav-group-title">{group.title}</div>}
          {group.keys.map((key) => {
            const { label, icon: Icon } = pages[key]
            return (
              <a
                key={key}
                href={`#/${key}`}
                className={key === current ? 'nav-item active' : 'nav-item'}
                aria-current={key === current ? 'page' : undefined}
                // Closes the phone menu on every tap, the current page included.
                onClick={() => setMenuOpen(false)}
              >
                <Icon />
                <span>{label}</span>
              </a>
            )
          })}
        </div>
      ))}
    </nav>
  )

  return (
    <MeContext.Provider value={me.data}>
      <div className="admin-layout">
        {phone ? (
          <Drawer
            visible={menuOpen}
            placement="left"
            size="248px"
            header="Lumi乒乓 管理"
            footer={false}
            className="admin-menu-drawer"
            onClose={() => setMenuOpen(false)}
          >
            {nav}
          </Drawer>
        ) : (
          <aside className="admin-aside">
            <div className="admin-brand">Lumi乒乓 管理</div>
            {nav}
          </aside>
        )}
        <div className="admin-main">
          <header className="admin-header">
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
              {page && <span className="admin-title-text">{pages[page].label}</span>}
            </span>
            <span className="header-actions">
              {allowed.includes('students') && <StudentSearch compact={phone} />}
              {!phone && (
                <CommandMenu
                  pages={allowed.filter(inMenu).map((key) => ({
                    key,
                    label: pages[key].label,
                    group: navGroups.find((g) => g.keys.includes(key))?.title,
                  }))}
                />
              )}
              <ThemeMenu />
              {me.data && <span className="muted signed-in">{me.data.name}</span>}
              <Button variant="text" onClick={onLogout}>
                退出登录
              </Button>
            </span>
          </header>
          <main className="admin-content">
            {Page ? <Page /> : me.error ? <p className="muted">{me.error}</p> : <Loading />}
          </main>
          {lessonId && allowed.includes('lessons') && <LessonDrawer key={lessonId} id={lessonId} />}
        </div>
      </div>
    </MeContext.Provider>
  )
}
