import { useCallback, useRef } from 'react'
import { ArrowDownIcon, ArrowUpIcon, DragMoveIcon } from 'tdesign-icons-react'
import { Button, MessagePlugin } from 'tdesign-react'
import { api, RequestError } from './api'

/** The lists the API keeps in a hand-arranged order, by their path under /admin/order. */
export type OrderedList =
  | 'coaches'
  | 'coach-categories'
  | 'lesson-types'
  | 'package-products'
  | 'banners'

/** What a list's `DataTable` takes to let rows be dragged or moved up and down. */
export interface Reorder<T> {
  move: (rows: T[]) => void
  /** Turns the controls off, such as while the list is filtered or still loading. */
  disabled?: boolean
}

/**
 * Saves a new order for one of the hand-ordered lists. The rows move on screen at once and the
 * order is saved behind them; moves made while a save is on its way are sent together after it,
 * so a quick run of 上移 never drops one. A refusal reloads the list as it is on the server.
 */
export function useReorder<T extends { id: number }>(
  list: OrderedList,
  setRows: (rows: T[]) => void,
  reload: () => unknown,
) {
  const latest = useRef<number[] | null>(null)
  const sending = useRef(false)

  return useCallback(
    async (rows: T[]) => {
      setRows(rows)
      latest.current = rows.map((r) => r.id)
      if (sending.current) return
      sending.current = true
      try {
        while (latest.current) {
          const ids = latest.current
          latest.current = null
          await api('PUT', `/admin/order/${list}`, { ids })
        }
      } catch (e) {
        latest.current = null
        void MessagePlugin.error(e instanceof RequestError ? e.message : '顺序没有保存，请重试')
        await reload()
      } finally {
        sending.current = false
      }
    },
    [list, setRows, reload],
  )
}

/** The rows with the one at `from` moved to `to`. */
export function moved<T>(rows: T[], from: number, to: number) {
  const next = [...rows]
  const [row] = next.splice(from, 1)
  if (row !== undefined) next.splice(to, 0, row)
  return next
}

/** The handle and 上移 / 下移 buttons at the start of a reorderable row. */
export function ReorderCell<T>({
  rows,
  index,
  reorder,
}: {
  rows: T[]
  index: number
  reorder: Reorder<T>
}) {
  const off = reorder.disabled
  return (
    <span className="reorder-cell">
      <span className="reorder-handle" title={off ? undefined : '拖动调整顺序'} aria-hidden="true">
        <DragMoveIcon />
      </span>
      <Button
        variant="text"
        shape="square"
        size="small"
        aria-label="上移"
        title="上移"
        disabled={off || index === 0}
        onClick={() => reorder.move(moved(rows, index, index - 1))}
      >
        <ArrowUpIcon />
      </Button>
      <Button
        variant="text"
        shape="square"
        size="small"
        aria-label="下移"
        title="下移"
        disabled={off || index === rows.length - 1}
        onClick={() => reorder.move(moved(rows, index, index + 1))}
      >
        <ArrowDownIcon />
      </Button>
    </span>
  )
}
