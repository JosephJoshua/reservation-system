import { packagePrice } from '@rs/shared'
import { useState } from 'react'
import {
  Button,
  Card,
  Checkbox,
  DateRangePicker,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
  Textarea,
} from 'tdesign-react'
import { DataTable } from '../DataTable'
import { EditPage, useRecordId } from '../EditPage'
import { ExportButton } from '../ExportButton'
import { Field } from '../Field'
import { defaultSaleWindow, isoToPicker, pickerToIso, toFen, toYuan, yuan } from '../format'
import { type ApiData, useApi } from '../hooks'
import { packageStatusLabel } from '../labels'
import type { ProductForm } from '../preview/data'
import { PreviewDialog } from '../preview/EditorWithPreview'
import { useReorder } from '../Reorder'
import { leaveTo } from '../SaveBar'
import type { Coach, CoachCategory, LessonType, PackageProduct } from '../types'
import { ListSwitch, toggle } from '../undo'

const LIST = { label: '课时包', hash: '#/products' }

const productForm = ({ id: _id, ...form }: PackageProduct): ProductForm => form

/** 课时包: the packages students buy, each edited on its own page at `#/products/<id>`. */
export function Products() {
  const products = useApi<PackageProduct[]>('/admin/package-products')
  const types = useApi<LessonType[]>('/admin/lesson-types')
  const coaches = useApi<Coach[]>('/admin/coaches')
  const categories = useApi<CoachCategory[]>('/admin/coach-categories')
  const id = useRecordId()
  const regular = (types.data ?? []).filter((t) => !t.isTrial)
  if (id)
    return (
      <EditPage
        key={id}
        id={id}
        rows={products}
        path="/admin/package-products"
        list={LIST}
        noun="课时包"
        blank={() => ({
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
        })}
        toForm={productForm}
        name={(f) => f.name.trim()}
        check={(f) =>
          !f.name.trim()
            ? '请填写课时包名称'
            : !regular.some((t) => t.id === f.lessonTypeId)
              ? '请选择课程'
              : f.price <= 0
                ? '请填写价格'
                : null
        }
        draft={(form) => ({ kind: 'package', id: id === 'new' ? null : id, form })}
      >
        {(form, set) => (
          <ProductEditor
            value={form}
            types={regular}
            coaches={coaches.data ?? []}
            categories={categories.data ?? []}
            onChange={set}
          />
        )}
      </EditPage>
    )
  return (
    <ProductList
      products={products}
      types={types.data ?? []}
      coaches={coaches.data ?? []}
      canCreate={regular.length > 0}
    />
  )
}

function ProductList({
  products,
  types,
  coaches,
  canCreate,
}: {
  products: ApiData<PackageProduct[]>
  types: LessonType[]
  coaches: Coach[]
  canCreate: boolean
}) {
  const [preview, setPreview] = useState<PackageProduct | null>(null)
  const move = useReorder('package-products', products.setData, products.reload)
  const open = (row: PackageProduct) => void leaveTo(`${LIST.hash}/${row.id}`)

  const typeName = (id: number) => types.find((t) => t.id === id)?.name ?? ''
  const coachNames = (ids: number[]) =>
    ids.length === 0
      ? '全部教练'
      : ids.map((id) => coaches.find((c) => c.id === id)?.name ?? '').join('，')

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
          <Button onClick={() => void leaveTo(`${LIST.hash}/new`)} disabled={!canCreate}>
            新建课时包
          </Button>
        </Space>
      }
    >
      <DataTable
        rowKey="id"
        loading={products.loading}
        data={products.data ?? []}
        reorder={{ move }}
        onOpen={open}
        empty={products.error ?? '还没有课时包'}
        columns={[
          {
            colKey: 'name',
            title: '名称',
            width: 180,
            cell: ({ row }) => (
              <a className="nowrap" href={`${LIST.hash}/${row.id}`}>
                {row.name}
              </a>
            ),
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
            // Takes effect at once, with 撤销 in the message instead of a confirmation.
            cell: ({ row }) => (
              <ListSwitch
                path={`/admin/package-products/${row.id}`}
                value={row.onSale}
                // TDesign leaves the state out for screen readers.
                aria-checked={row.onSale}
                label={['在售', '下架']}
                aria-label={`${row.name} 在售`}
                onChange={(v) =>
                  void toggle({
                    path: `/admin/package-products/${row.id}`,
                    row,
                    change: { onSale: Boolean(v) },
                    done: v ? `已上架：${row.name}` : `已下架：${row.name}`,
                    reload: products.reload,
                  })
                }
              />
            ),
          },
          {
            colKey: 'op',
            title: '操作',
            width: 150,
            cell: ({ row }) => (
              <Space size={0}>
                <Button variant="text" theme="primary" onClick={() => open(row)}>
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
  onChange: (patch: Partial<ProductForm>) => void
}) {
  const set = onChange
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
          // A new package opened before the courses loaded has none picked yet.
          value={types.some((t) => t.id === f.lessonTypeId) ? f.lessonTypeId : undefined}
          placeholder="请选择课程"
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
    </div>
  )
}
