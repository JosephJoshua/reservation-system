import { defaultSettings, type HomeDto, rulesFor, type VenueSettings } from '@rs/shared'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { MoonIcon, SunnyIcon } from 'tdesign-icons-react'
import { Alert, Button, Loading, RadioGroup, Tooltip } from 'tdesign-react'
import { api } from '../api'
import type { Banner, Coach, CoachCategory, LessonType, PackageProduct } from '../types'
import {
  type Draft,
  draftId,
  hiddenReasons,
  type PreviewSource,
  studentCatalog,
  withDraft,
} from './data'
import { FRAME, PhoneFrame, type PreviewTheme } from './PhoneFrame'
import { BookScreen, CoachScreen, HomeScreen, PackagesScreen } from './screens'
import { pageStyles } from './styles'

/** Everything a student's pages are built from. Lists this login can't read come back empty. */
function usePreviewSource() {
  const [source, setSource] = useState<PreviewSource | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    const list = <T,>(path: string) => api<T[]>('GET', path).catch((): T[] => [])
    Promise.all([
      list<LessonType>('/admin/lesson-types'),
      list<Coach>('/admin/coaches'),
      list<CoachCategory>('/admin/coach-categories'),
      list<PackageProduct>('/admin/package-products'),
      list<Banner>('/admin/banners'),
      api<HomeDto>('GET', '/home'),
      api<VenueSettings>('GET', '/admin/settings').catch(() => null),
    ])
      .then(([types, coaches, categories, products, banners, home, settings]) => {
        if (!live) return
        setSource({
          types,
          coaches,
          categories,
          products,
          banners,
          home,
          payment: settings && {
            trialEnabled: settings.payment.trialEnabled,
            packagesEnabled: settings.payment.packagesEnabled,
          },
          rules: rulesFor(settings?.booking ?? defaultSettings.booking, null),
        })
      })
      .catch((e: Error) => live && setError(e.message))
    return () => {
      live = false
    }
  }, [])
  return { source, error }
}

/** The screens each kind of record shows up on, first one shown first. */
const screensFor: Record<Draft['kind'], { value: string; label: string }[]> = {
  coach: [
    { value: 'coach', label: '教练主页' },
    { value: 'home', label: '首页' },
  ],
  lessonType: [
    { value: 'home', label: '首页' },
    { value: 'book', label: '选择时间' },
  ],
  package: [{ value: 'packages', label: '课时包' }],
  banner: [{ value: 'home', label: '首页' }],
  home: [{ value: 'home', label: '首页' }],
}

function adminTheme(): PreviewTheme {
  return document.documentElement.getAttribute('theme-mode') === 'dark' ? 'dark' : 'light'
}

function subscribeAdminTheme(fn: () => void) {
  const observer = new MutationObserver(fn)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['theme-mode'] })
  return () => observer.disconnect()
}

/** Fits the phone to the width it is given and to `maxHeight`, never above its real size. */
function useFit(maxHeight: number) {
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState<number>(FRAME.width)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const zoom = Math.min(1, width / FRAME.width, maxHeight / FRAME.height)
  return { box, zoom: Math.max(0.5, Math.round(zoom * 100) / 100) }
}

/**
 * How `draft` looks in the mini program, on each page it appears on, with what would keep
 * students from seeing it. `maxHeight` caps the phone's height on screen.
 */
export function MiniProgramPreview({ draft, maxHeight }: { draft: Draft; maxHeight: number }) {
  const { source, error } = usePreviewSource()
  const screens = screensFor[draft.kind]
  const [screen, setScreen] = useState(screens[0]?.value ?? 'home')
  // Follows the admin's own theme until the switch here picks one.
  const followed = useSyncExternalStore(subscribeAdminTheme, adminTheme)
  const [picked, setTheme] = useState<PreviewTheme | null>(null)
  const theme = picked ?? followed
  const { box, zoom } = useFit(maxHeight)
  // The clock for sale prices and banner times, fixed while the preview is open.
  const [now] = useState(() => new Date())

  const view = useMemo(() => {
    if (!source) return null
    const merged = withDraft(source, draft)
    const id = draftId(draft)
    const banner = draft.kind === 'home' ? draft.bannerId : undefined
    return {
      merged,
      id,
      catalog: studentCatalog(
        merged,
        now,
        banner === undefined ? { kind: draft.kind, id } : { kind: 'banner', id: banner },
      ),
      reasons: hiddenReasons(merged, draft, now),
    }
  }, [source, draft, now])

  let page: {
    title: string
    tab?: boolean
    styles: string
    body: React.ReactNode
    note?: string
  } | null = null
  if (view && source) {
    const { catalog, id, merged } = view
    const venue = merged.home.venue
    if (screen === 'home') {
      page = {
        title: venue.name || 'Lumi乒乓',
        tab: true,
        styles: pageStyles.booking,
        body: (
          <HomeScreen
            catalog={catalog}
            venue={venue}
            notice={merged.home.notice ?? ''}
            noticeLinked={(merged.home.noticeLink?.linkKind ?? 'none') !== 'none'}
            bannerId={
              draft.kind === 'banner' ? id : draft.kind === 'home' ? draft.bannerId : undefined
            }
            focus={
              draft.kind === 'coach' || draft.kind === 'lessonType'
                ? { kind: draft.kind, id }
                : undefined
            }
          />
        ),
      }
    } else if (screen === 'coach' && draft.kind === 'coach') {
      page = {
        title: draft.form.name || '教练',
        styles: pageStyles.coachDetail,
        body: <CoachScreen catalog={catalog} coachId={id} profile={draft.form.profile} />,
      }
    } else if (screen === 'book' && draft.kind === 'lessonType') {
      page = {
        title: draft.form.name || '选择时间',
        styles: pageStyles.book,
        note: '时段来自排课，预览只显示课程和教练',
        body: <BookScreen catalog={catalog} lessonTypeId={id} now={now} />,
      }
    } else if (screen === 'packages') {
      page = {
        title: '课时包',
        styles: pageStyles.packages,
        body: <PackagesScreen catalog={catalog} highlight={id} />,
      }
    }
  }

  return (
    <div className="mp-preview">
      <div className="mp-preview-bar">
        {screens.length > 1 ? (
          <RadioGroup
            theme="button"
            variant="default-filled"
            value={screen}
            options={screens}
            onChange={(v) => setScreen(String(v))}
          />
        ) : (
          <span className="mp-preview-label">{screens[0]?.label}</span>
        )}
        <Tooltip content={theme === 'dark' ? '看浅色模式' : '看深色模式'}>
          <Button
            variant="text"
            shape="square"
            aria-label={theme === 'dark' ? '看浅色模式' : '看深色模式'}
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            {theme === 'dark' ? <SunnyIcon /> : <MoonIcon />}
          </Button>
        </Tooltip>
      </div>
      {view && view.reasons.length > 0 && (
        <Alert theme="warning" className="mp-preview-alert" message={view.reasons.join('；')} />
      )}
      <div className="mp-preview-stage" ref={box}>
        {error ? (
          <p className="muted">{error}</p>
        ) : !page ? (
          <Loading />
        ) : (
          <PhoneFrame
            title={page.title}
            theme={theme}
            tab={page.tab}
            pageStyles={page.styles}
            zoom={zoom}
            focusKey={`${screen}:${JSON.stringify(draft)}`}
          >
            {page.body}
          </PhoneFrame>
        )}
      </div>
      {page?.note && <p className="mp-preview-note">{page.note}</p>}
    </div>
  )
}
