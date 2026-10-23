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
  Table,
  Tag,
  Textarea,
} from 'tdesign-react'
import { api } from '../api'
import { Field } from '../Field'
import { defaultSaleWindow, isoToPicker, pickerToIso, toFen, toYuan, yuan } from '../format'
import { attempt, useApi } from '../hooks'
import type { Coach, LessonType, PackageProduct } from '../types'

type ProductForm = Omit<PackageProduct, 'id'>

export function Products() {
  const products = useApi<PackageProduct[]>('/admin/package-products')
  const types = useApi<LessonType[]>('/admin/lesson-types')
  const coaches = useApi<Coach[]>('/admin/coaches')
  const [edit, setEdit] = useState<{ id: number | null; form: ProductForm } | null>(null)

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
        ),
      '已保存',
    )
    if (ok) {
      setEdit(null)
      await products.reload()
    }
  }

  const create = () =>
    setEdit({
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
        <Button onClick={create} disabled={regular.length === 0}>
          新建课时包
        </Button>
      }
    >
      <Table
        rowKey="id"
        loading={products.loading}
        data={products.data ?? []}
        empty="还没有课时包"
        columns={[
          { colKey: 'name', title: '名称' },
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
              <Button
                variant="text"
                theme="primary"
                onClick={() => setEdit({ id: row.id, form: { ...row } })}
              >
                编辑
              </Button>
            ),
          },
        ]}
      />
      {edit && (
        <Dialog
          visible
          width={600}
          header={edit.id ? '编辑课时包' : '新建课时包'}
          confirmBtn="保存"
          onConfirm={save}
          onClose={() => setEdit(null)}
        >
          <ProductEditor
            value={edit.form}
            types={regular}
            coaches={coaches.data ?? []}
            onChange={(form) => setEdit({ ...edit, form })}
          />
        </Dialog>
      )}
    </Card>
  )
}

function ProductEditor({
  value: f,
  types,
  coaches,
  onChange,
}: {
  value: ProductForm
  types: LessonType[]
  coaches: Coach[]
  onChange: (v: ProductForm) => void
}) {
  const set = (patch: Partial<ProductForm>) => onChange({ ...f, ...patch })
  const teaching = coaches.filter((c) => c.lessons.some((l) => l.lessonTypeId === f.lessonTypeId))
  return (
    <div className="fields">
      <Field label="名称">
        <Input
          value={f.name}
          maxlength={30}
          placeholder="如 私教 10 次卡"
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
      <Field label="适用教练" help="不选则该课程的全部教练可用">
        <Select
          multiple
          clearable
          value={f.coachIds}
          placeholder="全部教练"
          options={teaching.map((c) => ({ label: c.name, value: c.id }))}
          onChange={(v) => set({ coachIds: (v as number[]).map(Number) })}
        />
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
      <Field label="有效期" help="自购买日起">
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
