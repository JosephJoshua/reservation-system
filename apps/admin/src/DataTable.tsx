import { useEffect, useId, useRef, useState } from 'react'
import { type PrimaryTableCol, Table, type TableProps, type TableRowData } from 'tdesign-react'
import { overlayShown } from './hooks'
import { type Reorder, ReorderCell } from './Reorder'

// Columns of row buttons. On a phone they become the card's footer instead of a labelled row.
const ACTION_COLUMNS = new Set(['op', 'actions'])

// Tables that take J / K, newest last: only the last one mounted answers the keys.
const keyed: string[] = []

/**
 * True when the key belongs to something else: a field, button or tab with focus, or a dialog,
 * drawer or popup on screen. The keys work with nothing focused or a row of the table focused.
 */
function keyTaken(e: KeyboardEvent) {
  if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return true
  const el = e.target instanceof Element ? e.target : null
  if (el && el !== document.body && !el.matches('.t-table tr, .t-table td')) return true
  return overlayShown()
}

/**
 * J and K move a highlighted row down and up, Enter or O opens it, Esc lets go, as in mail apps.
 * The row under the keys is `cursor`; it lets go when the rows change, so Enter never opens a row
 * other than the one picked.
 */
function useRowKeys(rows: readonly TableRowData[], rowKey: string, open?: (index: number) => void) {
  const id = useId()
  const [cursor, setCursor] = useState<number | null>(null)
  const count = rows.length
  const on = Boolean(open)
  useEffect(() => {
    if (!on) return
    keyed.push(id)
    return () => {
      keyed.splice(keyed.indexOf(id), 1)
    }
  }, [on, id])
  const ids = rows.map((r) => String(r[rowKey])).join(',')
  const seen = useRef(ids)
  if (seen.current !== ids) {
    seen.current = ids
    if (cursor !== null) setCursor(null)
  }
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
  const keys = useRowKeys(
    data,
    String(props.rowKey ?? 'id'),
    onOpen && ((i) => data[i] && onOpen(data[i])),
  )
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
      rowClassName={(ctx) => {
        const own = props.rowClassName
        const theirs = typeof own === 'function' ? own(ctx) : own
        return ctx.rowIndex === keys.cursor ? [theirs, keys.className] : theirs
      }}
    />
  )
}
