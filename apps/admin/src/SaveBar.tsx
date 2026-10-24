import { useEffect, useId, useRef } from 'react'
import { Button, DialogPlugin } from 'tdesign-react'

// Forms with changes not saved yet, by the id of the component that holds them.
const unsaved = new Set<string>()

/** True while some form on the page has changes that are not saved. */
export function hasUnsaved() {
  return unsaved.size > 0
}

// The question on screen, so a second back press while it is open does not ask twice.
let asking: Promise<boolean> | null = null
// Set once the admin chose to leave, so the move that follows is not asked about again.
let leaving = false

/**
 * Asks before throwing away unsaved changes, and resolves true when there are none or the admin
 * chose to leave. Pages and the menu call it before taking the admin elsewhere.
 */
export function confirmLeave(): Promise<boolean> {
  if (!hasUnsaved()) return Promise.resolve(true)
  asking ??= new Promise((resolve) => {
    const answer = (leave: boolean) => {
      dialog.destroy()
      asking = null
      leaving = leave
      resolve(leave)
    }
    const dialog = DialogPlugin.confirm({
      header: '放弃未保存的修改？',
      body: '离开后，这次的修改不会保存。',
      theme: 'warning',
      confirmBtn: { content: '放弃修改', theme: 'danger' },
      cancelBtn: '继续编辑',
      onConfirm: () => answer(true),
      onClose: () => answer(false),
    })
  })
  return asking
}

/** True once right after the admin chose to leave, for the page change that follows. */
export function takeLeave() {
  const was = leaving
  leaving = false
  return was
}

/** Goes to another page of the admin, such as `#/students?id=3`, once unsaved changes are settled. */
export async function leaveTo(hash: string) {
  if (!(await confirmLeave())) return
  const target = hash.startsWith('#') ? hash : `#${hash}`
  // The same address changes nothing, so the pass to leave is not needed.
  if (target === window.location.hash) takeLeave()
  else window.location.hash = target
}

/**
 * Marks the calling form as holding unsaved changes while `dirty` is true: the admin is asked
 * before leaving the page, logging out or closing the tab.
 */
export function useLeaveGuard(dirty: boolean) {
  const id = useId()
  useEffect(() => {
    if (!dirty) return
    unsaved.add(id)
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', onUnload)
    return () => {
      unsaved.delete(id)
      window.removeEventListener('beforeunload', onUnload)
    }
  }, [dirty, id])
}

/**
 * The bar that rises at the bottom of a form page once something is changed, with 保存 and
 * 撤销修改. It also guards against leaving with the changes unsaved, and saves on Ctrl+S / ⌘S.
 * Place it last on the page: it sticks to the bottom of the window while the page scrolls.
 */
export function SaveBar({
  dirty,
  saving,
  onSave,
  onReset,
  note = '有未保存的修改',
}: {
  dirty: boolean
  saving: boolean
  onSave: () => void
  onReset: () => void
  note?: string
}) {
  useLeaveGuard(dirty)
  const save = useRef(onSave)
  save.current = onSave

  useEffect(() => {
    if (!dirty) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        // A dialog over the page, such as a banner's editor, saves with its own button.
        if ((e.target as Element | null)?.closest?.('.t-dialog')) return
        save.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dirty])

  if (!dirty) return null
  return (
    <section className="save-bar" aria-label="保存修改">
      <span className="save-bar-note">{note}</span>
      <span className="save-bar-actions">
        <Button variant="outline" disabled={saving} onClick={onReset}>
          撤销修改
        </Button>
        <Button loading={saving} onClick={onSave}>
          保存
        </Button>
      </span>
    </section>
  )
}
