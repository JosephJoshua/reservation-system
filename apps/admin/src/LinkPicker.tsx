import {
  isRecordLink,
  LINK_KIND_LABELS,
  LINK_PAGE_HINTS,
  LINK_PAGE_KINDS,
  type LinkTarget,
  NO_LINK,
} from '@rs/shared'
import { useRef, useState } from 'react'
import { Select } from 'tdesign-react'
import { useApi } from './hooks'
import type { Coach, LessonType, PackageProduct } from './types'

interface Choice {
  /** The record's own name, without the details the list adds. */
  name: string
  label: string
  value: string
  /** Shown under the picker once chosen: what the student gets on a tap. */
  hint: string
  /** Why students cannot open it now; null when they can. */
  off: string | null
}

const key = (t: LinkTarget) => `${t.linkKind}:${t.linkId ?? ''}`

function parse(value: string): LinkTarget {
  const [kind, id] = value.split(':') as [LinkTarget['linkKind'], string]
  return { linkKind: kind, linkId: isRecordLink(kind) ? Number(id) : null }
}

/** Everything a banner or the home notice can open, grouped as the picker shows it. */
export function useLinkTargets() {
  const coaches = useApi<Coach[]>('/admin/coaches')
  const types = useApi<LessonType[]>('/admin/lesson-types')
  const products = useApi<PackageProduct[]>('/admin/package-products')
  const typeName = new Map(types.data?.map((t) => [t.id, t.name]))

  const typeOff = (t: LessonType) => (!t.active ? '已停用' : t.adminOnly ? '仅管理员可见' : null)
  const typeChoice = (t: LessonType): Choice => ({
    name: t.name,
    label: t.name,
    value: key({ linkKind: 'lesson_type', linkId: t.id }),
    hint: `打开“${t.name}”的选择时间页`,
    off: typeOff(t),
  })
  const groups: { group: string; children: Choice[] }[] = [
    {
      group: '页面',
      children: LINK_PAGE_KINDS.map((kind) => ({
        name: LINK_KIND_LABELS[kind],
        label: LINK_KIND_LABELS[kind],
        value: key({ linkKind: kind, linkId: null }),
        hint: LINK_PAGE_HINTS[kind],
        off: null,
      })),
    },
    {
      group: '一对一课程',
      children: (types.data ?? []).filter((t) => t.capacity === 1).map(typeChoice),
    },
    { group: '小班课', children: (types.data ?? []).filter((t) => t.capacity > 1).map(typeChoice) },
    {
      group: '教练',
      children: (coaches.data ?? []).map((c) => ({
        name: c.name,
        label: c.title ? `${c.name} · ${c.title}` : c.name,
        value: key({ linkKind: 'coach', linkId: c.id }),
        hint: `打开${c.name}的教练介绍页`,
        off: c.active ? null : '已停用',
      })),
    },
    {
      group: '课时包',
      children: (products.data ?? []).map((p) => {
        const type = types.data?.find((t) => t.id === p.lessonTypeId)
        const typeIssue = type && typeOff(type)
        return {
          name: p.name,
          label: `${p.name} · ${typeName.get(p.lessonTypeId) ?? ''}`,
          value: key({ linkKind: 'package', linkId: p.id }),
          hint: `打开课时包列表，并突出显示“${p.name}”`,
          off: !p.onSale ? '已下架' : typeIssue ? `所属课程${typeIssue}` : null,
        }
      }),
    },
  ]
  const all = new Map(groups.flatMap((g) => g.children.map((c) => [c.value, c])))
  const loading = coaches.loading || types.loading || products.loading
  const error = coaches.error ?? types.error ?? products.error

  /** For lists: the target's kind and name, or 无. */
  const label = (t: LinkTarget) => {
    if (t.linkKind === 'none') return '无'
    if (!isRecordLink(t.linkKind)) return LINK_KIND_LABELS[t.linkKind]
    const choice = all.get(key(t))
    const name = choice?.name ?? (loading || error ? '' : '已删除')
    return `${LINK_KIND_LABELS[t.linkKind]}：${name}${choice?.off ? `（${choice.off}）` : ''}`
  }

  return { groups, all, loading, error, label }
}

export type LinkTargets = ReturnType<typeof useLinkTargets>

/**
 * A searchable picker for where a tap goes in the mini program. Targets students cannot open are
 * listed but greyed out, except the one already chosen, so an old link still shows what it is.
 */
export function LinkPicker({
  value,
  targets,
  onChange,
}: {
  value: LinkTarget
  targets: LinkTargets
  onChange: (value: LinkTarget) => void
}) {
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState(false)
  const escClosesList = useRef(false)
  const current = value.linkKind === 'none' ? undefined : key(value)
  const chosen = current ? targets.all.get(current) : undefined
  const words = search.trim().toLowerCase()
  // Filtered here so a group with no match drops out; a group's name matches all of it.
  const options = targets.groups
    .map((g) => ({
      group: g.group,
      children: g.children.filter(
        (c) => !words || g.group.includes(words) || c.label.toLowerCase().includes(words),
      ),
    }))
    .filter((g) => g.children.length > 0)
    .map((g) => ({
      group: g.group,
      children: g.children.map((c) => ({
        label: c.off ? `${c.label}（${c.off}）` : c.label,
        value: c.value,
        disabled: !!c.off && c.value !== current,
      })),
    }))

  return (
    // Esc closes the list first instead of the dialog around it, which would drop the edits. The
    // list hides itself before the key bubbles here, so whether it was open is noted on the way down.
    // biome-ignore lint/a11y/noStaticElementInteractions: keyboard is handled by the select's input
    <div
      className="link-picker"
      onKeyDownCapture={(e) => {
        escClosesList.current = e.key === 'Escape' && open
      }}
      onKeyDown={(e) => {
        if (escClosesList.current) e.stopPropagation()
      }}
    >
      <Select
        value={current}
        options={options}
        filterable
        clearable
        loading={targets.loading}
        placeholder="不跳转"
        empty={targets.error ?? '没有找到'}
        popupProps={{ overlayInnerStyle: { maxHeight: 360 } }}
        onSearch={setSearch}
        onPopupVisibleChange={(visible) => {
          setOpen(visible)
          if (!visible) setSearch('')
        }}
        onChange={(v) => onChange(v ? parse(String(v)) : NO_LINK)}
      />
      {chosen && (
        <div className={chosen.off ? 'field-help link-picker-warn' : 'field-help'}>
          {chosen.off
            ? `${chosen.name}${chosen.off}，学员点击后不会跳转`
            : `学员点击后${chosen.hint}`}
        </div>
      )}
      {current && !chosen && !targets.loading && !targets.error && (
        <div className="field-help link-picker-warn">原跳转目标已不存在，请重新选择</div>
      )}
    </div>
  )
}
