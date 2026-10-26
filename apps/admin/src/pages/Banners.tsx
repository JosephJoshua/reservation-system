import { useState } from 'react'
import {
  Button,
  Card,
  DateRangePicker,
  Dialog,
  Input,
  Popconfirm,
  Space,
  Switch,
} from 'tdesign-react'
import { api } from '../api'
import { DataTable } from '../DataTable'
import { Field } from '../Field'
import { fmtDate, isoToPicker, pickerToIso } from '../format'
import { type ApiData, attempt, newKey, useSubmitting } from '../hooks'
import { BANNER_IMAGE, useImageUpload } from '../ImageCrop'
import { LinkPicker, type LinkTargets, useLinkTargets } from '../LinkPicker'
import {
  EditorWithPreview,
  PREVIEW_DIALOG_WIDTH,
  PreviewDialog,
} from '../preview/EditorWithPreview'
import { useReorder } from '../Reorder'
import type { Banner } from '../types'
import { ListSwitch, toggle } from '../undo'

type BannerForm = Omit<Banner, 'id'>

/** The 首页轮播图 list of 首页内容, which loads the banners so its preview shows them too. */
export function Banners({
  banners,
  onPreview,
}: {
  banners: ApiData<Banner[]>
  /** Shows a banner in the page's own preview; without it 预览 opens a dialog. */
  onPreview?: (banner: Banner) => void
}) {
  const targets = useLinkTargets()
  const [edit, setEdit] = useState<{
    id: number | null
    form: BannerForm
    loaded?: Banner
    key: string
  } | null>(null)
  const [preview, setPreview] = useState<Banner | null>(null)
  const submitting = useSubmitting()
  const move = useReorder('banners', banners.setData, banners.reload)

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
        图片会按轮播图的比例裁剪。
      </p>
      <DataTable
        rowKey="id"
        loading={banners.loading}
        data={banners.data ?? []}
        reorder={{ move }}
        onOpen={(row) => setEdit({ id: row.id, form: { ...row }, loaded: row, key: newKey() })}
        empty={banners.error ?? '还没有轮播图'}
        columns={[
          {
            colKey: 'imageUrl',
            title: '图片',
            width: 104,
            cell: ({ row }) => <img className="banner-thumb" src={row.imageUrl} alt={row.title} />,
          },
          {
            colKey: 'title',
            title: '轮播图',
            // Title over where it leads and when it shows, so the list fits beside the preview.
            cell: ({ row }) => (
              <div className="banner-row">
                <div className="banner-row-title">
                  <span>{row.title || '无标题'}</span>
                  <ListSwitch
                    path={`/admin/banners/${row.id}`}
                    value={row.active}
                    // TDesign leaves the state out for screen readers.
                    aria-checked={row.active}
                    label={['显示', '隐藏']}
                    aria-label={`${row.title || '无标题'} 显示`}
                    onChange={(v) =>
                      void toggle({
                        path: `/admin/banners/${row.id}`,
                        row,
                        change: { active: Boolean(v) },
                        done: v ? '已显示这张轮播图' : '已隐藏这张轮播图',
                        reload: banners.reload,
                      })
                    }
                  />
                </div>
                <div className="banner-row-meta">
                  跳转：{targets.label(row)}
                  <br />
                  展示：
                  {row.startsAt || row.endsAt
                    ? `${row.startsAt ? fmtDate(row.startsAt) : '不限'} 至 ${row.endsAt ? fmtDate(row.endsAt) : '不限'}`
                    : '长期'}
                </div>
              </div>
            ),
          },
          {
            colKey: 'op',
            title: '操作',
            width: 204,
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
                <Button
                  variant="text"
                  theme="primary"
                  onClick={() => (onPreview ? onPreview(row) : setPreview(row))}
                >
                  预览
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
          width={PREVIEW_DIALOG_WIDTH}
          top={24}
          header={edit.id ? '编辑轮播图' : '新建轮播图'}
          confirmBtn={{ content: '保存', disabled: !edit.form.imageUrl, loading: submitting }}
          onConfirm={save}
          onClose={() => setEdit(null)}
        >
          <EditorWithPreview draft={{ kind: 'banner', id: edit.id, form: edit.form }}>
            <BannerEditor
              value={edit.form}
              targets={targets}
              // Merged into the latest form, so an upload finishing later keeps what was typed meanwhile.
              onChange={(patch) => setEdit((e) => e && { ...e, form: { ...e.form, ...patch } })}
            />
          </EditorWithPreview>
        </Dialog>
      )}
      {preview && (
        <PreviewDialog
          title={`预览：${preview.title || '轮播图'}`}
          draft={{ kind: 'banner', id: preview.id, form: preview }}
          onClose={() => setPreview(null)}
        />
      )}
    </Card>
  )
}

function BannerEditor({
  value: f,
  targets,
  onChange: set,
}: {
  value: BannerForm
  targets: LinkTargets
  onChange: (patch: Partial<BannerForm>) => void
}) {
  const image = useImageUpload(BANNER_IMAGE, (url) => set({ imageUrl: url }))

  return (
    <div className="fields">
      <Field label="图片">
        {image.element}
        <Space direction="vertical">
          {f.imageUrl && <img className="banner-thumb large" src={f.imageUrl} alt="" />}
          <Space>
            <Button variant="outline" onClick={image.pick}>
              {f.imageUrl ? '更换图片' : '选择图片'}
            </Button>
            {f.imageUrl && (
              <Button variant="text" onClick={() => image.edit(f.imageUrl)}>
                裁剪
              </Button>
            )}
          </Space>
          <span className="muted">支持 JPG、PNG 或 WebP 格式，选好后可以裁剪和旋转</span>
        </Space>
      </Field>
      <Field label="标题" help="显示在图片底部，不填则不显示">
        <Input value={f.title} maxlength={30} onChange={(v) => set({ title: String(v) })} />
      </Field>
      <Field label="点击跳转">
        <LinkPicker value={f} targets={targets} onChange={set} />
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
    </div>
  )
}
