import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { hashParam } from './hooks'

/** Fired after the address names another section of the page shown, without a page change. */
export const SHOW_SECTION = 'rs:show-section'

/** Tracks which section of a long form is on screen and scrolls to one. */
export function useSections<K extends string>(keys: readonly K[], ready: boolean) {
  const els = useRef(new Map<K, HTMLElement>())
  const [active, setActive] = useState<K | undefined>(keys[0])
  // The section last picked from the menu. It stays marked while the page scrolls to it, and after,
  // even when a short section at the end can't reach the top, until the page scrolls again.
  const picked = useRef<K | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: the keys are fixed for a page
  const refs = useMemo(
    () =>
      Object.fromEntries(
        keys.map((k) => [
          k,
          (el: HTMLElement | null) => {
            if (el) els.current.set(k, el)
            else els.current.delete(k)
          },
        ]),
      ) as Record<K, (el: HTMLElement | null) => void>,
    [],
  )

  const scrollTo = useCallback((key: K, smooth = true) => {
    const el = els.current.get(key)
    if (!el) return
    picked.current = key
    setActive(key)
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    el.scrollIntoView({ block: 'start', behavior: smooth && !reduce ? 'smooth' : 'auto' })
  }, [])

  useEffect(() => {
    if (!ready) return
    let frame = 0
    const measure = () => {
      frame = 0
      // A section picked from the menu stays marked while the page scrolls to it.
      if (picked.current) return
      let current = keys[0]
      for (const k of keys) {
        const el = els.current.get(k)
        // A section counts once it reaches where the menu scrolls it to, under the sticky header
        // and, on a phone, the chips.
        const top = el && Number.parseFloat(getComputedStyle(el).scrollMarginTop)
        if (el && el.getBoundingClientRect().top <= (top || 0) + 8) current = k
      }
      // At the bottom, the last sections can't reach the top, so the last one is marked.
      const atEnd = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2
      setActive(atEnd ? keys[keys.length - 1] : current)
    }
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    // Scrolling by hand, including with the scroll bar, lets go of the section picked.
    const letGo = () => {
      picked.current = null
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    window.addEventListener('wheel', letGo, { passive: true })
    window.addEventListener('touchmove', letGo, { passive: true })
    window.addEventListener('keydown', letGo)
    window.addEventListener('pointerdown', letGo)
    // Also once the menu's scroll has ended, so any later scroll, even by the scroll bar, counts.
    window.addEventListener('scrollend', letGo)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      window.removeEventListener('wheel', letGo)
      window.removeEventListener('touchmove', letGo)
      window.removeEventListener('keydown', letGo)
      window.removeEventListener('pointerdown', letGo)
      window.removeEventListener('scrollend', letGo)
    }
  }, [ready, keys])

  // A link such as `#/settings?section=pay` opens at that section, as does the ⌘K menu on the page.
  useEffect(() => {
    if (!ready) return
    const go = () => {
      const key = hashParam('section') as K | null
      if (key && keys.includes(key)) scrollTo(key, false)
    }
    go()
    window.addEventListener('hashchange', go)
    window.addEventListener(SHOW_SECTION, go)
    return () => {
      window.removeEventListener('hashchange', go)
      window.removeEventListener(SHOW_SECTION, go)
    }
  }, [ready, keys, scrollTo])

  return { refs, active, scrollTo }
}

export type Sections<K extends string> = ReturnType<typeof useSections<K>>

/**
 * The menu of a long form's sections: down the left on a wide screen, a row of chips under the
 * header on a phone. A dot marks a section with unsaved changes.
 */
export function SectionNav<K extends string>({
  sections,
  nav,
  dirty,
}: {
  sections: readonly { key: K; label: string }[]
  nav: Sections<K>
  dirty: ReadonlySet<K>
}) {
  const ref = useRef<HTMLElement>(null)
  // On a phone the chips scroll sideways; the one marked is kept in view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when another section is marked
  useEffect(() => {
    const row = ref.current
    const chip = row?.querySelector('[aria-current]')
    if (!row || !chip || row.scrollWidth <= row.clientWidth) return
    const r = row.getBoundingClientRect()
    const c = chip.getBoundingClientRect()
    row.scrollTo({ left: row.scrollLeft + c.left - r.left - (r.width - c.width) / 2 })
  }, [nav.active])

  return (
    <nav ref={ref} className="section-nav" aria-label="设置分区">
      {sections.map(({ key, label }) => (
        // Buttons, not links: picking a section scrolls the page and never leaves it.
        <button
          key={key}
          type="button"
          className="section-nav-item"
          aria-current={nav.active === key ? 'true' : undefined}
          onClick={() => nav.scrollTo(key)}
        >
          <span>{label}</span>
          {dirty.has(key) && <span className="section-nav-dot" role="img" aria-label="有修改" />}
        </button>
      ))}
    </nav>
  )
}
