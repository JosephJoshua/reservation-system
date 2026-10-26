import { Fragment, type ReactNode, useEffect, useState } from 'react'
import { Button, Card, Loading, MessagePlugin } from 'tdesign-react'
import { api } from './api'
import { type ApiData, attempt, newKey, useSubmitting } from './hooks'
import type { Draft } from './preview/data'
import { EditorWithPreview } from './preview/EditorWithPreview'
import { SaveBar } from './SaveBar'

/** What follows the page in the address, as `3` in `#/coaches/3`, or null on the list. */
function subpath() {
  return window.location.hash.split('?')[0]?.split('/')[2] || null
}

function recordId(): number | 'new' | null {
  const part = subpath()
  if (part === 'new') return 'new'
  const id = Number(part)
  return part && Number.isSafeInteger(id) && id > 0 ? id : null
}

/**
 * The record a list page shows instead of its list: a number for `#/coaches/3`, 'new' for
 * `#/coaches/new`, or null on the list itself. Follows the address.
 */
export function useRecordId() {
  const [id, setId] = useState(recordId)
  useEffect(() => {
    const onHash = () => setId(recordId())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  return id
}

/** True when `a` and `b` hold the same values, for telling whether a form was changed. */
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * A record of a list edited on its own page, with the mini program preview beside the form and
 * the save bar at the bottom: `#/<list>/<id>`, or `#/<list>/new` for a new one. Saving goes back
 * to the list. A save over someone else's change is refused, and the form keeps what was typed
 * until the admin loads the newer version.
 */
export function EditPage<R extends { id: number }, F>({
  id,
  rows,
  path,
  list,
  noun,
  blank,
  toForm,
  editable = (row) => row,
  name,
  check,
  draft,
  actions,
  children,
}: {
  id: number | 'new'
  /** The list the page belongs to, already loading on the list page. */
  rows: ApiData<R[]>
  /** The API path of the list, as `/admin/coaches`. */
  path: string
  /** The list's name and address, for the breadcrumb and the way back. */
  list: { label: string; hash: string }
  /** What one record is called, as 教练. */
  noun: string
  blank: () => F
  toForm: (row: R) => F
  /** The part of a record its version covers, when the list adds more. */
  editable?: (row: R) => unknown
  /** The record's name in the breadcrumb, once it has one. */
  name: (form: F) => string
  /** Why the form can't be saved yet, if it can't. */
  check: (form: F) => string | null
  draft: (form: F) => Draft
  /** Buttons beside the title, for a saved record. */
  actions?: (row: R) => ReactNode
  /** The form. `set` takes a patch, so an upload finishing late keeps what was typed meanwhile. */
  children: (form: F, set: (patch: Partial<F>) => void) => ReactNode
}) {
  const isNew = id === 'new'
  const row = isNew ? null : (rows.data?.find((r) => r.id === id) ?? null)
  // The record as it was when editing began, which a save must still match.
  const [base, setBase] = useState<R | null>(null)
  const [form, setForm] = useState<F | null>(() => (isNew ? blank() : null))
  const [start, setStart] = useState<F | null>(form)
  const [key, setKey] = useState(newKey)
  // Someone else saved the record meanwhile: this form can't be saved over their change.
  const [stale, setStale] = useState(false)
  // Saved: the page goes back to the list once the save bar has let go.
  const [done, setDone] = useState(false)
  const saving = useSubmitting(key)
  // Goes up when the form is put back, so fields that keep their own state, such as the rich
  // text of 介绍, start again from it.
  const [generation, setGeneration] = useState(0)

  const begin = (r: R) => {
    const f = toForm(r)
    setBase(r)
    setForm(f)
    setStart(f)
    setStale(false)
    setKey(newKey())
    setGeneration((g) => g + 1)
  }
  const reset = () => {
    setForm(start)
    setGeneration((g) => g + 1)
  }
  // The record arrives with the list.
  // biome-ignore lint/correctness/useExhaustiveDependencies: starts once, when the record loads
  useEffect(() => {
    if (row && !base) begin(row)
  }, [row, base])

  // Opened from the list or a link: starts at the top, as other pages do.
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [])

  // Deleted by someone else meanwhile, as a reload after a refused save shows: nothing to save to.
  useEffect(() => {
    if (base && rows.data && !row) setStale(true)
  }, [base, rows.data, row])

  // Back to the list in place of this page, so the back button doesn't open it again.
  useEffect(() => {
    if (done) window.location.replace(list.hash)
  }, [done, list.hash])

  const set = (patch: Partial<F>) => setForm((f) => f && { ...f, ...patch })
  const dirty = !!form && !!start && !same(form, start)

  const save = async () => {
    if (!form) return
    const problem = stale ? `${noun}已被其他人修改，请先载入最新内容` : check(form)
    if (problem) {
      void MessagePlugin.warning(problem)
      return
    }
    // The fields can't be typed in while saving, which takes the cursor out of them.
    const focused = document.activeElement
    const ok = await attempt(
      () =>
        api(isNew ? 'POST' : 'PUT', isNew ? path : `${path}/${id}`, form, {
          key,
          ifMatch: base ? editable(base) : undefined,
        }),
      '已保存',
      {
        key,
        stale: ['edited_elsewhere'],
        // Other refusals, such as a category deleted meanwhile, leave the form to correct.
        onStale: async (e) => {
          if (!isNew && e.code === 'edited_elsewhere') setStale(true)
          await rows.reload()
        },
      },
    )
    if (!ok) {
      // Back where it was, once the fields can be typed in again.
      if (focused instanceof HTMLElement) setTimeout(() => focused.isConnected && focused.focus())
      return
    }
    void rows.reload()
    setStart(form)
    setDone(true)
  }

  const title = (form && name(form)) || (isNew ? `新建${noun}` : noun)
  const missing = !isNew && !row && !base && (rows.data || rows.error)

  return (
    <div className="detail-page edit-page">
      <nav className="breadcrumb" aria-label="位置">
        <a href={list.hash}>{list.label}</a>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{title}</span>
      </nav>
      {missing ? (
        <p className="muted">{rows.error ?? `没有找到这个${noun}，可能已被删除`}</p>
      ) : !form ? (
        <Loading size="small" />
      ) : (
        <>
          <div className="detail-head">
            <h2 className="detail-title">{title}</h2>
            {row && actions?.(row)}
          </div>
          {stale && (
            <div className="edit-stale" role="alert">
              <span>其他人刚刚修改了这个{noun}，这里的修改不能直接保存。</span>
              {row ? (
                <Button size="small" variant="outline" onClick={() => begin(row)}>
                  载入最新内容
                </Button>
              ) : (
                <span>它可能已被删除。</span>
              )}
            </div>
          )}
          <Card bordered>
            <EditorWithPreview draft={draft(form)} chrome={136}>
              {/* Nothing can be typed while saving, as the page leaves once it is saved. */}
              <div className="edit-fields" inert={saving}>
                <Fragment key={generation}>{children(form, set)}</Fragment>
              </div>
            </EditorWithPreview>
          </Card>
          <SaveBar
            dirty={dirty && !done}
            saving={saving}
            onSave={() => void save()}
            onReset={reset}
            note={stale ? '已被其他人修改' : undefined}
          />
        </>
      )}
    </div>
  )
}
