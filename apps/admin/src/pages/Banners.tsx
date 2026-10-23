import { useEffect, useRef, useState } from 'react'
import {
  Button,
  Card,
  DateRangePicker,
  Dialog,
  Input,
  InputNumber,
  MessagePlugin,
  Popconfirm,
  Select,
  Space,
  Switch,
  Tag,
} from 'tdesign-react'
import { api } from '../api'
import { DataTable } from '../DataTable'
import { Field } from '../Field'
import { fmtDate, isoToPicker, pickerToIso } from '../format'
import { attempt, newKey, useApi, useSubmitting } from '../hooks'
import type { Banner, LessonType, PackageProduct } from '../types'

type BannerForm = Omit<Banner, 'id'>

// Matches the API's upload limit.
const MAX_IMAGE_BYTES = 2 * 1024 * 1024

export function Banners() {
  const banners = useApi<Banner[]>('/admin/banners')
  const products = useApi<PackageProduct[]>('/admin/package-products')
  const types = useApi<LessonType[]>('/admin/lesson-types')
  const [edit, setEdit] = useState<{
    id: number | null
    form: BannerForm
    loaded?: Banner
    key: string
  } | null>(null)
  const submitting = useSubmitting()

  const save = async () => {
    if (!edit) return
    const ok = await attempt(
      () =>
        api(
          edit.id ? 'PUT' : 'POST',
          edit.id ? `/admin/banners/${edit.id}` : '/admin/banners',
          edit.form,
          { ifMatch: edit.loaded, key: edit.key },
        ),
      '已保存',
    )
    if (ok) {
      setEdit(null)
      await banners.reload()
    }
  }

  const remove = async (id: number) => {
    if (await attempt(() => api('DELETE', `/admin/banners/${id}`), '已删除')) await banners.reload()
  }

  const linkLabel = (b: Banner) => {
    if (b.linkKind === 'package')
      return `课时包：${products.data?.find((p) => p.id === b.linkId)?.name ?? ''}`
    if (b.linkKind === 'lesson_type')
      return `课程：${types.data?.find((t) => t.id === b.linkId)?.name ?? ''}`
    return '无'
  }

  return (
    <Card
      title="首页轮播图"
      bordered
      actions={
        <Button
          onClick={() =>
            setEdit({
              id: null,
              form: {
                imageUrl: '',
                title: '',
                linkKind: 'none',
                linkId: null,
                startsAt: null,
                endsAt: null,
                active: true,
                sort: 0,
              },
              key: newKey(),
            })
          }
        >
          新建轮播图
        </Button>
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>
        建议尺寸 750×300。首页公告在“设置”里修改。
      </p>
      <DataTable
        rowKey="id"
        loading={banners.loading}
        data={banners.data ?? []}
        empty={banners.error ?? '还没有轮播图'}
        columns={[
          {
            colKey: 'imageUrl',
            title: '图片',
            cell: ({ row }) => <img className="banner-thumb" src={row.imageUrl} alt={row.title} />,
          },
          { colKey: 'title', title: '标题' },
          { colKey: 'link', title: '点击跳转', cell: ({ row }) => linkLabel(row) },
          {
            colKey: 'time',
            title: '展示时间',
            cell: ({ row }) =>
              row.startsAt || row.endsAt
                ? `${row.startsAt ? fmtDate(row.startsAt) : '不限'} 至 ${row.endsAt ? fmtDate(row.endsAt) : '不限'}`
                : '长期',
          },
          {
            colKey: 'active',
            title: '状态',
            cell: ({ row }) =>
              row.active ? (
                <Tag theme="success" variant="light">
                  展示
                </Tag>
              ) : (
                <Tag variant="light">隐藏</Tag>
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
                    setEdit({ id: row.id, form: { ...row }, loaded: row, key: newKey() })
                  }
                >
                  编辑
                </Button>
                <Popconfirm
                  theme="danger"
                  content="删除这张轮播图？"
                  confirmBtn={{ content: '删除', theme: 'danger' }}
                  cancelBtn="返回"
                  onConfirm={() => remove(row.id)}
                >
                  <Button variant="text" theme="danger">
                    删除
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      {edit && (
        <Dialog
          visible
          width={600}
          header={edit.id ? '编辑轮播图' : '新建轮播图'}
          confirmBtn={{ content: '保存', disabled: !edit.form.imageUrl, loading: submitting }}
          onConfirm={save}
          onClose={() => setEdit(null)}
        >
          <BannerEditor
            value={edit.form}
            products={products.data ?? []}
            types={types.data ?? []}
            // Merged into the latest form, so an upload finishing later keeps what was typed meanwhile.
            onChange={(patch) => setEdit((e) => e && { ...e, form: { ...e.form, ...patch } })}
          />
        </Dialog>
      )}
    </Card>
  )
}

function BannerEditor({
  value: f,
  products,
  types,
  onChange: set,
}: {
  value: BannerForm
  products: PackageProduct[]
  types: LessonType[]
  onChange: (patch: Partial<BannerForm>) => void
}) {
  const [uploading, setUploading] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  // An upload that finishes after the dialog closed must not land on the next banner opened.
  const open = useRef(false)
  useEffect(() => {
    open.current = true
    return () => {
      open.current = false
    }
  }, [])

  const upload = async (file: File | undefined) => {
    if (!file) return
    if (file.size > MAX_IMAGE_BYTES) {
      void MessagePlugin.error('图片不能超过 2MB')
      return
    }
    setUploading(true)
    const form = new FormData()
    form.append('file', file)
    await attempt(async () => {
      const { url } = await api<{ url: string }>('POST', '/admin/uploads', form)
      if (open.current) set({ imageUrl: url })
    })
    setUploading(false)
  }

  const targets =
    f.linkKind === 'package'
      ? products.map((p) => ({ label: p.name, value: p.id }))
      : types.map((t) => ({ label: t.name, value: t.id }))

  return (
    <div className="fields">
      <Field label="图片">
        <input
          ref={fileInput}
          hidden
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={(e) => {
            void upload(e.target.files?.[0])
            // Lets the same file be picked again after a failed upload.
            e.target.value = ''
          }}
        />
        <Space direction="vertical">
          {f.imageUrl && (
            <img
              className="banner-thumb"
              style={{ width: 375, height: 150 }}
              src={f.imageUrl}
              alt=""
            />
          )}
          <Button variant="outline" loading={uploading} onClick={() => fileInput.current?.click()}>
            {f.imageUrl ? '更换图片' : '选择图片'}
          </Button>
          <span className="muted">JPG、PNG 或 WebP，不超过 2MB</span>
        </Space>
      </Field>
      <Field label="标题" help="仅用于识别，不显示在图上">
        <Input value={f.title} maxlength={30} onChange={(v) => set({ title: String(v) })} />
      </Field>
      <Field label="点击跳转">
        <Space>
          <Select
            style={{ width: 120 }}
            value={f.linkKind}
            options={[
              { label: '不跳转', value: 'none' },
              { label: '课时包', value: 'package' },
              { label: '课程', value: 'lesson_type' },
            ]}
            onChange={(v) => set({ linkKind: v as BannerForm['linkKind'], linkId: null })}
          />
          {f.linkKind !== 'none' && (
            <Select
              style={{ width: 220 }}
              value={f.linkId ?? undefined}
              options={targets}
              onChange={(v) => set({ linkId: Number(v) })}
            />
          )}
        </Space>
      </Field>
      <Field label="展示时间" help="不填则一直展示">
        <DateRangePicker
          enableTimePicker
          clearable
          value={[isoToPicker(f.startsAt), isoToPicker(f.endsAt)]}
          onChange={(v) =>
            set({
              startsAt: pickerToIso(String(v?.[0] ?? '')),
              endsAt: pickerToIso(String(v?.[1] ?? '')),
            })
          }
        />
      </Field>
      <Field label="展示">
        <Switch value={f.active} onChange={(v) => set({ active: v })} />
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
