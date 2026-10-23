import { useState } from 'react'
import {
  Button,
  Card,
  Checkbox,
  DateRangePicker,
  Dialog,
  Input,
  InputNumber,
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
import type { Coach, LessonType } from '../types'
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
  title: '',
  bio: '',
  avatarUrl: '',
  active: true,
  sort: 0,
  lessons: [],
}

export function Catalog() {
  const types = useApi<LessonType[]>('/admin/lesson-types')
  const coaches = useApi<Coach[]>('/admin/coaches')
  const [lesson, setLesson] = useState<{ id: number | null; form: LessonForm } | null>(null)
  const [coach, setCoach] = useState<{ id: number | null; form: CoachForm } | null>(null)
  const [binding, setBinding] = useState<Coach | null>(null)
  const [hoursOf, setHoursOf] = useState<Coach | null>(null)

  const saveLesson = async () => {
    if (!lesson) return
    const { id, form } = lesson
    const ok = await attempt(
      () =>
        api(id ? 'PUT' : 'POST', id ? `/admin/lesson-types/${id}` : '/admin/lesson-types', form),
      '已保存',
    )
    if (ok) {
      setLesson(null)
      await types.reload()
    }
  }

  const saveCoach = async () => {
    if (!coach) return
    const { id, form } = coach
    const ok = await attempt(
      () => api(id ? 'PUT' : 'POST', id ? `/admin/coaches/${id}` : '/admin/coaches', form),
      '已保存',
    )
    if (ok) {
      setCoach(null)
      await coaches.reload()
    }
  }

  const typeName = (id: number) => types.data?.find((t) => t.id === id)?.name ?? ''

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title="课程"
        bordered
        actions={
          <Button onClick={() => setLesson({ id: null, form: { ...emptyLesson } })}>
            新建课程
          </Button>
        }
      >
        <Table
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
                  onClick={() => setLesson({ id: row.id, form: { ...row } })}
                >
                  编辑
                </Button>
              ),
            },
          ]}
        />
      </Card>

      <Card
        title="教练"
        bordered
        actions={
          <Button onClick={() => setCoach({ id: null, form: { ...emptyCoach, lessons: [] } })}>
            新建教练
          </Button>
        }
      >
        <Table
          rowKey="id"
          loading={coaches.loading}
          data={coaches.data ?? []}
          empty="还没有教练"
          columns={[
            { colKey: 'name', title: '姓名' },
            { colKey: 'title', title: '头衔' },
            {
              colKey: 'lessons',
              title: '所教课程与价格',
              cell: ({ row }) =>
                row.lessons.length === 0
                  ? '-'
                  : row.lessons
                      .map(
                        (l) =>
                          `${typeName(l.lessonTypeId)} ${l.price === null ? '标准价' : yuan(l.price)}`,
                      )
                      .join('，'),
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
                      const { bound: _b, bindCode: _c, bindCodeExpiresAt: _e, ...form } = row
                      setCoach({
                        id: row.id,
                        form: { ...form, lessons: row.lessons.map((l) => ({ ...l })) },
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

      {lesson && (
        <Dialog
          visible
          width={560}
          header={lesson.id ? '编辑课程' : '新建课程'}
          confirmBtn="保存"
          onConfirm={saveLesson}
          onClose={() => setLesson(null)}
        >
          <LessonEditor value={lesson.form} onChange={(form) => setLesson({ ...lesson, form })} />
        </Dialog>
      )}

      {coach && (
        <Dialog
          visible
          width={640}
          header={coach.id ? '编辑教练' : '新建教练'}
          confirmBtn="保存"
          onConfirm={saveCoach}
          onClose={() => setCoach(null)}
        >
          <CoachEditor
            value={coach.form}
            types={types.data ?? []}
            onChange={(form) => setCoach({ ...coach, form })}
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
      <Field label="标准价" help="教练可单独定价，见教练设置">
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
              <span className="muted">标准价和教练价都按此折扣</span>
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

function CoachEditor({
  value: f,
  types,
  onChange,
}: {
  value: CoachForm
  types: LessonType[]
  onChange: (v: CoachForm) => void
}) {
  const set = (patch: Partial<CoachForm>) => onChange({ ...f, ...patch })
  const link = (id: number) => f.lessons.find((l) => l.lessonTypeId === id)
  const toggle = (id: number, on: boolean) =>
    set({
      lessons: on
        ? [...f.lessons, { lessonTypeId: id, price: null }]
        : f.lessons.filter((l) => l.lessonTypeId !== id),
    })
  const setPrice = (id: number, price: number | null) =>
    set({ lessons: f.lessons.map((l) => (l.lessonTypeId === id ? { ...l, price } : l)) })

  return (
    <div className="fields">
      <Field label="姓名">
        <Input value={f.name} maxlength={20} onChange={(v) => set({ name: String(v) })} />
      </Field>
      <Field label="头衔">
        <Input
          value={f.title}
          maxlength={30}
          placeholder="如 国家二级运动员"
          onChange={(v) => set({ title: String(v) })}
        />
      </Field>
      <Field label="简介">
        <Textarea value={f.bio} maxlength={500} onChange={(v) => set({ bio: String(v) })} />
      </Field>
      <Field label="所教课程">
        <Space direction="vertical" style={{ width: '100%' }}>
          {types.length === 0 && <span className="muted">先新建课程</span>}
          {types.map((t) => {
            const l = link(t.id)
            return (
              <Space key={t.id} align="center">
                <Checkbox checked={!!l} onChange={(v) => toggle(t.id, v)}>
                  {t.name}
                </Checkbox>
                {l && (
                  <Checkbox
                    checked={l.price !== null}
                    onChange={(on) => setPrice(t.id, on ? t.price : null)}
                  >
                    单独定价
                  </Checkbox>
                )}
                {l && l.price === null && <span className="muted">标准价 {yuan(t.price)}</span>}
                {l && l.price !== null && (
                  <InputNumber
                    theme="normal"
                    value={toYuan(l.price)}
                    min={0}
                    decimalPlaces={2}
                    suffix="元"
                    onChange={(v) => setPrice(t.id, toFen(v as number) ?? l.price)}
                  />
                )}
              </Space>
            )
          })}
        </Space>
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
