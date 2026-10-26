import { type ReactNode, useEffect, useState } from 'react'
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

  const begin = (r: R) => {
    const f = toForm(r)
    setBase(r)
    setForm(f)
    setStart(f)
    setStale(false)
    setKey(newKey())
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

  useEffect(() => {
    if (done) window.location.hash = list.hash
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
        onStale: async () => {
          setStale(true)
          await rows.reload()
        },
      },
    )
    if (!ok) return
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
              {children(form, set)}
            </EditorWithPreview>
          </Card>
          <SaveBar
            dirty={dirty && !done}
            saving={saving}
            onSave={() => void save()}
            onReset={() => setForm(start)}
            note={stale ? '已被其他人修改' : undefined}
          />
        </>
      )}
    </div>
  )
}
