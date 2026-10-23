import { useEffect, useRef, useState } from 'react'
import {
  Button,
  Card,
  Checkbox,
  DateRangePicker,
  Dialog,
  Input,
  InputNumber,
  Popconfirm,
  Select,
  Space,
  Switch,
  Tag,
  TagInput,
  Textarea,
} from 'tdesign-react'
import { api, uploadImage } from '../api'
import { DataTable } from '../DataTable'
import { Field } from '../Field'
import { defaultSaleWindow, isoToPicker, pickerToIso, toFen, toYuan, yuan } from '../format'
import { attempt, newKey, useApi, useSubmitting } from '../hooks'
import { RichText } from '../RichText'
import type { Coach, CoachCategory, LessonType } from '../types'
import { CoachBindingDialog, CoachHoursDialog } from './CoachDialogs'

type LessonForm = Omit<LessonType, 'id'>

const emptyLesson: LessonForm = {
  name: '',
  description: '',
  durationMinutes: 60,
  price: 0,
  isTrial: false,
  adminOnly: false,
  active: true,
  salePercent: null,
  saleStartsAt: null,
  saleEndsAt: null,
  sort: 0,
}

type CoachForm = Omit<Coach, 'id' | 'bound' | 'bindCode' | 'bindCodeExpiresAt'>

const emptyCoach: CoachForm = {
  name: '',
  categoryId: null,
  title: '',
  tags: [],
  profile: '',
  avatarUrl: '',
  active: true,
  sort: 0,
  lessonTypeIds: [],
}

type CategoryForm = Omit<CoachCategory, 'id'>

const emptyCategory: CategoryForm = { name: '', sort: 0, prices: [] }

/** The record behind an open dialog changed elsewhere: close it and show the current list. */
function closeAndReload(close: (v: null) => void, reload: () => Promise<void>) {
  close(null)
  void reload()
}

/** What a coach in a category charges for a lesson type before any sale. */
function priceIn(category: CoachCategory | undefined, type: LessonType) {
  return category?.prices.find((p) => p.lessonTypeId === type.id)?.price ?? type.price
}

export function Catalog() {
  const types = useApi<LessonType[]>('/admin/lesson-types')
  const coaches = useApi<Coach[]>('/admin/coaches')
  const categories = useApi<CoachCategory[]>('/admin/coach-categories')
  // `loaded` is the record as listed when an edit began, so a save over someone else's change is refused.
  const [category, setCategory] = useState<{
    id: number | null
    key: string
    form: CategoryForm
    loaded?: CoachCategory
  } | null>(null)
  const [lesson, setLesson] = useState<{
    id: number | null
    key: string
    form: LessonForm
    loaded?: LessonType
  } | null>(null)
  const [coach, setCoach] = useState<{
    id: number | null
    key: string
    form: CoachForm
    loaded?: CoachForm
  } | null>(null)
  const [binding, setBinding] = useState<Coach | null>(null)
  const [hoursOf, setHoursOf] = useState<Coach | null>(null)
  const submitting = useSubmitting()

  const saveLesson = async () => {
    if (!lesson) return
    const { id, key, form, loaded } = lesson
    const ok = await attempt(
      () =>
        api(id ? 'PUT' : 'POST', id ? `/admin/lesson-types/${id}` : '/admin/lesson-types', form, {
          key,
          ifMatch: loaded,
        }),
      '已保存',
      { onStale: () => closeAndReload(setLesson, types.reload) },
    )
    if (ok) {
      setLesson(null)
      await types.reload()
    }
  }

  const saveCoach = async () => {
    if (!coach) return
    const { id, key, form, loaded } = coach
    const ok = await attempt(
      () =>
        api(id ? 'PUT' : 'POST', id ? `/admin/coaches/${id}` : '/admin/coaches', form, {
          key,
          ifMatch: loaded,
        }),
      '已保存',
      { onStale: () => closeAndReload(setCoach, coaches.reload) },
    )
    if (ok) {
      setCoach(null)
      await coaches.reload()
    }
  }

  const saveCategory = async () => {
    if (!category) return
    const { id, key, form, loaded } = category
    const ok = await attempt(
      () =>
        api(
          id ? 'PUT' : 'POST',
          id ? `/admin/coach-categories/${id}` : '/admin/coach-categories',
          form,
          { key, ifMatch: loaded },
        ),
      '已保存',
      { onStale: () => closeAndReload(setCategory, categories.reload) },
    )
    if (ok) {
      setCategory(null)
      await categories.reload()
    }
  }

  const deleteCategory = async (id: number) => {
    const ok = await attempt(() => api('DELETE', `/admin/coach-categories/${id}`), '已删除', {
      key: `category-${id}`,
      onStale: categories.reload,
    })
    if (ok) {
      await categories.reload()
    }
  }

  const categoryOf = (id: number | null) => categories.data?.find((c) => c.id === id)

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title="课程"
        bordered
        actions={
          <Button onClick={() => setLesson({ key: newKey(), id: null, form: { ...emptyLesson } })}>
            新建课程
          </Button>
        }
      >
        <DataTable
          rowKey="id"
          loading={types.loading}
          data={types.data ?? []}
          empty="还没有课程"
          columns={[
            {
              colKey: 'name',
              title: '名称',
              cell: ({ row }) => (
                <Space size={4}>
                  {row.name}
                  {row.isTrial && (
                    <Tag theme="warning" variant="light">
                      体验课
                    </Tag>
                  )}
                  {row.adminOnly && <Tag variant="light">仅测试</Tag>}
                </Space>
              ),
            },
            {
              colKey: 'durationMinutes',
              title: '时长',
              cell: ({ row }) => `${row.durationMinutes} 分钟`,
            },
            { colKey: 'price', title: '标准价', cell: ({ row }) => yuan(row.price) },
            {
              colKey: 'sale',
              title: '折扣',
              cell: ({ row }) =>
                row.salePercent
                  ? `${row.salePercent / 10} 折，${isoToPicker(row.saleStartsAt).slice(0, 10)} 至 ${isoToPicker(row.saleEndsAt).slice(0, 10)}`
                  : '-',
            },
            {
              colKey: 'active',
              title: '状态',
              cell: ({ row }) =>
                row.active ? (
                  <Tag theme="success" variant="light">
                    启用
                  </Tag>
                ) : (
                  <Tag variant="light">停用</Tag>
                ),
            },
            {
              colKey: 'op',
              title: '操作',
              cell: ({ row }) => (
                <Button
                  variant="text"
                  theme="primary"
                  onClick={() =>
                    setLesson({ key: newKey(), id: row.id, form: { ...row }, loaded: row })
                  }
                >
                  编辑
                </Button>
              ),
            },
          ]}
        />
      </Card>

      <Card
        title="教练类别"
        bordered
        actions={
          <Button
            onClick={() =>
              setCategory({ key: newKey(), id: null, form: { ...emptyCategory, prices: [] } })
            }
          >
            新建类别
          </Button>
        }
      >
        <DataTable
          rowKey="id"
          loading={categories.loading}
          data={categories.data ?? []}
          empty="还没有类别，教练都按课程标准价"
          columns={[
            { colKey: 'name', title: '名称' },
            {
              colKey: 'prices',
              title: '价格',
              cell: ({ row }) => {
                const own = (types.data ?? []).filter((t) =>
                  row.prices.some((p) => p.lessonTypeId === t.id),
                )
                return own.length === 0
                  ? '全部按标准价'
                  : own.map((t) => `${t.name} ${yuan(priceIn(row, t))}`).join('，')
              },
            },
            {
              colKey: 'coaches',
              title: '教练',
              cell: ({ row }) =>
                (coaches.data ?? [])
                  .filter((c) => c.categoryId === row.id)
                  .map((c) => c.name)
                  .join('，') || '-',
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
                      setCategory({
                        key: newKey(),
                        id: row.id,
                        loaded: row,
                        form: {
                          name: row.name,
                          sort: row.sort,
                          prices: row.prices.map((p) => ({ ...p })),
                        },
                      })
                    }
                  >
                    编辑
                  </Button>
                  <Popconfirm
                    theme="danger"
                    content="删除该类别？"
                    confirmBtn={{ content: '删除', theme: 'danger' }}
                    cancelBtn="返回"
                    onConfirm={() => deleteCategory(row.id)}
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
      </Card>

      <Card
        title="教练"
        bordered
        actions={
          <Button
            onClick={() =>
              setCoach({
                key: newKey(),
                id: null,
                form: { ...emptyCoach, tags: [], lessonTypeIds: [] },
              })
            }
          >
            新建教练
          </Button>
        }
      >
        <DataTable
          rowKey="id"
          loading={coaches.loading}
          data={coaches.data ?? []}
          empty="还没有教练"
          columns={[
            {
              colKey: 'name',
              title: '姓名',
              cell: ({ row }) => (
                <Space size={8} align="center" className="nowrap">
                  {row.avatarUrl ? (
                    <img className="avatar-thumb small" src={row.avatarUrl} alt="" />
                  ) : null}
                  {row.name}
                </Space>
              ),
            },
            {
              colKey: 'category',
              title: '类别',
              cell: ({ row }) => categoryOf(row.categoryId)?.name ?? '-',
            },
            {
              colKey: 'lessons',
              title: '所教课程与价格',
              cell: ({ row }) => {
                const taught = (types.data ?? []).filter((t) => row.lessonTypeIds.includes(t.id))
                return taught.length === 0
                  ? '-'
                  : taught
                      .map((t) => `${t.name} ${yuan(priceIn(categoryOf(row.categoryId), t))}`)
                      .join('，')
              },
            },
            {
              colKey: 'active',
              title: '状态',
              cell: ({ row }) =>
                row.active ? (
                  <Tag theme="success" variant="light">
                    在职
                  </Tag>
                ) : (
                  <Tag variant="light">停用</Tag>
                ),
            },
            {
              colKey: 'bound',
              title: '小程序',
              cell: ({ row }) => (
                <Space size={4} align="center">
                  {row.bound ? (
                    <Tag theme="primary" variant="light">
                      已绑定
                    </Tag>
                  ) : (
                    <span className="muted">未绑定</span>
                  )}
                  <Button variant="text" theme="primary" onClick={() => setBinding(row)}>
                    {row.bound ? '管理' : '绑定'}
                  </Button>
                </Space>
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
                    onClick={() => {
                      // Binding is not part of the edit, here or in the API's version check.
                      const { bound: _b, bindCode: _c, bindCodeExpiresAt: _e, ...form } = row
                      setCoach({
                        key: newKey(),
                        id: row.id,
                        loaded: form,
                        form: {
                          ...form,
                          tags: [...row.tags],
                          lessonTypeIds: [...row.lessonTypeIds],
                        },
                      })
                    }}
                  >
                    编辑
                  </Button>
                  <Button variant="text" theme="primary" onClick={() => setHoursOf(row)}>
                    可约时间
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      {binding && (
        <CoachBindingDialog
          coach={binding}
          onClose={() => {
            setBinding(null)
            void coaches.reload()
          }}
        />
      )}

      {hoursOf && <CoachHoursDialog coach={hoursOf} onClose={() => setHoursOf(null)} />}

      {category && (
        <Dialog
          visible
          width={560}
          header={category.id ? '编辑类别' : '新建类别'}
          confirmBtn={{
            content: '保存',
            disabled: !category.form.name.trim(),
            loading: submitting,
          }}
          onConfirm={saveCategory}
          onClose={() => setCategory(null)}
        >
          <CategoryEditor
            value={category.form}
            types={types.data ?? []}
            onChange={(form) => setCategory({ ...category, form })}
          />
        </Dialog>
      )}

      {lesson && (
        <Dialog
          visible
          width={560}
          header={lesson.id ? '编辑课程' : '新建课程'}
          confirmBtn={{ content: '保存', disabled: !lesson.form.name.trim(), loading: submitting }}
          onConfirm={saveLesson}
          onClose={() => setLesson(null)}
        >
          <LessonEditor value={lesson.form} onChange={(form) => setLesson({ ...lesson, form })} />
        </Dialog>
      )}

      {coach && (
        <Dialog
          visible
          width={760}
          top={40}
          header={coach.id ? '编辑教练' : '新建教练'}
          confirmBtn={{ content: '保存', disabled: !coach.form.name.trim(), loading: submitting }}
          onConfirm={saveCoach}
          onClose={() => setCoach(null)}
        >
          <CoachEditor
            value={coach.form}
            types={types.data ?? []}
            categories={categories.data ?? []}
            onChange={(patch) => setCoach((c) => c && { ...c, form: { ...c.form, ...patch } })}
          />
        </Dialog>
      )}
    </Space>
  )
}

function LessonEditor({
  value: f,
  onChange,
}: {
  value: LessonForm
  onChange: (v: LessonForm) => void
}) {
  const set = (patch: Partial<LessonForm>) => onChange({ ...f, ...patch })
  return (
    <div className="fields">
      <Field label="名称">
        <Input
          value={f.name}
          maxlength={30}
          placeholder="如 一对一私教"
          onChange={(v) => set({ name: String(v) })}
        />
      </Field>
      <Field label="简介">
        <Textarea
          value={f.description}
          maxlength={500}
          onChange={(v) => set({ description: String(v) })}
        />
      </Field>
      <Field label="时长">
        <InputNumber
          theme="normal"
          value={f.durationMinutes}
          min={15}
          max={480}
          step={15}
          suffix="分钟"
          onChange={(v) => set({ durationMinutes: Number(v) || 60 })}
        />
      </Field>
      <Field label="标准价" help="教练类别可单独定价">
        <InputNumber
          theme="normal"
          value={toYuan(f.price)}
          min={0}
          decimalPlaces={2}
          suffix="元"
          onChange={(v) => set({ price: toFen(v as number) ?? 0 })}
        />
      </Field>
      <Field label="折扣">
        <Space direction="vertical">
          <Checkbox
            checked={f.salePercent !== null}
            onChange={(on) =>
              set(
                on
                  ? { salePercent: 90, ...defaultSaleWindow() }
                  : { salePercent: null, saleStartsAt: null, saleEndsAt: null },
              )
            }
          >
            设置限时折扣
          </Checkbox>
          {f.salePercent !== null && (
            <>
              <InputNumber
                theme="normal"
                value={f.salePercent / 10}
                min={0.1}
                max={9.9}
                decimalPlaces={1}
                suffix="折"
                onChange={(v) => set({ salePercent: Math.round((Number(v) || 9) * 10) })}
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
              <span className="muted">标准价和类别价都按此折扣</span>
            </>
          )}
        </Space>
      </Field>
      <Field label="选项">
        <Space direction="vertical">
          <Checkbox checked={f.isTrial} onChange={(v) => set({ isTrial: v })}>
            体验课（每人限次，不能用课时包）
          </Checkbox>
          <Checkbox checked={f.adminOnly} onChange={(v) => set({ adminOnly: v })}>
            仅测试学员可见（用于真实支付测试）
          </Checkbox>
        </Space>
      </Field>
      <Field label="启用">
        <Switch value={f.active} onChange={(v) => set({ active: v })} />
      </Field>
      <Field label="排序" help="数字小的在前">
        <InputNumber
          theme="normal"
          value={f.sort}
          onChange={(v) => set({ sort: Number(v) || 0 })}
        />
      </Field>
    </div>
  )
}

function CategoryEditor({
  value: f,
  types,
  onChange,
}: {
  value: CategoryForm
  types: LessonType[]
  onChange: (v: CategoryForm) => void
}) {
  const set = (patch: Partial<CategoryForm>) => onChange({ ...f, ...patch })
  const own = (id: number) => f.prices.find((p) => p.lessonTypeId === id)
  const setPrice = (id: number, price: number | null) =>
    set({
      prices:
        price === null
          ? f.prices.filter((p) => p.lessonTypeId !== id)
          : own(id)
            ? f.prices.map((p) => (p.lessonTypeId === id ? { ...p, price } : p))
            : [...f.prices, { lessonTypeId: id, price }],
    })
  return (
    <div className="fields">
      <Field label="名称">
        <Input
          value={f.name}
          maxlength={10}
          placeholder="如 主教练、高级教练"
          onChange={(v) => set({ name: String(v) })}
        />
      </Field>
      <Field label="价格" help="不单独定价的课程按标准价">
        <Space direction="vertical" style={{ width: '100%' }}>
          {types.length === 0 && <span className="muted">先新建课程</span>}
          {types.map((t) => {
            const p = own(t.id)
            return (
              <Space key={t.id} align="center" className="nowrap">
                <span className="category-lesson" title={t.name}>
                  {t.name}
                </span>
                <Checkbox checked={!!p} onChange={(on) => setPrice(t.id, on ? t.price : null)}>
                  单独定价
                </Checkbox>
                {p ? (
                  <InputNumber
                    theme="normal"
                    style={{ width: 140 }}
                    value={toYuan(p.price)}
                    min={0}
                    decimalPlaces={2}
                    suffix="元"
                    onChange={(v) => setPrice(t.id, toFen(v as number) ?? p.price)}
                  />
                ) : (
                  <span className="muted">标准价 {yuan(t.price)}</span>
                )}
              </Space>
            )
          })}
        </Space>
      </Field>
      <Field label="排序" help="数字小的在前">
        <InputNumber
          theme="normal"
          value={f.sort}
          onChange={(v) => set({ sort: Number(v) || 0 })}
        />
      </Field>
    </div>
  )
}

function CoachEditor({
  value: f,
  types,
  categories,
  onChange: set,
}: {
  value: CoachForm
  types: LessonType[]
  categories: CoachCategory[]
  /** Takes a patch, not the whole form, so an upload finishing late can't undo newer edits. */
  onChange: (patch: Partial<CoachForm>) => void
}) {
  const [uploading, setUploading] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  // Set in the effect, not the initial value, so StrictMode's remount turns it back on.
  const open = useRef(false)
  useEffect(() => {
    open.current = true
    return () => {
      open.current = false
    }
  }, [])
  const category = categories.find((c) => c.id === f.categoryId)
  const toggle = (id: number, on: boolean) =>
    set({
      lessonTypeIds: on ? [...f.lessonTypeIds, id] : f.lessonTypeIds.filter((l) => l !== id),
    })

  const upload = async (file: File | undefined) => {
    if (!file) return
    setUploading(true)
    await attempt(async () => {
      const url = await uploadImage(file)
      if (open.current) set({ avatarUrl: url })
    })
    setUploading(false)
  }

  return (
    <div className="fields">
      <Field label="姓名">
        <Input value={f.name} maxlength={20} onChange={(v) => set({ name: String(v) })} />
      </Field>
      <Field label="照片" help="正方形，JPG、PNG 或 WebP，不超过 2MB">
        {/* Outside the Space, which would otherwise leave a gap for it. */}
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
        <Space align="center">
          {f.avatarUrl && <img className="avatar-thumb" src={f.avatarUrl} alt="" />}
          <Button variant="outline" loading={uploading} onClick={() => fileInput.current?.click()}>
            {f.avatarUrl ? '更换照片' : '选择照片'}
          </Button>
          {f.avatarUrl && (
            <Button variant="text" theme="danger" onClick={() => set({ avatarUrl: '' })}>
              移除
            </Button>
          )}
        </Space>
      </Field>
      <Field label="类别" help="类别决定价格">
        <Select
          clearable
          value={f.categoryId ?? undefined}
          placeholder="无类别，按标准价"
          options={categories.map((c) => ({ label: c.name, value: c.id }))}
          onChange={(v) => set({ categoryId: v ? Number(v) : null })}
        />
      </Field>
      <Field label="头衔" help="一句话，显示在教练名下">
        <Input
          value={f.title}
          maxlength={30}
          placeholder="如 前省队队员"
          onChange={(v) => set({ title: String(v) })}
        />
      </Field>
      <Field label="擅长" help="最多 6 个，每个不超过 10 字，回车添加">
        <TagInput
          value={f.tags}
          max={6}
          clearable
          placeholder="如 弧圈球、青少年"
          onChange={(v) =>
            set({
              tags: [
                ...new Set(
                  (v as string[]).map((t) => String(t).trim().slice(0, 10)).filter(Boolean),
                ),
              ],
            })
          }
        />
      </Field>
      <Field label="所教课程">
        <Space direction="vertical" style={{ width: '100%' }}>
          {types.length === 0 && <span className="muted">先新建课程</span>}
          {types.map((t) => (
            <Space key={t.id} align="center">
              <Checkbox checked={f.lessonTypeIds.includes(t.id)} onChange={(v) => toggle(t.id, v)}>
                {t.name}
              </Checkbox>
              {f.lessonTypeIds.includes(t.id) && (
                <span className="muted">{yuan(priceIn(category, t))}</span>
              )}
            </Space>
          ))}
        </Space>
      </Field>
      <Field label="介绍" help="比赛成绩、执教经历、教学风格等，显示在教练主页">
        <RichText value={f.profile} onChange={(profile) => set({ profile })} />
      </Field>
      <Field label="在职">
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
