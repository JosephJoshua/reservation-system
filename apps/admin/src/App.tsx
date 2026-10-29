import { canOpenPage, type StaffDto } from '@rs/shared'
import type { ComponentType } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
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
import { Button, ConfigProvider, Dialog, Drawer, Loading } from 'tdesign-react'
import zhCN from 'tdesign-react/es/locale/zh_CN'
import { AccountMenu, ReLogin } from './AccountMenu'
import {
  getToken,
  handleUnauthorized,
  holdRequests,
  onTokenChange,
  releaseRequests,
  setToken,
} from './api'
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
import {
  confirmLeave,
  hasUnsaved,
  leaveTo,
  lessonHasUnsaved,
  markTyped,
  passLeave,
  takeLeave,
} from './SaveBar'
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
  if (key in pages) return key as PageKey
  // An address of no page, as from a mistyped link, is put right to the 概览 shown.
  if (key) {
    history.replaceState(history.state, '', '#/overview')
    window.dispatchEvent(new Event(SHOW_SECTION))
  }
  return 'overview'
}

/** Whose login `token` is, or null when it can't be told, such as with no answer in 5 seconds. */
function whoIs(token: string): Promise<StaffDto | null> {
  // Not AbortSignal.timeout, which older Safari lacks.
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 5000)
  return fetch('/api/admin/me', {
    headers: { Authorization: `Bearer ${token}` },
    signal: abort.signal,
  })
    .then((res) => (res.ok ? (res.json() as Promise<StaffDto>) : null))
    .catch(() => null)
    .finally(() => clearTimeout(timer))
}

export function App() {
  useThemeMode()
  const [authed, setAuthed] = useState(() => !!getToken())
  const [page, setPage] = useState<PageKey>(currentPage)
  // Why the login page is back, such as an expired session.
  const [notice, setNotice] = useState<string>()
  const phone = useIsPhone()
  // Who is signed in, once known, for logging in again over the page.
  const signedIn = useRef<StaffDto | null>(null)
  // Counts this tab's logins and logouts, so work begun in one session can tell it has ended.
  const session = useRef(0)
  // The session ended while working: asks for the password over the page. `header` and `other`
  // say why when it was another tab, and what the other button does instead of 换个账号登录.
  const [relogin, setRelogin] = useState<{
    me: StaffDto
    done: (ok: boolean) => void
    header?: string
    other?: { label: string; run: () => void }
  } | null>(null)
  const pending = useRef(relogin)
  pending.current = relogin
  // The login this tab acts with. The token is shared by the browser's tabs, so another tab may
  // have put someone else's there meanwhile.
  const ownToken = useRef(getToken())

  // While the tab asks who it acts as, its requests wait rather than go out with whatever login
  // the browser now holds; they go once that is settled, or fail if the tab signed out.
  useEffect(() => {
    if (relogin) holdRequests()
    else releaseRequests(authed)
  }, [relogin, authed])

  const rememberMe = useCallback((me: StaffDto | null) => {
    signedIn.current = me
  }, [])

  /** Back to the login page, which says why. Another account's login, from another tab, stays. */
  const signOut = (why?: string) => {
    pending.current?.done(false)
    setRelogin(null)
    if (getToken() === ownToken.current) setToken(null)
    ownToken.current = null
    signedIn.current = null
    session.current++
    setAuthed(false)
    setNotice(why)
  }

  /** Acts as the login the browser now holds, put there by another tab. */
  const follow = () => {
    ownToken.current = getToken()
    window.dispatchEvent(new Event(STAFF_CHANGED))
  }

  /**
   * Another tab logged in as `now`, not `me` this tab was working as, or as someone this tab
   * could not tell (null): asks whether to log in again as `me`, keeping what is not saved, or go
   * on as the new login. Replaces an open question, such as after that tab first logged out, and
   * answers whatever waited on it.
   */
  const askSwitch = (me: StaffDto, now: StaffDto | null) => {
    const before = pending.current
    setRelogin({
      me,
      header: now ? `其他标签页登录了${now.name}的账号` : '其他标签页重新登录了',
      done: (ok) => {
        if (before) before.done(ok)
        else setRelogin(null)
      },
      other: {
        label: now ? `以${now.name}继续` : '以新登录继续',
        run: async () => {
          if (!(await confirmLeave())) return
          takeLeave()
          // That account logged out meanwhile, and the question changed to say so.
          if (!pending.current?.other) return
          // Changes held while asking were made as before: they are not sent as the new account.
          releaseRequests(false)
          // The question as it is now: a request turned away meanwhile may have joined it.
          pending.current.done(false)
          follow()
        },
      },
    })
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: registered once, reading refs
  useEffect(() => {
    // The API turned the session away. Nothing on the page is lost: the staff member logs in
    // again over it and the request goes again. Before anyone is known, it is the login page.
    handleUnauthorized(
      () =>
        new Promise<boolean>((resolve) => {
          const me = signedIn.current
          if (!me) {
            signOut('登录已过期，请重新登录')
            resolve(false)
            return
          }
          // Already asking, as after another tab logged out: the same question answers both.
          const open = pending.current
          if (open) {
            setRelogin({
              ...open,
              done: (ok) => {
                open.done(ok)
                resolve(ok)
              },
            })
            return
          }
          setRelogin({
            me,
            done: (ok) => {
              setRelogin(null)
              resolve(ok)
            },
          })
        }),
      () => signOut('账号已停用，请联系管理员'),
    )
    // Another tab of this browser logged in or out: the token is shared, so this tab follows,
    // and SignedInApp says so if that made it someone else. Changes not saved here are not
    // dropped on the way: the staff member logs in again over the page, or chooses to follow.
    const offToken = onTokenChange((token) => {
      if (!token) {
        const me = signedIn.current
        if (me && hasUnsaved()) {
          const open = pending.current
          if (!open) {
            setRelogin({ me, header: '已在其他标签页退出登录', done: () => setRelogin(null) })
          } else if (open.other) {
            // Asked about another account, which has since logged out too: nobody to go on as.
            setRelogin({ ...open, header: '已在其他标签页退出登录', other: undefined })
          }
          return
        }
        if (signedIn.current || pending.current) signOut('已在其他标签页退出登录')
        else setAuthed(false)
        return
      }
      setAuthed(true)
      setNotice(undefined)
      const asked = pending.current
      if (!asked) {
        void followAccount(token)
        return
      }
      // Asking for the password here: logged in again there as the same person, this tab
      // carries on too. Someone else is asked about: back as before, or on as them.
      void whoIs(token).then((now) => {
        const open = pending.current
        if (!now || !open || getToken() !== token) return
        if (now.id === open.me.id) {
          ownToken.current = token
          open.done(true)
        } else askSwitch(open.me, now)
      })
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
      // A lesson opened or closed over the page leaves the page and its form as they are, but
      // closing one drops what was typed in its dialogs.
      const lessonOnly = withoutLesson(next) === withoutLesson(shown)
      if ((lessonOnly ? lessonHasUnsaved() : hasUnsaved()) && !takeLeave()) {
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
      // A link that drops the form on purpose, such as opening the student a phone belongs to.
      if (link?.hasAttribute('data-discard')) {
        passLeave()
        return
      }
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
      offToken()
      window.removeEventListener('hashchange', onHash)
      window.removeEventListener(SHOW_SECTION, onSection)
      document.removeEventListener('click', onClick, true)
    }
  }, [])

  /**
   * Another tab logged in: this tab acts as that account from now on. Someone else, with changes
   * not saved here, asks first: logging in again here as before keeps them.
   */
  const followAccount = async (token: string) => {
    const me = signedIn.current
    if (!me || !hasUnsaved()) return follow()
    // Nothing goes out as the new login until it is known whose it is.
    holdRequests()
    // Changed again meanwhile, or asked already: the later change or the open question decides.
    const settled = () => getToken() !== token || !!pending.current
    // This tab logged out, or in again, meanwhile: what was held belonged to that session.
    // Not the account object, which each reload of who is signed in replaces.
    const started = session.current
    const left = () => session.current !== started
    let now = await whoIs(token)
    // Not told, as on a network blip: tried again a moment later, then asked.
    for (const wait of [1000, 3000]) {
      if (now || settled() || left()) break
      await new Promise((resolve) => setTimeout(resolve, wait))
      if (settled() || left()) break
      now = await whoIs(token)
    }
    if (left()) {
      if (!pending.current) releaseRequests(false)
      return
    }
    if (settled()) return
    if (now?.id === me.id) {
      releaseRequests(true)
      return follow()
    }
    // Someone else, or not known whom: changes held meanwhile are never sent as them unasked.
    askSwitch(me, now)
  }

  // A new page starts at its top, as the content scrolls with the window.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the page changes
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [page])

  const logout = async () => {
    if (!(await confirmLeave())) return
    takeLeave()
    // Not through api(): an ended session needs no logging in again just to log out. Only this
    // tab's own login is ended, never one another tab put in its place.
    const token = getToken() === ownToken.current ? getToken() : null
    await fetch('/api/admin/logout', {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }).catch(() => {})
    signOut()
  }

  return (
    <ConfigProvider globalConfig={zhCN}>
      {!authed ? (
        <Login
          notice={notice}
          onDone={() => {
            ownToken.current = getToken()
            session.current++
            setAuthed(true)
            setNotice(undefined)
          }}
        />
      ) : (
        <SignedInApp
          page={page}
          phone={phone}
          onLogout={logout}
          onMe={rememberMe}
          onRedirect={() => setPage(currentPage())}
        />
      )}
      {authed && relogin && (
        <ReLogin
          me={relogin.me}
          header={relogin.header}
          otherLabel={relogin.other?.label}
          onDone={async (ok) => {
            if (ok) {
              ownToken.current = getToken()
              relogin.done(true)
              // Roles may have changed meanwhile.
              window.dispatchEvent(new Event(STAFF_CHANGED))
              return
            }
            if (relogin.other) {
              relogin.other.run()
              return
            }
            // Another account: the page and anything unsaved on it go.
            if (!(await confirmLeave())) return
            takeLeave()
            signOut()
          }}
        />
      )}
    </ConfigProvider>
  )
}

function SignedInApp({
  page: requested,
  phone,
  onLogout,
  onMe,
  onRedirect,
}: {
  page: PageKey
  phone: boolean
  onLogout: () => void
  onMe: (me: StaffDto | null) => void
  /** The page shown is not the one in the address, which was put right. */
  onRedirect: () => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  // A menu tap that first asked about unsaved changes closes the menu once the page changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the page changes
  useEffect(() => setMenuOpen(false), [requested])
  const me = useApi<StaffDto>('/admin/me')
  const { reload } = me
  // Another tab logged in as someone else: said once, as the page now acts as them.
  const seen = useRef<number | null>(null)
  const [switched, setSwitched] = useState<string | null>(null)
  // Counts account changes, so the page starts over as the new account, its forms emptied.
  const [account, setAccount] = useState(0)
  useEffect(() => {
    if (!me.data) return
    onMe(me.data)
    if (seen.current !== null && seen.current !== me.data.id) {
      setSwitched(me.data.name)
      setAccount((n) => n + 1)
    }
    seen.current = me.data.id
  }, [me.data, onMe])
  // biome-ignore lint/correctness/useExhaustiveDependencies: forgets the account on leaving
  useEffect(() => () => onMe(null), [])
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
  // The address names the page shown, so a reload or a copied link opens it too.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the page shown changes
  useEffect(() => {
    if (!me.data || !page || page === requested) return
    history.replaceState(history.state, '', `#/${page}`)
    window.dispatchEvent(new Event(SHOW_SECTION))
    onRedirect()
  }, [me.data, page, requested])
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
              <AccountMenu me={me.data} onLogout={onLogout} />
            </span>
          </header>
          {/* Typing or a choice in the page's dialogs counts as unsaved when leaving the page. */}
          <main
            className="admin-content"
            onInputCapture={(e) => markTyped(e.nativeEvent)}
            onClickCapture={(e) => markTyped(e.nativeEvent)}
            onKeyDownCapture={(e) => markTyped(e.nativeEvent)}
          >
            {Page ? (
              <Page key={account} />
            ) : me.error ? (
              <p className="muted">{me.error}</p>
            ) : (
              <Loading />
            )}
          </main>
          {lessonId && allowed.includes('lessons') && (
            // Typing or a choice in the lesson's dialogs counts as unsaved when it closes or the
            // page changes.
            <div
              className="lesson-scope"
              onInputCapture={(e) => markTyped(e.nativeEvent, 'lesson')}
              onClickCapture={(e) => markTyped(e.nativeEvent, 'lesson')}
              onKeyDownCapture={(e) => markTyped(e.nativeEvent, 'lesson')}
            >
              <LessonDrawer key={lessonId} id={lessonId} />
            </div>
          )}
        </div>
      </div>
      {switched && (
        <Dialog
          visible
          header="账号已切换"
          cancelBtn={null}
          confirmBtn="知道了"
          onConfirm={() => setSwitched(null)}
          onClose={() => setSwitched(null)}
        >
          <p>{`这个浏览器的其他标签页登录了${switched}的账号，此页面现在也以${switched}的身份操作，请核对后再继续。`}</p>
        </Dialog>
      )}
    </MeContext.Provider>
  )
}
