import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import { SearchIcon } from 'tdesign-icons-react'
import { Button, Dialog } from 'tdesign-react'
import { api } from './api'
import { BookForStudent } from './BookForStudent'
import { NewStudentDialog } from './DeskStudent'
import { overlayShown } from './hooks'
import { useCan } from './me'
import { sections as settingsSections } from './pages/Settings'
import { leaveTo } from './SaveBar'
import { SHOW_SECTION } from './SectionNav'
import { setThemeChoice } from './theme'
import type { StudentRow } from './types'

const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent)
/** The keys that open the menu, as shown on this computer. */
export const MENU_KEYS = isMac ? '⌘K' : 'Ctrl K'

const STUDENTS_SHOWN = 5

// Other names a page is looked for by.
const pageWords: Record<string, string> = {
  checkin: '签到 前台签到 点名',
  bookings: '改约 取消',
  catalog: '课程 教练 课程类型',
  banners: '轮播图 公告 预约须知',
  reports: '统计 课时费',
  actions: '日志',
}

type Item = {
  id: string
  group: string
  label: string
  /** Shown on the right, such as the group of a page or a phone number. */
  meta?: string
  /** Other words it is found by. */
  words?: string
  run: () => unknown
  /** Opens a dialog, which gives the focus back when it closes. */
  dialog?: boolean
}

/**
 * ⌘K: go to any page, a part of 设置 or a student, or start 代约 and 前台建档, from the keyboard.
 * Pages, actions and settings match as typed; students are searched once a name or phone is typed.
 */
export function CommandMenu({
  pages,
}: {
  pages: { key: string; label: string; group?: string }[]
}) {
  const canBook = useCan('bookings')
  const canAddStudent = useCan('students')
  const canFindStudent = pages.some((p) => p.key === 'students')
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const [dialog, setDialog] = useState<'book' | 'student' | null>(null)
  const [found, setFound] = useState<{ term: string; rows: StudentRow[] | null; failed?: boolean }>(
    {
      term: '',
      rows: null,
    },
  )
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  // What had the focus, given back when the menu is closed without picking anything.
  const back = useRef<Element | null>(null)
  const listId = useId()

  // Each opening starts empty.
  const show = () => {
    back.current = document.activeElement
    setQ('')
    setActive(0)
    setOpen(true)
  }
  const restore = () => {
    if (back.current instanceof HTMLElement && back.current.isConnected) back.current.focus()
  }
  const dismiss = () => {
    setOpen(false)
    restore()
  }

  // The latest show and dismiss for the key listener, which is added once.
  const keys = useRef({ open, show, dismiss })
  keys.current = { open, show, dismiss }
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'k') return
      e.preventDefault()
      const { open, show, dismiss } = keys.current
      if (open) dismiss()
      // A dialog or drawer on screen keeps the keyboard, as leaving it could drop what it holds.
      else if (!overlayShown('.command-menu')) show()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // The field is ready to type in once the menu is on screen.
  useEffect(() => {
    if (!open) return
    const timer = setTimeout(() => input.current?.focus())
    return () => clearTimeout(timer)
  }, [open])

  const term = q.trim()
  useEffect(() => {
    if (!open || !canFindStudent || !term) return
    let live = true
    const timer = setTimeout(async () => {
      try {
        const rows = await api<StudentRow[]>(
          'GET',
          `/admin/students?q=${encodeURIComponent(term)}&limit=${STUDENTS_SHOWN}`,
        )
        if (live) setFound({ term, rows })
      } catch {
        if (live) setFound({ term, rows: null, failed: true })
      }
    }, 200)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [open, canFindStudent, term])

  const go = (hash: string) => () => leaveTo(hash)
  // On 设置 already, 设置 or a section of it is a scroll, not a page change that asks about unsaved
  // edits, which stay on the page.
  const toSettings = (key?: string) => async () => {
    const hash = key ? `#/settings?section=${key}` : '#/settings'
    if (window.location.hash.replace(/^#\/?/, '').split(/[?/]/)[0] !== 'settings') {
      await leaveTo(hash)
      return
    }
    history.replaceState(history.state, '', hash)
    window.dispatchEvent(new Event(SHOW_SECTION))
    if (!key) window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  const all: Item[] = [
    ...pages.map((p) => ({
      id: `page-${p.key}`,
      group: '页面',
      label: p.label,
      meta: p.group,
      words: pageWords[p.key],
      run: p.key === 'settings' ? toSettings() : go(`#/${p.key}`),
    })),
    ...(canBook
      ? [
          {
            id: 'book',
            group: '操作',
            label: '代约',
            words: '预约 约课',
            dialog: true,
            run: () => setDialog('book'),
          },
        ]
      : []),
    ...(canAddStudent
      ? [
          {
            id: 'new-student',
            group: '操作',
            label: '前台建档',
            words: '新建学员 添加学员',
            dialog: true,
            run: () => setDialog('student'),
          },
        ]
      : []),
    ...(pages.some((p) => p.key === 'settings')
      ? settingsSections.map((s) => ({
          id: `settings-${s.key}`,
          group: '设置',
          label: `设置 · ${s.label}`,
          run: toSettings(s.key),
        }))
      : []),
    ...(
      [
        ['light', '浅色'],
        ['dark', '深色'],
        ['system', '跟随系统'],
      ] as const
    ).map(([choice, label]) => ({
      id: `theme-${choice}`,
      group: '外观',
      label: `外观：${label}`,
      words: '主题 夜间 暗色',
      run: () => setThemeChoice(choice),
    })),
  ]
  const lower = term.toLowerCase()
  const matched = lower
    ? all.filter((i) => `${i.label} ${i.meta ?? ''} ${i.words ?? ''}`.toLowerCase().includes(lower))
    : all
  // Found students come after the rest, so the list does not jump when they arrive.
  const students = canFindStudent && term && found.term === term ? found.rows : null
  const items: Item[] = [
    ...matched,
    ...(students ?? []).map((s) => ({
      id: `student-${s.id}`,
      group: '学员',
      label: s.deletedAt ? '已注销' : s.name || '未填写',
      meta: s.phone || undefined,
      run: go(`#/students/${s.id}`),
    })),
    ...(students?.length
      ? [
          {
            id: 'students-all',
            group: '学员',
            label: `在学员页查看“${term}”的全部结果`,
            run: go(`#/students?q=${encodeURIComponent(term)}`),
          },
        ]
      : []),
  ]
  const current = Math.min(active, items.length - 1)
  const studentNote =
    !canFindStudent || !term
      ? null
      : found.term !== term
        ? '正在找学员…'
        : found.failed
          ? '学员加载失败，请重试'
          : students?.length === 0
            ? '没有找到学员'
            : null

  // Keeps the chosen row in view as the arrows move it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the chosen row changes
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [current])

  const run = async (item: Item | undefined) => {
    if (!item) return
    setOpen(false)
    const from = window.location.hash
    await item.run()
    // Still here, such as after 外观 or a cancelled leave: the focus goes back. A dialog opened
    // from the menu gives it back when it closes.
    if (window.location.hash === from && !item.dialog) restore()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Keys pressed while picking characters belong to the input method.
    // Safari sends the Enter that picks a character after composing ends, as key code 229.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    const step =
      e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')
        ? 1
        : e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')
          ? -1
          : 0
    if (step && items.length) {
      e.preventDefault()
      setActive((current + step + items.length) % items.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      void run(items[current])
    }
  }

  // Items are already in group order.
  const groups = [...new Set(items.map((i) => i.group))]
  return (
    <>
      <Button
        variant="text"
        className="command-button"
        aria-label="快捷菜单"
        title={`快捷菜单（${MENU_KEYS}）`}
        onClick={show}
      >
        <kbd>{MENU_KEYS}</kbd>
      </Button>
      <Dialog
        visible={open}
        header={false}
        footer={false}
        closeBtn={false}
        placement="top"
        top="12vh"
        width={560}
        className="command-menu"
        destroyOnClose
        // Not the Esc that ends composing a character, which only leaves the input method.
        closeOnEscKeydown={false}
        onEscKeydown={({ e }) => {
          if (!e.nativeEvent.isComposing && e.keyCode !== 229) dismiss()
        }}
        onClose={dismiss}
      >
        <div className="command-search">
          <SearchIcon size="20px" />
          <input
            ref={input}
            value={q}
            placeholder="搜索页面、操作或学员"
            role="combobox"
            aria-label="快捷菜单"
            aria-autocomplete="list"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={items[current] ? `${listId}-${items[current].id}` : undefined}
            onChange={(e) => {
              setQ(e.target.value)
              setActive(0)
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        <div className="command-list" id={listId} role="listbox" ref={list} aria-label="结果">
          {groups.map((group) => (
            // A listbox groups its options with role="group"; a fieldset is for form fields.
            // biome-ignore lint/a11y/useSemanticElements: see above
            <div
              key={group}
              role="group"
              aria-labelledby={`${listId}-${group}`}
              className="command-section"
            >
              <div id={`${listId}-${group}`} className="command-group">
                {group}
              </div>
              {items.map((item, i) =>
                item.group !== group ? null : (
                  <div
                    key={item.id}
                    id={`${listId}-${item.id}`}
                    role="option"
                    tabIndex={-1}
                    aria-selected={i === current}
                    className={i === current ? 'command-item active' : 'command-item'}
                    onMouseMove={() => i !== current && setActive(i)}
                    // Keeps the focus in the field.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => void run(item)}
                    onKeyDown={() => {}}
                  >
                    <span className="command-label">{item.label}</span>
                    {item.meta && <span className="muted command-meta">{item.meta}</span>}
                  </div>
                ),
              )}
            </div>
          ))}
          {studentNote && <div className="command-note">{studentNote}</div>}
          {items.length === 0 && !studentNote && <div className="command-note">没有找到</div>}
        </div>
        <div className="command-hint">
          <span>↑↓ 选择</span>
          <span>Enter 打开</span>
          <span>Esc 关闭</span>
          <span>列表里按 J / K 上下移动</span>
        </div>
      </Dialog>
      {dialog === 'book' && (
        <BookForStudent
          onClose={() => {
            setDialog(null)
            restore()
          }}
          onDone={() => {
            setDialog(null)
            restore()
          }}
        />
      )}
      {dialog === 'student' && (
        <NewStudentDialog
          onClose={() => {
            setDialog(null)
            restore()
          }}
          onDone={async (student) => {
            setDialog(null)
            const from = window.location.hash
            await leaveTo(`#/students/${student.id}`)
            if (window.location.hash === from) restore()
          }}
        />
      )}
    </>
  )
}
