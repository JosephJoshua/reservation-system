import { Button, MessagePlugin } from 'tdesign-react'
import { api } from './api'
import { attempt, newKey } from './hooks'

// Long enough to read the message and reach the button.
const UNDO_MS = 6000

/** A success message with 撤销, for a change made at once rather than after a confirmation. */
export function undoMessage(text: string, undo: () => void) {
  let closed = false
  const shown = MessagePlugin.success({
    content: (
      <span className="undo-message">
        {text}
        <Button
          variant="text"
          theme="primary"
          size="small"
          onClick={() => {
            if (closed) return
            closed = true
            void shown.then((m) => m.close())
            undo()
          }}
        >
          撤销
        </Button>
      </span>
    ),
    duration: UNDO_MS,
  })
}

/**
 * Turns a switch in a list on or off at once, with 撤销 in the message. The whole record is saved
 * as listed, so a change someone else made meanwhile is refused rather than overwritten, and the
 * undo is checked against the record as this change left it.
 */
export async function toggle<T extends object>({
  path,
  row,
  change,
  done,
  reload,
}: {
  path: string
  row: T
  change: Partial<T>
  /** The message once changed, such as 已下架. */
  done: string
  reload: () => Promise<unknown>
}) {
  const back = Object.fromEntries(
    Object.keys(change).map((k) => [k, row[k as keyof T]]),
  ) as Partial<T>
  let saved: T | undefined
  const ok = await attempt(
    async () => {
      saved = await api<T>('PUT', path, { ...row, ...change }, { ifMatch: row, key: newKey() })
    },
    undefined,
    { key: path, onStale: () => void reload() },
  )
  if (!ok || !saved) return
  await reload()
  const after = saved
  undoMessage(done, async () => {
    if (
      await attempt(
        () => api('PUT', path, { ...after, ...back }, { ifMatch: after, key: newKey() }),
        '已撤销',
        { key: path, onStale: () => void reload() },
      )
    )
      await reload()
  })
}
