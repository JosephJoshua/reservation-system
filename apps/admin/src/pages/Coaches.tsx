import { useEffect, useRef, useState } from 'react'
import {
  Button,
  Card,
  Checkbox,
  Dialog,
  Input,
  InputNumber,
  Popconfirm,
  Select,
  Space,
  Switch,
  Tabs,
  Tag,
  TagInput,
} from 'tdesign-react'
import { api } from '../api'
import { DataTable } from '../DataTable'
import { EditPage, useRecordId } from '../EditPage'
import { Field } from '../Field'
import { toFen, toYuan, yuan } from '../format'
import { type ApiData, attempt, hashParam, newKey, onceKey, useApi, useSubmitting } from '../hooks'
import { COACH_PHOTO, useImageUpload } from '../ImageCrop'
import type { CoachForm } from '../preview/data'
import { PreviewDialog } from '../preview/EditorWithPreview'
import { useReorder } from '../Reorder'
import { RichText } from '../RichText'
import { leaveTo } from '../SaveBar'
import type { AdminBooking, Coach, CoachCategory, LessonType } from '../types'
import { ListSwitch, toggle } from '../undo'
import { CoachBindingDialog, CoachScheduleDialog } from './CoachDialogs'

const LIST = { label: '教练', hash: '#/coaches' }

const blankCoach = (): CoachForm => ({
  name: '',
  categoryId: null,
  title: '',
  tags: [],
  profile: '',
  avatarUrl: '',
  active: true,
  sort: 0,
  lessonTypeIds: [],
})

/** A coach as edited: binding to the mini program comes and goes on its own and is not part of it. */
const coachForm = ({
  id: _id,
  bound: _b,
  bindCode: _c,
  bindCodeExpiresAt: _e,
  ...form
}: Coach): CoachForm => form

/** The part of a coach its version covers, which leaves out the binding too. */
const coachVersion = ({ bound: _b, bindCode: _c, bindCodeExpiresAt: _e, ...rest }: Coach) => rest

type CategoryForm = Omit<CoachCategory, 'id'>

const emptyCategory: CategoryForm = { name: '', sort: 0, prices: [], payRates: [] }

/** What a coach in a category charges for a lesson type before any sale. */
function priceIn(category: CoachCategory | undefined, type: LessonType) {
  return category?.prices.find((p) => p.lessonTypeId === type.id)?.price ?? type.price
}

type CoachTab = 'coaches' | 'categories'

/**
 * 教练: the coaches, each edited on its own page at `#/coaches/<id>`, and in a second tab the
 * 教练类别 that set their prices and 课时费.
 */
export function Coaches() {
  const coaches = useApi<Coach[]>('/admin/coaches')
  const types = useApi<LessonType[]>('/admin/lesson-types')
  const categories = useApi<CoachCategory[]>('/admin/coach-categories')
  const id = useRecordId()
  const [tab, setTab] = useState<CoachTab>(() =>
    hashParam('tab') === 'categories' ? 'categories' : 'coaches',
  )
  // Asks the 教练类别 tab for a new category, counting up so each click opens one.
  const [addCategory, setAddCategory] = useState(0)
  if (id)
    return (
      <CoachEditPage
        key={id}
        id={id}
        coaches={coaches}
        types={types.data ?? []}
        categories={categories.data ?? []}
      />
    )
  const pick = (t: CoachTab) => {
    setTab(t)
    // In the address for a refresh or a copied link, without a step for the back button.
    history.replaceState(history.state, '', t === 'coaches' ? LIST.hash : `${LIST.hash}?tab=${t}`)
  }
  return (
    <Tabs
      value={tab}
      onChange={(v) => pick(v as CoachTab)}
      className="detail-tabs"
      action={
        tab === 'coaches' ? (
          <Button onClick={() => void leaveTo(`${LIST.hash}/new`)}>新建教练</Button>
        ) : (
          <Button onClick={() => setAddCategory((n) => n + 1)}>新建类别</Button>
        )
      }
    >
      <Tabs.TabPanel value="coaches" label="教练">
        <CoachList coaches={coaches} types={types.data ?? []} categories={categories.data ?? []} />
      </Tabs.TabPanel>
      <Tabs.TabPanel value="categories" label="教练类别">
        <Categories
          categories={categories}
          types={types.data ?? []}
          coaches={coaches.data ?? []}
          add={addCategory}
        />
      </Tabs.TabPanel>
    </Tabs>
  )
}

function CoachList({
  coaches,
  types,
  categories,
}: {
  coaches: ApiData<Coach[]>
  types: LessonType[]
  categories: CoachCategory[]
}) {
  const [binding, setBinding] = useState<Coach | null>(null)
  const [hoursOf, setHoursOf] = useState<Coach | null>(null)
  const [preview, setPreview] = useState<Coach | null>(null)
  const move = useReorder('coaches', coaches.setData, coaches.reload)
  const categoryOf = (id: number | null) => categories.find((c) => c.id === id)
  const open = (row: Coach) => void leaveTo(`${LIST.hash}/${row.id}`)

  return (
    <Card bordered>
      <DataTable
        rowKey="id"
        loading={coaches.loading}
        data={coaches.data ?? []}
        reorder={{ move }}
        onOpen={open}
        empty={coaches.error ?? '还没有教练'}
        columns={[
          {
            colKey: 'name',
            title: '姓名',
            cell: ({ row }) => (
              <Space size={8} align="center" className="nowrap">
                {row.avatarUrl ? (
                  <img className="avatar-thumb small" src={row.avatarUrl} alt="" />
                ) : null}
                <a href={`${LIST.hash}/${row.id}`}>{row.name}</a>
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
              const taught = types.filter((t) => row.lessonTypeIds.includes(t.id))
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
            // Takes effect at once, with 撤销 in the message instead of a confirmation.
            cell: ({ row }) => (
              <ListSwitch
                path={`/admin/coaches/${row.id}`}
                value={row.active}
                // TDesign leaves the state out for screen readers.
                aria-checked={row.active}
                label={['在职', '停用']}
                aria-label={`${row.name} 在职`}
                onChange={(v) =>
                  void toggle({
                    path: `/admin/coaches/${row.id}`,
                    row,
                    change: { active: Boolean(v) },
                    version: coachVersion,
                    done: v ? `${row.name} 已在职` : `已停用：${row.name}，未上的课会保留`,
                    reload: coaches.reload,
                  })
                }
              />
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
            // Three buttons: wider than an even share at 1360px.
            width: 210,
            cell: ({ row }) => (
              <Space size={0}>
                <Button variant="text" theme="primary" onClick={() => open(row)}>
                  编辑
                </Button>
                <Button variant="text" theme="primary" onClick={() => setHoursOf(row)}>
                  排班
                </Button>
                <Button variant="text" theme="primary" onClick={() => setPreview(row)}>
                  预览
                </Button>
              </Space>
            ),
          },
        ]}
      />
      {binding && (
        <CoachBindingDialog
          coach={binding}
          onClose={() => {
            setBinding(null)
            void coaches.reload()
          }}
        />
      )}
      {hoursOf && <CoachScheduleDialog coach={hoursOf} onClose={() => setHoursOf(null)} />}
      {preview && (
        <PreviewDialog
          title={`预览：${preview.name}`}
          draft={{ kind: 'coach', id: preview.id, form: preview }}
          onClose={() => setPreview(null)}
        />
      )}
    </Card>
  )
}

function CoachEditPage({
  id,
  coaches,
  types,
  categories,
}: {
  id: number | 'new'
  coaches: ApiData<Coach[]>
  types: LessonType[]
  categories: CoachCategory[]
}) {
  const [binding, setBinding] = useState<Coach | null>(null)
  const [hoursOf, setHoursOf] = useState<Coach | null>(null)
  // The coach's lessons still to come, so turning 在职 off can say what happens to them.
  const upcoming = useApi<AdminBooking[]>(
    id === 'new' ? null : `/admin/bookings?coachId=${id}&status=confirmed`,
  )
  return (
    <>
      <EditPage
        id={id}
        rows={coaches}
        path="/admin/coaches"
        list={LIST}
        noun="教练"
        blank={blankCoach}
        toForm={coachForm}
        editable={coachVersion}
        name={(f) => f.name.trim()}
        check={(f) => (f.name.trim() ? null : '请填写教练姓名')}
        draft={(form) => ({ kind: 'coach', id: id === 'new' ? null : id, form })}
        actions={(row) => (
          <Space size={8} breakLine>
            <Button variant="outline" onClick={() => setHoursOf(row)}>
              排班
            </Button>
            <Button variant="outline" onClick={() => setBinding(row)}>
              {row.bound ? '小程序绑定' : '绑定小程序'}
            </Button>
          </Space>
        )}
      >
        {(form, set) => (
          <CoachEditor
            value={form}
            types={types}
            categories={categories}
            upcomingLessons={upcoming.data?.length ?? 0}
            onChange={set}
          />
        )}
      </EditPage>
      {binding && (
        <CoachBindingDialog
          coach={binding}
          onClose={() => {
            setBinding(null)
            void coaches.reload()
          }}
        />
      )}
      {hoursOf && <CoachScheduleDialog coach={hoursOf} onClose={() => setHoursOf(null)} />}
    </>
  )
}

/** 教练类别: a price level for coaches, with its own prices and 课时费. Edited in a dialog. */
function Categories({
  categories,
  types,
  coaches,
  add,
}: {
  categories: ApiData<CoachCategory[]>
  types: LessonType[]
  coaches: Coach[]
  /** Goes up each time 新建类别 is clicked. */
  add: number
}) {
  // `loaded` is the record as listed when an edit began, so a save over someone else's change is refused.
  const [category, setCategory] = useState<{
    id: number | null
    key: string
    form: CategoryForm
    loaded?: CoachCategory
  } | null>(null)
  const submitting = useSubmitting()
  // The count when the tab was shown, so coming back to it doesn't open the dialog again.
  const handled = useRef(add)
  useEffect(() => {
    if (add === handled.current) return
    handled.current = add
    setCategory({ key: newKey(), id: null, form: { ...emptyCategory, prices: [], payRates: [] } })
  }, [add])
  const move = useReorder('coach-categories', categories.setData, categories.reload)

  const edit = (row: CoachCategory) =>
    setCategory({
      key: newKey(),
      id: row.id,
      loaded: row,
      form: {
        name: row.name,
        sort: row.sort,
        prices: row.prices.map((p) => ({ ...p })),
        payRates: row.payRates.map((r) => ({ ...r })),
      },
    })

  const save = async () => {
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
      {
        onStale: () => {
          setCategory(null)
          void categories.reload()
        },
      },
    )
    if (ok) {
      setCategory(null)
      await categories.reload()
    }
  }

  const remove = async (id: number) => {
    const del = () =>
      api('DELETE', `/admin/coach-categories/${id}`, undefined, {
        key: onceKey(`delete-category-${id}`),
      })
    const ok = await attempt(del, '已删除', {
      key: `category-${id}`,
      onStale: categories.reload,
    })
    if (ok) await categories.reload()
  }

  return (
    <Card bordered>
      <DataTable
        rowKey="id"
        loading={categories.loading}
        data={categories.data ?? []}
        reorder={{ move }}
        onOpen={edit}
        empty={categories.error ?? '还没有类别，所有教练都按课程的标准价收费'}
        columns={[
          { colKey: 'name', title: '名称' },
          {
            colKey: 'prices',
            title: '价格',
            cell: ({ row }) => {
              const own = types.filter((t) => row.prices.some((p) => p.lessonTypeId === t.id))
              return own.length === 0
                ? '全部按标准价'
                : own.map((t) => `${t.name} ${yuan(priceIn(row, t))}`).join('，')
            },
          },
          {
            colKey: 'payRates',
            title: '课时费',
            cell: ({ row }) => {
              const rated = types.flatMap((t) => {
                const r = row.payRates.find((p) => p.lessonTypeId === t.id)
                return r ? [`${t.name} ${yuan(r.rate)}`] : []
              })
              return rated.length === 0 ? '未设置' : rated.join('，')
            },
          },
          {
            colKey: 'coaches',
            title: '教练',
            cell: ({ row }) => {
              const names = coaches
                .filter((c) => c.categoryId === row.id)
                .map((c) => c.name)
                .join('，')
              if (!names) return '-'
              // A big category lists its first names; the full list is on hover.
              return (
                <div className="clamp-2" title={names}>
                  {names}
                </div>
              )
            },
          },
          {
            colKey: 'op',
            title: '操作',
            cell: ({ row }) => (
              <Space size={0}>
                <Button variant="text" theme="primary" onClick={() => edit(row)}>
                  编辑
                </Button>
                <Popconfirm
                  theme="danger"
                  content="删除该类别？"
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
      {category && (
        <Dialog
          visible
          width={560}
          header={category.id ? '编辑类别' : '新建类别'}
          cancelBtn="返回"
          confirmBtn={{
            content: '保存',
            disabled: !category.form.name.trim(),
            loading: submitting,
          }}
          onConfirm={save}
          onClose={() => setCategory(null)}
        >
          <CategoryEditor
            value={category.form}
            types={types}
            onChange={(form) => setCategory({ ...category, form })}
          />
        </Dialog>
      )}
    </Card>
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
  const rateOf = (id: number) => f.payRates.find((r) => r.lessonTypeId === id)?.rate
  const setRate = (id: number, rate: number | null) =>
    set({
      payRates: [
        ...f.payRates.filter((r) => r.lessonTypeId !== id),
        ...(rate === null ? [] : [{ lessonTypeId: id, rate }]),
      ],
    })
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
          placeholder="如：主教练、高级教练"
          onChange={(v) => set({ name: String(v) })}
        />
      </Field>
      <Field label="价格" help="没有单独定价的课程按标准价收费">
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
                    max={100_000}
                    allowInputOverLimit={false}
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
      <Field label="课时费" help="每节课付给教练的金额，用于报表。留空即为未设置">
        <Space direction="vertical" style={{ width: '100%' }}>
          {types.length === 0 && <span className="muted">先新建课程</span>}
          {types.map((t) => (
            <Space key={t.id} align="center" className="nowrap">
              <span className="category-lesson" title={t.name}>
                {t.name}
              </span>
              <InputNumber
                theme="normal"
                style={{ width: 160 }}
                value={toYuan(rateOf(t.id))}
                min={0}
                decimalPlaces={2}
                placeholder="未设置"
                suffix="元/节"
                max={100_000}
                allowInputOverLimit={false}
                onChange={(v) => {
                  // Left empty: unset. A negative one is not a rate, so the last one stays.
                  const rate = toFen(v as number)
                  if (rate !== null || v === undefined || v === null || v === '')
                    setRate(t.id, rate)
                }}
              />
            </Space>
          ))}
        </Space>
      </Field>
    </div>
  )
}

function CoachEditor({
  value: f,
  types,
  categories,
  upcomingLessons,
  onChange: set,
}: {
  value: CoachForm
  types: LessonType[]
  categories: CoachCategory[]
  /** Booked lessons of this coach that have not ended. */
  upcomingLessons: number
  /** Takes a patch, not the whole form, so an upload finishing late can't undo newer edits. */
  onChange: (patch: Partial<CoachForm>) => void
}) {
  const photo = useImageUpload(COACH_PHOTO, (url) => set({ avatarUrl: url }))
  const category = categories.find((c) => c.id === f.categoryId)
  const teach = (id: number, on: boolean) =>
    set({
      lessonTypeIds: on ? [...f.lessonTypeIds, id] : f.lessonTypeIds.filter((l) => l !== id),
    })

  return (
    <div className="fields">
      <Field label="姓名">
        <Input value={f.name} maxlength={20} onChange={(v) => set({ name: String(v) })} />
      </Field>
      <Field label="照片" help="支持 JPG、PNG 或 WebP 格式，选好后会裁剪成正方形">
        {photo.element}
        <Space align="center">
          {f.avatarUrl && <img className="avatar-thumb" src={f.avatarUrl} alt="" />}
          <Button variant="outline" onClick={photo.pick}>
            {f.avatarUrl ? '更换照片' : '选择照片'}
          </Button>
          {f.avatarUrl && (
            <>
              <Button variant="text" onClick={() => photo.edit(f.avatarUrl)}>
                裁剪
              </Button>
              <Button variant="text" theme="danger" onClick={() => set({ avatarUrl: '' })}>
                移除
              </Button>
            </>
          )}
        </Space>
      </Field>
      <Field label="类别" help="价格由类别决定">
        <Select
          clearable
          value={f.categoryId ?? undefined}
          placeholder="无类别，按标准价"
          options={categories.map((c) => ({ label: c.name, value: c.id }))}
          onChange={(v) => set({ categoryId: v ? Number(v) : null })}
        />
      </Field>
      <Field label="头衔" help="一句话介绍，显示在教练姓名下方">
        <Input
          value={f.title}
          maxlength={30}
          placeholder="如：前省队队员"
          onChange={(v) => set({ title: String(v) })}
        />
      </Field>
      <Field label="擅长" help="最多 6 个，每个不超过 10 个字，按回车添加">
        <TagInput
          value={f.tags}
          max={6}
          clearable
          placeholder="如：弧圈球、青少年"
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
              <Checkbox checked={f.lessonTypeIds.includes(t.id)} onChange={(v) => teach(t.id, v)}>
                {t.name}
              </Checkbox>
              {f.lessonTypeIds.includes(t.id) && (
                <span className="muted">{yuan(priceIn(category, t))}</span>
              )}
            </Space>
          ))}
        </Space>
      </Field>
      <Field label="介绍" help="可以写比赛成绩、执教经历和教学风格等，会显示在教练主页">
        <RichText value={f.profile} onChange={(profile) => set({ profile })} />
      </Field>
      <Field label="在职">
        <Switch value={f.active} onChange={(v) => set({ active: v })} />
        {!f.active && upcomingLessons > 0 && (
          <div className="field-help danger-text">
            还有 {upcomingLessons} 节课未上。停用后这些课程会保留，但教练无法再登录小程序查看。
          </div>
        )}
      </Field>
    </div>
  )
}
