import { useEffect, useId, useRef, useState } from 'react'
import { SearchIcon } from 'tdesign-icons-react'
import { Button, Input, type InputRef } from 'tdesign-react'
import { api } from './api'
import { leaveTo } from './SaveBar'
import type { StudentRow } from './types'

const LIMIT = 8

/**
 * Finds a student by name or phone from any page and opens their details, the front desk's most
 * common first step. On a phone it starts as an icon and opens over the header.
 */
export function StudentSearch({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(!compact)
  const [q, setQ] = useState('')
  const [results, setResults] = useState<StudentRow[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [active, setActive] = useState(0)
  const [focused, setFocused] = useState(false)
  const input = useRef<InputRef>(null)
  const listId = useId()

  const term = q.trim()
  useEffect(() => {
    if (!term) {
      setResults(null)
      setLoading(false)
      return
    }
    let live = true
    setLoading(true)
    const timer = setTimeout(async () => {
      try {
        const rows = await api<StudentRow[]>(
          'GET',
          `/admin/students?q=${encodeURIComponent(term)}&limit=${LIMIT}`,
        )
        if (!live) return
        setResults(rows)
        setError(false)
        setActive(0)
      } catch {
        if (live) setError(true)
      } finally {
        if (live) setLoading(false)
      }
    }, 200)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [term])

  const close = () => {
    setQ('')
    setResults(null)
    input.current?.blur()
    if (compact) setOpen(false)
  }

  const go = (hash: string) => {
    close()
    void leaveTo(hash)
  }

  const showAll = () => go(`/students?q=${encodeURIComponent(term)}`)

  if (!open) {
    return (
      <Button
        variant="text"
        shape="square"
        aria-label="找学员"
        className="admin-menu-button"
        onClick={() => {
          setOpen(true)
          // After the input is on screen.
          setTimeout(() => input.current?.focus())
        }}
      >
        <SearchIcon size="20px" />
      </Button>
    )
  }

  const rows = results ?? []
  const showList = focused && term !== ''

  return (
    <div className={compact ? 'student-search compact' : 'student-search'}>
      <Input
        ref={input}
        value={q}
        placeholder="找学员：姓名或手机号"
        prefixIcon={<SearchIcon />}
        clearable
        autofocus={compact}
        inputClass="student-search-input"
        onChange={(v) => setQ(String(v))}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false)
          if (compact && !q) setOpen(false)
        }}
        onKeydown={(_, { e }) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            const n = rows.length + 1
            setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n)
          } else if (e.key === 'Enter' && term) {
            e.preventDefault()
            // While a search is pending the rows are the last term's, so show all for this one.
            const row = loading ? undefined : rows[active]
            if (row) go(`/students?id=${row.id}`)
            else showAll()
          } else if (e.key === 'Escape') {
            close()
          }
        }}
        aria-controls={listId}
        aria-label="找学员"
      />
      {compact && (
        <Button variant="text" className="student-search-cancel" onClick={close}>
          取消
        </Button>
      )}
      {showList && (
        // Mouse down would blur the input before the click lands.
        // biome-ignore lint/a11y/noStaticElementInteractions: keyboard is handled by the input
        <div className="student-search-list" id={listId} onMouseDown={(e) => e.preventDefault()}>
          {error ? (
            <div className="student-search-note">加载失败，请重试</div>
          ) : results === null || (loading && rows.length === 0) ? (
            <div className="student-search-note">搜索中…</div>
          ) : rows.length === 0 ? (
            <div className="student-search-note">没有找到学员</div>
          ) : (
            rows.map((s, i) => (
              <button
                type="button"
                key={s.id}
                className={i === active ? 'student-search-item active' : 'student-search-item'}
                onMouseEnter={() => setActive(i)}
                onClick={() => go(`/students?id=${s.id}`)}
              >
                <span className="student-search-name">
                  {s.deletedAt ? '已注销' : s.name || '未填写'}
                </span>
                <span className="muted">{s.phone || '-'}</span>
              </button>
            ))
          )}
          {rows.length > 0 && (
            <button
              type="button"
              className={
                active === rows.length
                  ? 'student-search-item more active'
                  : 'student-search-item more'
              }
              onMouseEnter={() => setActive(rows.length)}
              onClick={showAll}
            >
              在学员页查看全部结果
            </button>
          )}
        </div>
      )}
    </div>
  )
}
