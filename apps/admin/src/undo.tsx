import { Button, MessagePlugin, Switch, type SwitchProps } from 'tdesign-react'
import { api } from './api'
import { attempt, newKey, useSubmitting } from './hooks'

// Long enough to read the message and reach the button.
const UNDO_MS = 6000

/**
 * A success message with 撤销, for a change made at once rather than after a confirmation.
 * `undo` resolves true once undone; a refused undo leaves the button to try again.
 */
export function undoMessage(text: string, undo: () => Promise<boolean>) {
  let busy = false
  let closed = false
  const shown = MessagePlugin.success({
    content: (
      <span className="undo-message">
        {text}
        <Button
          variant="text"
          theme="primary"
          size="small"
          onClick={async () => {
            if (busy || closed) return
            busy = true
            const done = await undo()
            busy = false
            if (!done) return
            closed = true
            void shown.then((m) => m.close())
          }}
        >
          撤销
        </Button>
      </span>
    ),
    duration: UNDO_MS,
  })
}

/** The `attempt` key a `toggle` of this record runs under, for its switch's loading state. */
export const toggleKey = (path: string) => `toggle:${path}`

/** A switch in a list for `toggle`, busy while its record is being changed. */
export function ListSwitch({ path, ...props }: SwitchProps & { path: string }) {
  const busy = useSubmitting(toggleKey(path))
  return <Switch {...props} loading={busy} />
}

/**
 * Turns a switch in a list on or off at once, with 撤销 in the message. The whole record is saved
 * as listed, so a change someone else made meanwhile is refused rather than overwritten, and the
 * undo is checked against the record as this change left it. Until the list has loaded again the
 * record takes no other change, as its switch would still show the old state.
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
  const key = toggleKey(path)
  // A refusal because the record changed elsewhere loads the list again, so the next try works.
  const opts = { key, stale: ['edited_elsewhere'], onStale: () => void reload() }
  let saved: T | undefined
  const ok = await attempt(
    async () => {
      saved = await api<T>('PUT', path, { ...row, ...change }, { ifMatch: row, key: newKey() })
      await reload()
    },
    undefined,
    opts,
  )
  if (!ok || !saved) return
  const after = saved
  undoMessage(done, () =>
    attempt(
      async () => {
        await api('PUT', path, { ...after, ...back }, { ifMatch: after, key: newKey() })
        await reload()
      },
      '已撤销',
      opts,
    ),
  )
}
