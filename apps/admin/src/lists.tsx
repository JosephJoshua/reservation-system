import { venueInstant } from '@rs/shared'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { FilterIcon } from 'tdesign-icons-react'
import { Button, DateRangePicker, Drawer, Input, MessagePlugin, Pagination } from 'tdesign-react'
import { apiPage, RequestError } from './api'
import { useIsPhone } from './hooks'
import { SHOW_SECTION } from './SectionNav'

/** Rows per page to pick from; the first is where a new admin starts. */
const SIZES = [20, 50, 100]
const SIZE_KEY = 'rs:page-size'

function savedSize() {
  try {
    const n = Number(localStorage.getItem(SIZE_KEY))
    if (SIZES.includes(n)) return n
  } catch {}
  return SIZES[0] as number
}

// Parts of the address that belong to the page rather than to a list on it: its tab, a lesson
// open over it, a student's drawer.
const KEEP = ['tab', 'lesson', 'id']

type Values = Record<string, string>
type Valid<D> = Partial<Record<keyof D, (v: string) => boolean>>
type State<D> = { values: D; page: number }

function hashParts() {
  const [path, query] = window.location.hash.split('?')
  return { path: path ?? '', params: new URLSearchParams(query ?? '') }
}

/** The address shown with some of its query changed; null takes a key out. */
export function hashWith(patch: Record<string, string | null>) {
  const { path, params } = hashParts()
  for (const [key, v] of Object.entries(patch)) {
    if (v === null) params.delete(key)
    else params.set(key, v)
  }
  const query = params.toString()
  return `${path}${query ? `?${query}` : ''}`
}

function readHash<D extends Values>(defaults: D, valid: Valid<D>): State<D> {
  const { params } = hashParts()
  const values = { ...defaults }
  for (const key of Object.keys(defaults) as (keyof D & string)[]) {
    const v = params.get(key)
    if (v !== null && (valid[key]?.(v) ?? true)) values[key] = v as D[typeof key]
  }
  const page = Number(params.get('page'))
  return { values, page: Number.isSafeInteger(page) && page > 1 ? page : 1 }
}

const same = <D extends Values>(a: State<D>, b: State<D>) =>
  a.page === b.page && Object.keys(a.values).every((k) => a.values[k] === b.values[k])

/** Checks for filter values read from the address. */
export const isDay = (v: string) => {
  const t = Date.parse(`${v}T00:00:00Z`)
  // Also turns down a day that does not exist, such as 02-30.
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(t) && new Date(t).toISOString().startsWith(v)
  )
}
export const isId = (v: string) => /^[1-9]\d{0,8}$/.test(v)
/** One of the values, or empty for 全部, as `status=` on a list whose default is a status. */
export const oneOf =
  (...values: string[]) =>
  (v: string) =>
    v === '' || values.includes(v)

/**
 * A list's filters and page. With `path`, as in `#/orders`, they live in the address too, so a
 * refresh, a copied link or the way back from a detail page shows the same rows; a link to the
 * page without them, such as from the menu, starts over. Values are strings, '' for 全部, and
 * only those that differ from `defaults` are put in the address. A list in a tab writes the
 * address only while `active`.
 */
export function useListFilters<D extends Values>(
  initial: D,
  {
    path,
    active = true,
    valid = {},
    always = [],
  }: {
    path?: string
    active?: boolean
    valid?: Valid<D>
    /** Keys put in the address even at their default, such as a range from today. */
    always?: (keyof D & string)[]
  } = {},
) {
  // The defaults as the page opened, such as a date range from today.
  const [defaults] = useState(initial)
  const [state, setState] = useState<State<D>>(() =>
    path && active && hashParts().path === path
      ? readHash(defaults, valid)
      : { values: defaults, page: 1 },
  )
  const [size, setSizeState] = useState(savedSize)
  const validRef = useRef(valid)
  validRef.current = valid
  const alwaysRef = useRef(always)
  alwaysRef.current = always

  // Puts them in the address, keeping what else is there, without a step for back.
  useEffect(() => {
    if (!path || !active) return
    const { path: shown, params: old } = hashParts()
    if (shown !== path) return
    const params = new URLSearchParams()
    for (const key of KEEP) {
      const v = old.get(key)
      if (v !== null) params.set(key, v)
    }
    for (const [key, v] of Object.entries(state.values)) {
      if (v !== defaults[key] || alwaysRef.current.includes(key)) params.set(key, v)
    }
    if (state.page > 1) params.set('page', String(state.page))
    const query = params.toString()
    const next = `${path}${query ? `?${query}` : ''}`
    if (next === window.location.hash) return
    history.replaceState(history.state, '', next)
    window.dispatchEvent(new Event(SHOW_SECTION))
  }, [path, active, state, defaults])

  // A link to the page, such as from the menu or the overview, while it is open.
  useEffect(() => {
    if (!path || !active) return
    const on = () => {
      if (hashParts().path !== path) return
      const next = readHash(defaults, validRef.current)
      setState((old) => (same(old, next) ? old : next))
    }
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [path, active, defaults])

  /** Changes some filters, back to the first page. */
  const set = useCallback((patch: Partial<D>) => {
    setState((old) => ({ values: { ...old.values, ...patch }, page: 1 }))
  }, [])
  const setPage = useCallback((page: number) => {
    setState((old) => (old.page === page ? old : { ...old, page }))
  }, [])
  const setSize = useCallback((n: number) => {
    try {
      localStorage.setItem(SIZE_KEY, String(n))
    } catch {}
    setSizeState(n)
    setState((old) => ({ ...old, page: 1 }))
  }, [])
  const reset = useCallback(
    (keys?: (keyof D)[]) => {
      setState((old) => {
        const values = { ...old.values }
        for (const k of keys ?? (Object.keys(defaults) as (keyof D)[])) values[k] = defaults[k]
        return { values, page: 1 }
      })
    },
    [defaults],
  )
  const changed = (keys: (keyof D)[]) => keys.filter((k) => state.values[k] !== defaults[k]).length

  return {
    values: state.values,
    page: state.page,
    size,
    defaults,
    set,
    setPage,
    setSize,
    reset,
    changed,
  }
}

export type ListFilters = Pick<
  ReturnType<typeof useListFilters>,
  'page' | 'size' | 'setPage' | 'setSize'
>

/**
 * Loads one page of a list with how many rows match in all. Rows stay on screen while another
 * page loads. `reload` fetches the page shown again, such as after a change to one of its rows;
 * a page that is no longer there, after rows left it, moves to the last one.
 */
export function usePagedList<T>(path: string | null, { page, size, setPage }: ListFilters) {
  const [rows, setRows] = useState<T[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  // The first page has arrived, so an empty list means there is nothing rather than not yet.
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)
  const shown = useRef(0)
  shown.current = rows.length

  const url = path
    ? `${path}${path.includes('?') ? '&' : '?'}limit=${size}&offset=${(page - 1) * size}`
    : null

  const fetchPage = useCallback(
    async (quiet: boolean) => {
      if (!url) return
      const mine = ++seq.current
      if (!quiet) setLoading(true)
      try {
        const res = await apiPage<T>(url)
        if (mine !== seq.current) return
        const last = Math.max(1, Math.ceil(res.total / size))
        if (page > last) {
          setPage(last)
          return
        }
        setRows(res.rows)
        setTotal(res.total)
        setError(null)
        setLoaded(true)
      } catch (e) {
        if (mine !== seq.current) return
        const message = e instanceof RequestError ? e.message : '加载失败'
        setError(message)
        // With rows on screen the table's empty text never shows, so say it here.
        if (shown.current) void MessagePlugin.error(message)
      } finally {
        if (mine === seq.current) setLoading(false)
      }
    },
    [url, page, size, setPage],
  )

  useEffect(() => {
    void fetchPage(false)
  }, [fetchPage])

  const reload = useCallback(() => fetchPage(true), [fetchPage])

  return { rows, setRows, total, loading, loaded, error, reload }
}

/**
 * Page numbers under a list, with the rows per page and a total. On a phone, 上一页 and 下一页
 * with the page between them. A new page scrolls the list back to its top.
 */
export function Pager({
  list,
  filters,
}: {
  list: { total: number; loaded: boolean }
  filters: ListFilters
}) {
  const phone = useIsPhone()
  const ref = useRef<HTMLDivElement>(null)
  const { total } = list
  const { page, size, setPage, setSize } = filters
  if (!list.loaded || total === 0) return null
  const pages = Math.ceil(total / size)
  const go = (n: number) => {
    setPage(n)
    // The list's top, if it has scrolled away.
    const top = ref.current?.closest('.paged-list')
    if (top && top.getBoundingClientRect().top < 0) top.scrollIntoView({ block: 'start' })
  }
  if (phone) {
    return (
      <div className="pager pager-phone" ref={ref}>
        <Button variant="outline" disabled={page <= 1} onClick={() => go(page - 1)}>
          上一页
        </Button>
        <span className="pager-count">
          {page} / {pages} 页<span className="muted">共 {total} 条</span>
        </span>
        <Button variant="outline" disabled={page >= pages} onClick={() => go(page + 1)}>
          下一页
        </Button>
      </div>
    )
  }
  return (
    <div className="pager" ref={ref}>
      <Pagination
        total={total}
        current={page}
        pageSize={size}
        pageSizeOptions={SIZES}
        showJumper={pages > 7}
        // A new page size also moves the page into range; setSize already went back to page 1.
        onCurrentChange={(n, info) => info.pageSize === size && go(n)}
        onPageSizeChange={setSize}
      />
    </div>
  )
}

/** One filter. In the phone's filter sheet it gets its label above it. */
export function Filter({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="filter" data-label={label}>
      {children}
    </div>
  )
}

/**
 * A list's filters over it. `main` stay in sight; on a phone `more` go in a sheet behind 筛选,
 * which counts those set, unless `inline` (for one or two). 清除筛选 shows while any of `more`
 * is set.
 */
export function FilterBar({
  main,
  more,
  inline = false,
  set,
  onClear,
  actions,
}: {
  main?: ReactNode
  more?: ReactNode
  inline?: boolean
  /** How many of `more` are set. */
  set: number
  onClear: () => void
  actions?: ReactNode
}) {
  const phone = useIsPhone()
  const [open, setOpen] = useState(false)
  return (
    <div className="toolbar filter-bar">
      {main}
      {phone && more && !inline ? (
        <>
          <Button
            variant="outline"
            theme={set ? 'primary' : 'default'}
            icon={<FilterIcon />}
            onClick={() => setOpen(true)}
          >
            {set ? `筛选 · ${set}` : '筛选'}
          </Button>
          <Drawer
            visible={open}
            placement="bottom"
            size="auto"
            header="筛选"
            className="filter-sheet"
            onClose={() => setOpen(false)}
            footer={
              <>
                <Button variant="outline" disabled={!set} onClick={onClear}>
                  清除筛选
                </Button>
                <Button theme="primary" onClick={() => setOpen(false)}>
                  完成
                </Button>
              </>
            }
          >
            <div className="filter-sheet-body">{more}</div>
          </Drawer>
        </>
      ) : (
        <>
          {more}
          {set > 0 && (
            <Button variant="text" theme="primary" onClick={onClear}>
              清除筛选
            </Button>
          )}
        </>
      )}
      {actions && <div className="toolbar-actions">{actions}</div>}
    </div>
  )
}

/** A search box that filters as it is typed, a moment after the last key. */
export function SearchInput({
  value,
  onChange,
  placeholder = '学员姓名、手机号或编号',
  width = 220,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  width?: number
}) {
  const [text, setText] = useState(value)
  const send = useRef(onChange)
  send.current = onChange
  // Cleared or set from outside, such as by 清除筛选 or a link.
  const sent = useRef(value)
  if (value !== sent.current) {
    sent.current = value
    if (text.trim() !== value) setText(value)
  }
  useEffect(() => {
    const trimmed = text.trim()
    if (trimmed === sent.current) return
    const timer = setTimeout(() => {
      // Enter may have sent it already.
      if (trimmed === sent.current) return
      sent.current = trimmed
      send.current(trimmed)
    }, 300)
    return () => clearTimeout(timer)
  }, [text])
  const now = () => {
    if (text.trim() === sent.current) return
    sent.current = text.trim()
    send.current(text.trim())
  }
  return (
    <Input
      className="filter-search"
      style={{ width }}
      clearable
      // The API takes up to 30 characters.
      maxlength={30}
      placeholder={placeholder}
      value={text}
      onChange={(v) => setText(String(v))}
      onEnter={now}
      // Leaving the box, such as to open a row, keeps what was typed in the address.
      onBlur={now}
    />
  )
}

/** Adds a range of venue dates, both included, as the instants the API takes. */
export function setRange(params: URLSearchParams, from: string, to: string) {
  if (!from || !to) return
  const [a, b] = from <= to ? [from, to] : [to, from]
  params.set('from', venueInstant(a, 0).toISOString())
  params.set('to', venueInstant(b, 24 * 60).toISOString())
}

/** A range of dates a list may leave open, as 下单日期 on 订单. */
export function DateFilter({
  from,
  to,
  placeholder,
  onChange,
}: {
  from: string
  to: string
  placeholder: [string, string]
  onChange: (from: string, to: string) => void
}) {
  return (
    <DateRangePicker
      style={{ width: 260 }}
      clearable
      placeholder={placeholder}
      // A link may give the dates either way round; setRange reads them in order too.
      value={from && to ? [from, to].sort() : []}
      onChange={(v) => (v[0] && v[1] ? onChange(String(v[0]), String(v[1])) : onChange('', ''))}
    />
  )
}
