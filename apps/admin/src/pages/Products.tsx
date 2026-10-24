import { packagePrice } from '@rs/shared'
import { useState } from 'react'
import {
  Button,
  Card,
  Checkbox,
  DateRangePicker,
  Dialog,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
  Tag,
  Textarea,
} from 'tdesign-react'
import { api } from '../api'
import { DataTable } from '../DataTable'
import { ExportButton } from '../ExportButton'
import { Field } from '../Field'
import { defaultSaleWindow, isoToPicker, pickerToIso, toFen, toYuan, yuan } from '../format'
import { attempt, newKey, useApi, useSubmitting } from '../hooks'
import { packageStatusLabel } from '../labels'
import {
  EditorWithPreview,
  PREVIEW_DIALOG_WIDTH,
  PreviewDialog,
} from '../preview/EditorWithPreview'
import type { Coach, CoachCategory, LessonType, PackageProduct } from '../types'

type ProductForm = Omit<PackageProduct, 'id'>

export function Products() {
  const products = useApi<PackageProduct[]>('/admin/package-products')
  const types = useApi<LessonType[]>('/admin/lesson-types')
  const coaches = useApi<Coach[]>('/admin/coaches')
  const categories = useApi<CoachCategory[]>('/admin/coach-categories')
  const [edit, setEdit] = useState<{
    id: number | null
    key: string
    form: ProductForm
    // The product as listed when the edit began, so a save over someone else's change is refused.
    loaded?: PackageProduct
  } | null>(null)
  const [preview, setPreview] = useState<PackageProduct | null>(null)
  const submitting = useSubmitting()

  const regular = (types.data ?? []).filter((t) => !t.isTrial)
  const typeName = (id: number) => types.data?.find((t) => t.id === id)?.name ?? ''
  const coachNames = (ids: number[]) =>
    ids.length === 0
      ? '全部教练'
      : ids.map((id) => coaches.data?.find((c) => c.id === id)?.name ?? '').join('，')

  const save = async () => {
    if (!edit) return
    const ok = await attempt(
      () =>
        api(
          edit.id ? 'PUT' : 'POST',
          edit.id ? `/admin/package-products/${edit.id}` : '/admin/package-products',
          edit.form,
          { key: edit.key, ifMatch: edit.loaded },
        ),
      '已保存',
      {
        onStale: () => {
          setEdit(null)
          void products.reload()
        },
      },
    )
    if (ok) {
      setEdit(null)
      await products.reload()
    }
  }

  const create = () =>
    setEdit({
      key: newKey(),
      id: null,
      form: {
        name: '',
        description: '',
        lessonTypeId: regular[0]?.id ?? 0,
        coachIds: [],
        lessonCount: 10,
        price: 0,
        validityDays: 180,
        onSale: true,
        salePrice: null,
        saleStartsAt: null,
        saleEndsAt: null,
        sort: 0,
      },
    })

  const now = new Date()

  return (
    <Card
      title="课时包"
      bordered
      actions={
        <Space>
          <ExportButton
            kind="packages"
            statuses={Object.entries(packageStatusLabel).map(([value, [label]]) => ({
              value,
              label,
            }))}
          />
          <Button onClick={create} disabled={regular.length === 0}>
            新建课时包
          </Button>
        </Space>
      }
    >
      <DataTable
        rowKey="id"
        loading={products.loading}
        data={products.data ?? []}
        empty="还没有课时包"
        columns={[
          {
            colKey: 'name',
            title: '名称',
            cell: ({ row }) => <span className="nowrap">{row.name}</span>,
          },
          { colKey: 'lessonTypeId', title: '课程', cell: ({ row }) => typeName(row.lessonTypeId) },
          { colKey: 'coachIds', title: '适用教练', cell: ({ row }) => coachNames(row.coachIds) },
          { colKey: 'lessonCount', title: '课时', cell: ({ row }) => `${row.lessonCount} 节` },
          {
            colKey: 'price',
            title: '价格',
            cell: ({ row }) => {
              const p = packagePrice(
                {
                  price: row.price,
                  salePrice: row.salePrice,
                  startsAt: row.saleStartsAt ? new Date(row.saleStartsAt) : null,
                  endsAt: row.saleEndsAt ? new Date(row.saleEndsAt) : null,
                },
                now,
              )
              return (
                <span>
                  {yuan(p.price)}
                  {p.originalPrice !== null && (
                    <span className="strike">{yuan(p.originalPrice)}</span>
                  )}
                </span>
              )
            },
          },
          { colKey: 'validityDays', title: '有效期', cell: ({ row }) => `${row.validityDays} 天` },
          {
            colKey: 'onSale',
            title: '状态',
            cell: ({ row }) =>
              row.onSale ? (
                <Tag theme="success" variant="light">
                  在售
                </Tag>
              ) : (
                <Tag variant="light">下架</Tag>
              ),
          },
          {
            colKey: 'op',
            title: '操作',
            cell: ({ row }) => (
              <Space size={0}>
                <Button
                  variant="text"
                  theme="primary"
                  onClick={() =>
                    setEdit({ key: newKey(), id: row.id, form: { ...row }, loaded: row })
                  }
                >
                  编辑
                </Button>
                <Button variant="text" theme="primary" onClick={() => setPreview(row)}>
                  预览
                </Button>
              </Space>
            ),
          },
        ]}
      />
      {edit && (
        <Dialog
          visible
          width={PREVIEW_DIALOG_WIDTH}
          top={24}
          header={edit.id ? '编辑课时包' : '新建课时包'}
          confirmBtn={{ content: '保存', loading: submitting }}
          onConfirm={save}
          onClose={() => setEdit(null)}
        >
          <EditorWithPreview draft={{ kind: 'package', id: edit.id, form: edit.form }}>
            <ProductEditor
              value={edit.form}
              types={regular}
              coaches={coaches.data ?? []}
              categories={categories.data ?? []}
              onChange={(form) => setEdit({ ...edit, form })}
            />
          </EditorWithPreview>
        </Dialog>
      )}
      {preview && (
        <PreviewDialog
          title={`预览：${preview.name}`}
          draft={{ kind: 'package', id: preview.id, form: preview }}
          onClose={() => setPreview(null)}
        />
      )}
    </Card>
  )
}

function ProductEditor({
  value: f,
  types,
  coaches,
  categories,
  onChange,
}: {
  value: ProductForm
  types: LessonType[]
  coaches: Coach[]
  categories: CoachCategory[]
  onChange: (v: ProductForm) => void
}) {
  const set = (patch: Partial<ProductForm>) => onChange({ ...f, ...patch })
  const teaching = coaches.filter((c) => c.lessonTypeIds.includes(f.lessonTypeId))
  // A package usually matches one price level, so offer each category's coaches in one click.
  const groups = categories.flatMap((cat) => {
    const ids = teaching.filter((c) => c.categoryId === cat.id).map((c) => c.id)
    return ids.length ? [{ name: cat.name, ids }] : []
  })
  return (
    <div className="fields">
      <Field label="名称">
        <Input
          value={f.name}
          maxlength={30}
          placeholder="如：私教 10 次卡"
          onChange={(v) => set({ name: String(v) })}
        />
      </Field>
      <Field label="说明">
        <Textarea
          value={f.description}
          maxlength={500}
          onChange={(v) => set({ description: String(v) })}
        />
      </Field>
      <Field label="课程">
        <Select
          value={f.lessonTypeId}
          options={types.map((t) => ({ label: t.name, value: t.id }))}
          onChange={(v) => set({ lessonTypeId: Number(v), coachIds: [] })}
        />
      </Field>
      <Field label="适用教练" help="不选则教这门课的所有教练都可用">
        <Select
          multiple
          clearable
          value={f.coachIds}
          placeholder="全部教练"
          options={teaching.map((c) => ({ label: c.name, value: c.id }))}
          onChange={(v) => set({ coachIds: (v as number[]).map(Number) })}
        />
        {groups.length > 0 && (
          <Space size={4} className="quick-picks">
            {groups.map((g) => (
              <Button
                key={g.name}
                size="small"
                variant="outline"
                onClick={() => set({ coachIds: [...new Set([...f.coachIds, ...g.ids])] })}
              >
                添加全部{g.name}
              </Button>
            ))}
          </Space>
        )}
      </Field>
      <Field label="课时数">
        <InputNumber
          theme="normal"
          value={f.lessonCount}
          min={1}
          max={200}
          suffix="节"
          onChange={(v) => set({ lessonCount: Number(v) || 1 })}
        />
      </Field>
      <Field label="价格">
        <InputNumber
          theme="normal"
          value={toYuan(f.price)}
          min={0.01}
          decimalPlaces={2}
          suffix="元"
          onChange={(v) => set({ price: toFen(v as number) ?? 0 })}
        />
      </Field>
      <Field label="有效期" help="从购买当天起计算">
        <InputNumber
          theme="normal"
          value={f.validityDays}
          min={1}
          max={3650}
          suffix="天"
          onChange={(v) => set({ validityDays: Number(v) || 1 })}
        />
      </Field>
      <Field label="限时价">
        <Space direction="vertical">
          <Checkbox
            checked={f.salePrice !== null}
            onChange={(on) =>
              set(
                on
                  ? { salePrice: f.price, ...defaultSaleWindow() }
                  : { salePrice: null, saleStartsAt: null, saleEndsAt: null },
              )
            }
          >
            设置限时价
          </Checkbox>
          {f.salePrice !== null && (
            <>
              <InputNumber
                theme="normal"
                value={toYuan(f.salePrice)}
                min={0.01}
                decimalPlaces={2}
                suffix="元"
                onChange={(v) => set({ salePrice: toFen(v as number) ?? f.salePrice })}
              />
              <DateRangePicker
                enableTimePicker
                value={[isoToPicker(f.saleStartsAt), isoToPicker(f.saleEndsAt)]}
                onChange={(v) =>
                  set({
                    saleStartsAt: pickerToIso(String(v[0] ?? '')),
                    saleEndsAt: pickerToIso(String(v[1] ?? '')),
                  })
                }
              />
            </>
          )}
        </Space>
      </Field>
      <Field label="在售">
        <Switch value={f.onSale} onChange={(v) => set({ onSale: v })} />
      </Field>
      <Field label="排序">
        <InputNumber
          theme="normal"
          value={f.sort}
          onChange={(v) => set({ sort: Number(v) || 0 })}
        />
      </Field>
    </div>
  )
}
