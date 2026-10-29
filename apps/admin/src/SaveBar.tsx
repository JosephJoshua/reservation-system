import { useEffect, useId, useRef } from 'react'
import { Button, DialogPlugin } from 'tdesign-react'

// Forms with changes not saved yet, by the id of the component that holds them.
const unsaved = new Set<string>()

// Dialogs typed into, or with a choice made in them, since they opened, such as 代约 or
// 修改姓名和手机号. Esc or a click on the backdrop asks before closing them. Those of the page
// also lose what was typed when the page changes under them, so they count as unsaved until they
// close; each is kept with where it was opened: the page, or a lesson opened over it, which
// closing the lesson alone also throws away. Dialogs opened from the header, such as
// 修改我的密码, stay open whatever the page and are not counted (`header`). A dialog that keeps
// its own count, with useLeaveGuard, has the class `own-leave-guard`, and `has-unsaved` while it
// holds changes.
type TypedIn = 'page' | 'lesson' | 'header'
const typedIn = new Map<Element, TypedIn>()

// Picking from a dropdown or a calendar, confirming a time, or flipping a switch, fires no input
// event. A time scrolled to is not picked until 确定.
const CHOICE = [
  '.t-select-option',
  '.t-date-picker__cell',
  '.t-date-range-picker__cell',
  '.t-time-picker__panel-section-footer .t-button',
  '.t-cascader__item',
  '.t-switch',
].join(', ')
// What can't be picked.
const DISABLED =
  '.t-is-disabled, .t-date-picker__cell--disabled, .t-date-range-picker__cell--disabled'
// Dropdowns, calendars and time panels, which sit outside the dialog they belong to.
const DROPDOWN = `${CHOICE}, .t-date-picker__panel, .t-time-picker__panel, .t-select__dropdown`

const isShown = (dialog: Element) => dialog.isConnected && dialog.getClientRects().length > 0

/** The dialog on top, which an open dropdown belongs to: dropdowns sit outside their dialog. */
function topDialog() {
  let top: Element | null = null
  let topZ = Number.NEGATIVE_INFINITY
  for (const dialog of document.querySelectorAll('.t-dialog__ctx')) {
    if (!isShown(dialog)) continue
    const z = Number(getComputedStyle(dialog).zIndex) || 0
    // A later one of the same level was opened over the earlier.
    if (z >= topZ) {
      top = dialog
      topZ = z
    }
  }
  return top
}

/** A dropdown or calendar open on the page, which Esc should close alone. */
function openDropdown() {
  return [...document.querySelectorAll('.t-popup')].some(
    (popup) => isShown(popup) && popup.querySelector(DROPDOWN),
  )
}

/**
 * The dialog `el` belongs to: the one it is in, or for a dropdown, which sits outside it, or
 * nothing focused while a dropdown is open, the dialog on top.
 */
function ownerDialog(el: Element) {
  const dialog = el.closest('.t-dialog__ctx')
  if (dialog) return dialog
  return el.closest('.t-popup') || openDropdown() ? topDialog() : null
}

/** The dialog an input or a choice at the event's target changes, if any. */
function changedDialog(e: Event) {
  const el = e.target as Element | null
  if (!el?.closest) return null
  if (e.type === 'click') {
    if (!el.closest(CHOICE) || el.closest(DISABLED)) return null
    return el.closest('.t-dialog__ctx') ?? (el.closest('.t-popup') ? topDialog() : null)
  }
  return el.closest('.t-dialog__ctx')
}

/**
 * Notes typing, or a choice, in a dialog of the page or of the lesson open over it. Their content
 * passes its input and click events here: React hands them up from a dialog, and from
 * its dropdowns, to what opened it, though they sit elsewhere.
 */
export function markTyped(e: Event, where: TypedIn = 'page') {
  const dialog = changedDialog(e)
  if (dialog && !dialog.matches('.own-leave-guard')) typedIn.set(dialog, where)
}

/** Drops the dialogs closed or gone since they were typed into, and counts the rest. */
function openTyped(where?: TypedIn) {
  let count = 0
  for (const [dialog, at] of typedIn) {
    if (!isShown(dialog)) typedIn.delete(dialog)
    else if (where ? at === where : at !== 'header') count++
  }
  return count
}

/** True while a dialog of the lesson open over the page holds typing not saved. */
export function lessonHasUnsaved() {
  return openTyped('lesson') > 0
}

// What the admin last clicked or pressed a key on, so a save can tell which dialog it came from.
let pressed: Element | null = null

/** The element the admin last clicked or pressed a key on. */
export function lastPressed() {
  return pressed
}

/**
 * Forgets what was typed into the dialog `from` is in, once it was saved there: it is closing,
 * and the page change that may follow, such as opening the student just added, is not asked
 * about.
 */
export function settleDialog(from: Element | null) {
  const dialog = from?.closest?.('.t-dialog__ctx')
  if (dialog) typedIn.delete(dialog)
}

/**
 * Whether Esc or a click on its backdrop would drop changes in `dialog`. A dialog that closes on
 * neither, or handles them itself, has the class `own-close` and is not asked about.
 */
function hasChanges(dialog: Element) {
  return dialog.matches('.own-leave-guard') ? dialog.matches('.has-unsaved') : typedIn.has(dialog)
}

// The question on screen, so pressing Esc again while it is open does not ask twice, and how to
// answer it 继续填写 when something else, such as leaving the page, asks over it.
let askingClose: Promise<boolean> | null = null
let keepEditing: (() => void) | null = null

/** Answers an open 放弃填写的内容？ as 继续填写, before another question takes its place. */
export function dismissClose() {
  keepEditing?.()
}

/**
 * Asks before closing `typed` with what was typed in it, and resolves true to close it. The
 * question goes, as 继续填写, if the dialog closes or goes meanwhile.
 */
function confirmClose(typed: Element): Promise<boolean> {
  askingClose ??= new Promise((resolve) => {
    const gone = window.setInterval(() => {
      if (!isShown(typed)) answer(false)
    }, 300)
    const answer = (close: boolean) => {
      window.clearInterval(gone)
      dialog.destroy()
      askingClose = null
      keepEditing = null
      resolve(close)
    }
    keepEditing = () => answer(false)
    const dialog = DialogPlugin.confirm({
      header: '放弃填写的内容？',
      body: '关闭后，这次填写的内容不会保存。',
      theme: 'warning',
      confirmBtn: { content: '放弃', theme: 'danger' },
      cancelBtn: '继续填写',
      onConfirm: () => answer(true),
      onClose: () => answer(false),
    })
  })
  return askingClose
}

/**
 * Esc and a click on the backdrop close a dialog at once, and with it what was typed: with
 * changes in it, they ask first, as leaving the page does, and close it once the admin agrees.
 */
function guardQuickClose(e: Event, again: () => Event) {
  const target = e.target as Element
  if (!target?.closest) return
  const dialog = ownerDialog(target)
  if (!dialog || dialog.matches('.own-close') || !isShown(dialog)) return
  // Esc with a dropdown of the dialog open closes the dropdown alone, as a press outside it does,
  // whether or not anything was typed.
  if (e.type === 'keydown' && openDropdown()) {
    e.preventDefault()
    e.stopImmediatePropagation()
    for (const type of ['mousedown', 'mouseup']) {
      document.body.dispatchEvent(new MouseEvent(type, { bubbles: true }))
    }
    // Focus left in the dropdown goes back to its dialog, so the next Esc reaches the dialog.
    if (!dialog.contains(document.activeElement)) (dialog as HTMLElement).focus()
    return
  }
  if (!hasChanges(dialog)) return
  e.preventDefault()
  e.stopImmediatePropagation()
  // A drag that began in the dialog, such as selecting its text, ending on the backdrop.
  if (e.type === 'click' && pressed !== target) return
  void confirmClose(dialog).then((close) => {
    if (!close || !isShown(dialog)) return
    typedIn.delete(dialog)
    ;(target.isConnected ? target : dialog).dispatchEvent(again())
  })
}

if (typeof window !== 'undefined') {
  for (const type of ['pointerdown', 'keydown']) {
    document.addEventListener(type, (e) => (pressed = e.target as Element | null), true)
  }
  // Typing and choices in any dialog, those of the header too, which the page does not count.
  for (const type of ['input', 'click']) {
    document.addEventListener(
      type,
      (e) => {
        const dialog = changedDialog(e)
        if (dialog && !typedIn.has(dialog) && !dialog.matches('.own-leave-guard')) {
          typedIn.set(dialog, 'header')
        }
      },
      true,
    )
  }
  // Before the dialog's own handlers, which close it. What is sent again once the admin agreed
  // is not trusted, so it is let through.
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || !e.isTrusted || e.isComposing) return
      guardQuickClose(e, () => new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    },
    true,
  )
  window.addEventListener(
    'click',
    (e) => {
      const target = e.target as Element | null
      if (!e.isTrusted || !target?.matches?.('.t-dialog__position, .t-dialog__position_fullscreen'))
        return
      guardQuickClose(e, () => new MouseEvent('click', { bubbles: true }))
    },
    true,
  )
  window.addEventListener('beforeunload', (e) => {
    if (openTyped() > 0) e.preventDefault()
  })
}

/** True while some form or dialog on the page has changes that are not saved. */
export function hasUnsaved() {
  return unsaved.size > 0 || openTyped() > 0
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
  // Asked whether to close a dialog: this question takes its place.
  dismissClose()
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

/**
 * Lets the next page change through without asking, for a move that follows a save, such as
 * opening the student a dialog just added while the dialog is still closing.
 */
export function passLeave() {
  leaving = true
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
        // A dialog or drawer over the page, such as a banner's editor, saves with its own button.
        if ((e.target as Element | null)?.closest?.('.t-dialog__ctx, .t-drawer')) return
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

/**
 * Says the record was saved elsewhere since the form was loaded, so the form can't be saved over
 * it, and offers to load the newer version in its place.
 */
export function StaleNotice({ what, onLoad }: { what: string; onLoad: () => void }) {
  return (
    <div className="edit-stale" role="alert">
      <span>其他人刚刚修改了{what}，这里的修改不能直接保存。</span>
      <Button size="small" variant="outline" onClick={onLoad}>
        载入最新内容
      </Button>
    </div>
  )
}
