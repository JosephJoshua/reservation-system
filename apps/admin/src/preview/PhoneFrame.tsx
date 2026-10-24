import bookingDarkActive from '@mp/assets/tab/booking-dark-active.png'
import bookingLightActive from '@mp/assets/tab/booking-light-active.png'
import lessonsDark from '@mp/assets/tab/lessons-dark-normal.png'
import lessonsLight from '@mp/assets/tab/lessons-light-normal.png'
import profileDark from '@mp/assets/tab/profile-dark-normal.png'
import profileLight from '@mp/assets/tab/profile-light-normal.png'
import nativeTheme from '@mp/theme.json'
import { type ReactNode, useEffect, useRef } from 'react'
import { baseStyles } from './styles'

export type PreviewTheme = 'light' | 'dark'

/** The phone's screen, in CSS px: an iPhone with a notch. */
const SCREEN = { width: 375, height: 812, status: 44, nav: 44, tabBar: 49, homeBar: 34 }
export const FRAME = { width: SCREEN.width + 20, height: SCREEN.height + 20 }

const tabIcons = {
  light: [bookingLightActive, lessonsLight, profileLight],
  dark: [bookingDarkActive, lessonsDark, profileDark],
}

const base = Object.values(baseStyles).join('\n')

/**
 * A phone showing one mini program page: the native status, navigation and tab bars drawn here,
 * the page itself in the mini program's own styles. `tab` is for the 预约 tab, which has the tab
 * bar and no back button. Scrolls the element marked data-preview-focus into view.
 */
export function PhoneFrame({
  title,
  theme,
  tab,
  pageStyles,
  zoom = 1,
  focusKey,
  children,
}: {
  title: string
  theme: PreviewTheme
  tab?: boolean
  /** The page's own wxss, as CSS. */
  pageStyles: string
  zoom?: number
  /** Changes when what is previewed changes, which brings the marked element back into view. */
  focusKey: string
  children: ReactNode
}) {
  const colors = nativeTheme[theme]
  const scroller = useRef<HTMLDivElement>(null)
  const viewport =
    SCREEN.height - SCREEN.status - SCREEN.nav - (tab ? SCREEN.tabBar + SCREEN.homeBar : 0)

  // Each edit brings the edited part back into view; scrolling the phone otherwise stays put.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when focusKey changes
  useEffect(() => {
    const box = scroller.current
    const target = box?.querySelector<HTMLElement>('[data-preview-focus]')
    if (!box || !target) return
    const top = target.offsetTop - box.clientHeight / 2 + target.offsetHeight / 2
    box.scrollTo({ top: Math.max(0, top) })
  }, [focusKey])

  return (
    <div
      className={`mp-phone mp-phone-${theme}`}
      style={{ zoom, width: FRAME.width, height: FRAME.height }}
      role="img"
      aria-label={`小程序预览：${title}`}
    >
      <style>{base}</style>
      <style>{pageStyles}</style>
      <div className="mp-screen" style={{ background: colors.bgColor }}>
        <div
          className="mp-native-top"
          style={{
            background: colors.navBgColor,
            color: colors.navTextStyle === 'white' ? '#ffffff' : '#000000',
          }}
        >
          <div className="mp-status" style={{ height: SCREEN.status }}>
            <span className="mp-status-time">9:41</span>
            <span className="mp-status-icons" aria-hidden>
              <svg viewBox="0 0 18 12" width="18" height="12" aria-hidden>
                <rect x="0" y="8" width="3" height="4" rx="1" fill="currentColor" />
                <rect x="5" y="5.5" width="3" height="6.5" rx="1" fill="currentColor" />
                <rect x="10" y="3" width="3" height="9" rx="1" fill="currentColor" />
                <rect x="15" y="0" width="3" height="12" rx="1" fill="currentColor" />
              </svg>
              <svg viewBox="0 0 26 12" width="26" height="12" aria-hidden>
                <rect
                  x="0.5"
                  y="0.5"
                  width="22"
                  height="11"
                  rx="3"
                  fill="none"
                  stroke="currentColor"
                  opacity="0.4"
                />
                <rect x="2" y="2" width="19" height="8" rx="2" fill="currentColor" />
                <rect
                  x="24"
                  y="4"
                  width="1.5"
                  height="4"
                  rx="0.75"
                  fill="currentColor"
                  opacity="0.4"
                />
              </svg>
            </span>
          </div>
          <div className="mp-nav" style={{ height: SCREEN.nav }}>
            {!tab && (
              <svg className="mp-nav-back" viewBox="0 0 12 24" width="12" height="24" aria-hidden>
                <path
                  d="M10 3 2 12l8 9"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
            <div className="mp-nav-title">{title}</div>
            <div className={`mp-capsule mp-capsule-${theme}`} aria-hidden>
              <span className="mp-capsule-more">
                <i />
                <i />
                <i />
              </span>
              <span className="mp-capsule-divider" />
              <span className="mp-capsule-close" />
            </div>
          </div>
        </div>
        {/* Transformed, so the page's position: fixed bars stay inside the phone. */}
        <div className="mp-viewport" style={{ height: viewport }}>
          <div className="mp-scroller" ref={scroller}>
            <div
              className={`mp-page mp-${theme}`}
              style={
                {
                  '--mp-vh': `${viewport / 100}px`,
                  '--mp-safe-bottom': tab ? '0px' : `${SCREEN.homeBar}px`,
                } as React.CSSProperties
              }
            >
              <div className={`theme-root theme-${theme}`}>{children}</div>
            </div>
          </div>
        </div>
        {tab && (
          <div
            className="mp-tabbar"
            style={{
              background: colors.tabBgColor,
              borderTopColor:
                colors.tabBorderStyle === 'white' ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.12)',
              height: SCREEN.tabBar + SCREEN.homeBar,
            }}
          >
            {['预约', '课程', '我的'].map((label, i) => (
              <div
                key={label}
                className="mp-tab"
                style={{ color: i === 0 ? colors.tabSelectedColor : colors.tabColor }}
              >
                <img src={tabIcons[theme][i]} alt="" />
                <span>{label}</span>
              </div>
            ))}
          </div>
        )}
        <div className={`mp-home-bar mp-home-bar-${theme}`} />
      </div>
    </div>
  )
}
