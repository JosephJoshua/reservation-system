import { type ReactNode, useState, useSyncExternalStore } from 'react'
import { Dialog, RadioGroup } from 'tdesign-react'
import { useIsPhone } from '../hooks'
import type { Draft } from './data'
import { MiniProgramPreview } from './MiniProgramPreview'
import './preview.css'

/** For a dialog holding an EditorWithPreview: room for the form and the phone beside it. */
export const PREVIEW_DIALOG_WIDTH = 'min(1160px, calc(100vw - 48px))'

function useWindowHeight() {
  return useSyncExternalStore(
    (fn) => {
      window.addEventListener('resize', fn)
      return () => window.removeEventListener('resize', fn)
    },
    () => window.innerHeight,
  )
}

/**
 * An edit form with a live preview of the record in the mini program: beside the form on a wide
 * screen, behind a 编辑 / 预览 switch on a phone. Fits a dialog or a page; `chrome` is the height
 * the surroundings take, so the phone fits the window.
 */
export function EditorWithPreview({
  draft,
  chrome = 200,
  children,
}: {
  draft: Draft
  chrome?: number
  children: ReactNode
}) {
  const phone = useIsPhone()
  const height = useWindowHeight()
  const [tab, setTab] = useState<'edit' | 'preview'>('edit')
  if (phone) {
    return (
      <div className="editor-with-preview phone">
        <RadioGroup
          className="editor-preview-switch"
          theme="button"
          variant="default-filled"
          value={tab}
          options={[
            { value: 'edit', label: '编辑' },
            { value: 'preview', label: '预览' },
          ]}
          onChange={(v) => setTab(v as 'edit' | 'preview')}
        />
        {/* The form stays mounted, so a pending upload or typed text is kept. */}
        <div className="editor-form" hidden={tab !== 'edit'}>
          {children}
        </div>
        {tab === 'preview' && <MiniProgramPreview draft={draft} maxHeight={height - 280} />}
      </div>
    )
  }
  return (
    <div className="editor-with-preview">
      <div className="editor-form">{children}</div>
      <aside className="editor-preview" aria-label="小程序预览">
        <MiniProgramPreview draft={draft} maxHeight={height - chrome} />
      </aside>
    </div>
  )
}

/** The 预览 action of a list: the saved record as students see it. */
export function PreviewDialog({
  draft,
  title,
  onClose,
}: {
  draft: Draft
  title: string
  onClose: () => void
}) {
  const height = useWindowHeight()
  return (
    <Dialog
      visible
      width={460}
      top={24}
      header={title}
      confirmBtn={null}
      cancelBtn="关闭"
      onClose={onClose}
      onCancel={onClose}
    >
      <MiniProgramPreview draft={draft} maxHeight={height - 220} />
    </Dialog>
  )
}
