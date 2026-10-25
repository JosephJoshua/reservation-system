import { useEffect, useId, useState } from 'react'
import {
  Button,
  type PrimaryTableCol,
  Table,
  type TableProps,
  type TableRowData,
} from 'tdesign-react'
import { type Reorder, ReorderCell } from './Reorder'

// Columns of row buttons. On a phone they become the card's footer instead of a labelled row.
const ACTION_COLUMNS = new Set(['op', 'actions'])

// Tables that take J / K, newest last: only the last one mounted answers the keys.
const keyed: string[] = []

/** True when the key belongs to something else: typing, a button, a dialog or a drawer. */
function keyTaken(e: KeyboardEvent) {
  if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return true
  const el = e.target instanceof Element ? e.target : null
  if (
    el?.closest('input, textarea, select, button, a, [contenteditable], .t-dialog__ctx, .t-drawer')
  )
    return true
  return [...document.querySelectorAll<HTMLElement>('.t-dialog__ctx, .t-drawer--open')].some(
    (d) => getComputedStyle(d).display !== 'none',
  )
}

/**
 * J and K move a highlighted row down and up, Enter or O opens it, Esc lets go, as in mail apps.
 * The row under the keys is `cursor`.
 */
function useRowKeys(count: number, open?: (index: number) => void) {
  const id = useId()
  const [cursor, setCursor] = useState<number | null>(null)
  const on = Boolean(open)
  useEffect(() => {
    if (!on) return
    keyed.push(id)
    return () => {
      keyed.splice(keyed.indexOf(id), 1)
    }
  }, [on, id])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (keyed.at(-1) !== id || keyTaken(e) || count === 0) return
      const key = e.key.toLowerCase()
      if (key === 'j' || key === 'k') {
        e.preventDefault()
        setCursor((c) =>
          c === null || c >= count
            ? key === 'j'
              ? 0
              : count - 1
            : Math.min(count - 1, Math.max(0, c + (key === 'j' ? 1 : -1))),
        )
      } else if ((key === 'enter' || key === 'o') && cursor !== null && cursor < count) {
        e.preventDefault()
        open(cursor)
      } else if (key === 'escape') {
        setCursor(null)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, count, cursor, id])
  const className = `row-cursor row-cursor-${id.replace(/\W/g, '')}`
  // Keeps the row in view as the keys move it.
  useEffect(() => {
    if (cursor !== null)
      document.querySelector(`.${className.split(' ')[1]}`)?.scrollIntoView({ block: 'nearest' })
  }, [cursor, className])
  return { className, cursor: cursor !== null && cursor < count ? cursor : null }
}

/**
 * A TDesign table that becomes a list of cards on a phone: the first column is the card's title,
 * the others show their column title beside the value, and row buttons sit in a footer. Each
 * cell's content is wrapped in one element, so phone.css can line the label up with its first
 * line whatever the cell holds.
 *
 * With `reorder`, each row starts with a drag handle and 上移 / 下移 buttons. With `onOpen`, J and
 * K move through the rows from the keyboard and Enter opens one.
 */
export function DataTable<T extends TableRowData>({
  reorder,
  onOpen,
  ...props
}: TableProps<T> & { reorder?: Reorder<T>; onOpen?: (row: T) => void }) {
  const data = props.data ?? []
  const keys = useRowKeys(data.length, onOpen && ((i) => data[i] && onOpen(data[i])))
  const all: PrimaryTableCol<T>[] | undefined = reorder
    ? [
        {
          colKey: 'drag',
          title: '',
          width: 96,
          attrs: { 'data-label': '', 'data-reorder': '' },
          cell: ({ rowIndex }) => <ReorderCell rows={data} index={rowIndex} reorder={reorder} />,
        },
        ...(props.columns ?? []),
      ]
    : props.columns
  const columns = all?.map((c) => {
    const cell = c.cell
    const wrapped =
      typeof cell === 'function'
        ? { cell: (ctx: Parameters<typeof cell>[0]) => <div className="cell">{cell(ctx)}</div> }
        : {}
    if (typeof c.attrs === 'function') return { ...c, ...wrapped }
    return {
      ...c,
      ...wrapped,
      attrs: {
        'data-label': typeof c.title === 'string' ? c.title : '',
        ...(ACTION_COLUMNS.has(String(c.colKey)) ? { 'data-actions': '' } : {}),
        ...c.attrs,
      },
    }
  })
  return (
    <Table
      {...props}
      columns={columns}
      dragSort={reorder && !reorder.disabled ? 'row-handler' : props.dragSort}
      onDragSort={reorder ? ({ newData }) => reorder.move(newData) : props.onDragSort}
      className={props.className ? `card-table ${props.className}` : 'card-table'}
      rowClassName={({ rowIndex }) => (rowIndex === keys.cursor ? keys.className : '')}
    />
  )
}

/** The button under a paged list, with how many rows are shown so far. */
export function LoadMore({
  shown,
  more,
  loading,
  onMore,
}: {
  shown: number
  more: boolean
  loading: boolean
  onMore: () => void
}) {
  if (shown === 0) return null
  return (
    <div className="load-more">
      {more ? (
        <Button variant="outline" loading={loading} onClick={onMore}>
          加载更多
        </Button>
      ) : (
        <span className="muted">共 {shown} 条</span>
      )}
    </div>
  )
}
