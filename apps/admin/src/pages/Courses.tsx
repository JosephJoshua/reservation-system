import { type BookingRules, ownRuleLabels, type VenueSettings } from '@rs/shared'
import { useState } from 'react'
import {
  Button,
  Card,
  Checkbox,
  DateRangePicker,
  Input,
  InputNumber,
  Space,
  Switch,
  Tag,
  Textarea,
  Tooltip,
} from 'tdesign-react'
import { RuleOverrideFields } from '../BookingRules'
import { DataTable } from '../DataTable'
import { EditPage, useRecordId } from '../EditPage'
import { Field } from '../Field'
import {
  defaultSaleWindow,
  fmtDate,
  fmtLastDay,
  isoToPicker,
  pickerToIso,
  toFen,
  toYuan,
  yuan,
} from '../format'
import { type ApiData, useApi } from '../hooks'
import type { LessonForm } from '../preview/data'
import { PreviewDialog } from '../preview/EditorWithPreview'
import { useReorder } from '../Reorder'
import { leaveTo } from '../SaveBar'
import type { LessonType } from '../types'
import { ListSwitch, toggle } from '../undo'

const LIST = { label: '课程', hash: '#/courses' }

const blankLesson = (): LessonForm => ({
  name: '',
  description: '',
  durationMinutes: 60,
  price: 0,
  isTrial: false,
  capacity: 1,
  minStudents: null,
  studentsPerTable: null,
  adminOnly: false,
  active: true,
  salePercent: null,
  saleStartsAt: null,
  saleEndsAt: null,
  sort: 0,
  rules: {},
})

const lessonForm = ({ id: _id, ...form }: LessonType): LessonForm => form

/** 课程: the lesson types students book, each edited on its own page at `#/courses/<id>`. */
export function Courses() {
  const types = useApi<LessonType[]>('/admin/lesson-types')
  const id = useRecordId()
  if (id) return <CourseEditPage key={id} id={id} types={types} />
  return <CourseList types={types} />
}

function CourseList({ types }: { types: ApiData<LessonType[]> }) {
  const [preview, setPreview] = useState<LessonType | null>(null)
  const move = useReorder('lesson-types', types.setData, types.reload)
  const open = (row: LessonType) => void leaveTo(`${LIST.hash}/${row.id}`)

  return (
    <Card
      title="课程"
      bordered
      actions={<Button onClick={() => void leaveTo(`${LIST.hash}/new`)}>新建课程</Button>}
    >
      <DataTable
        rowKey="id"
        loading={types.loading}
        data={types.data ?? []}
        reorder={{ move }}
        onOpen={open}
        empty={types.error ?? '还没有课程'}
        columns={[
          {
            colKey: 'name',
            title: '名称',
            cell: ({ row }) => (
              <div className="name-tags">
                <a className="nowrap" href={`${LIST.hash}/${row.id}`}>
                  {row.name}
                </a>
                {row.isTrial && (
                  <Tag theme="warning" variant="light">
                    体验课
                  </Tag>
                )}
                {row.capacity > 1 && (
                  <Tag theme="primary" variant="light">
                    小班课 · {row.capacity} 人
                  </Tag>
                )}
                {row.adminOnly && <Tag variant="light">仅测试</Tag>}
              </div>
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
                ? `${row.salePercent / 10} 折，${row.saleStartsAt ? fmtDate(row.saleStartsAt) : ''} 至 ${row.saleEndsAt ? fmtLastDay(row.saleEndsAt) : ''}`
                : '-',
          },
          {
            colKey: 'rules',
            title: '预约规则',
            cell: ({ row }) => {
              const own = ownRuleLabels(row.rules)
              return own.length ? (
                <Tooltip content={`单独设置：${own.join('、')}`}>
                  <Tag theme="primary" variant="light">
                    单独设置 {own.length} 项
                  </Tag>
                </Tooltip>
              ) : (
                <span className="muted-strong">默认</span>
              )
            },
          },
          {
            colKey: 'active',
            title: '状态',
            // Takes effect at once, with 撤销 in the message instead of a confirmation.
            cell: ({ row }) => (
              <ListSwitch
                path={`/admin/lesson-types/${row.id}`}
                value={row.active}
                // TDesign leaves the state out for screen readers.
                aria-checked={row.active}
                label={['启用', '停用']}
                aria-label={`${row.name} 启用`}
                onChange={(v) =>
                  void toggle({
                    path: `/admin/lesson-types/${row.id}`,
                    row,
                    change: { active: Boolean(v) },
                    done: v ? `已启用：${row.name}` : `已停用：${row.name}`,
                    reload: types.reload,
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
          draft={{ kind: 'lessonType', id: preview.id, form: preview }}
          onClose={() => setPreview(null)}
        />
      )}
    </Card>
  )
}

function CourseEditPage({ id, types }: { id: number | 'new'; types: ApiData<LessonType[]> }) {
  // The venue's 默认预约规则, which a lesson type follows where it sets none of its own.
  const venue = useApi<VenueSettings>('/admin/settings')
  return (
    <EditPage
      id={id}
      rows={types}
      path="/admin/lesson-types"
      list={LIST}
      noun="课程"
      blank={blankLesson}
      toForm={lessonForm}
      name={(f) => f.name.trim()}
      check={(f) => (f.name.trim() ? null : '请填写课程名称')}
      draft={(form) => ({ kind: 'lessonType', id: id === 'new' ? null : id, form })}
    >
      {(form, set) => (
        <LessonEditor
          value={form}
          ruleDefaults={venue.data?.booking ?? null}
          ruleDefaultsError={venue.error}
          onRetryDefaults={venue.reload}
          onChange={set}
        />
      )}
    </EditPage>
  )
}

function LessonEditor({
  value: f,
  ruleDefaults,
  ruleDefaultsError,
  onRetryDefaults,
  onChange,
}: {
  value: LessonForm
  ruleDefaults: BookingRules | null
  ruleDefaultsError: string | null
  onRetryDefaults: () => void
  onChange: (patch: Partial<LessonForm>) => void
}) {
  const set = onChange
  return (
    <div className="fields">
      <Field label="名称">
        <Input
          value={f.name}
          maxlength={30}
          placeholder="如：一对一私教"
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
      <Field label="上课人数" help="多于 1 人为小班课，在日程页按节安排">
        <div className="stack">
          <InputNumber
            theme="normal"
            value={f.capacity}
            min={1}
            max={30}
            suffix="人"
            onChange={(v) => {
              const capacity = Math.max(1, Math.min(30, Number(v) || 1))
              set({
                capacity,
                // A minimum only makes sense for a group, and never above its size.
                minStudents:
                  capacity === 1 || f.minStudents === null
                    ? null
                    : Math.min(f.minStudents, capacity),
                studentsPerTable:
                  capacity === 1 || f.studentsPerTable === null
                    ? null
                    : Math.min(f.studentsPerTable, capacity),
              })
            }}
          />
          {f.capacity > 1 && (
            <Checkbox
              checked={f.minStudents !== null}
              onChange={(on) => set({ minStudents: on ? Math.min(2, f.capacity) : null })}
            >
              设置最低开班人数
            </Checkbox>
          )}
          {f.capacity > 1 && f.minStudents !== null && (
            <>
              <InputNumber
                theme="normal"
                value={f.minStudents}
                min={2}
                max={f.capacity}
                suffix="人"
                onChange={(v) =>
                  set({ minStudents: Math.max(2, Math.min(f.capacity, Number(v) || 2)) })
                }
              />
              <span className="muted">到免费取消截止时如果人数不足，整节课会自动取消并退款</span>
            </>
          )}
        </div>
      </Field>
      {f.capacity > 1 && (
        <Field label="每张球台" help="按报名人数占用球台，留空则整班共用一张台">
          <InputNumber
            theme="normal"
            value={f.studentsPerTable ?? undefined}
            min={1}
            max={f.capacity}
            placeholder="整班一张"
            suffix="人"
            onChange={(v) => {
              const n = Math.floor(Number(v))
              set({
                studentsPerTable:
                  v === '' || v === undefined || Number.isNaN(n)
                    ? null
                    : Math.max(1, Math.min(f.capacity, n)),
              })
            }}
          />
        </Field>
      )}
      <Field label="标准价" help="教练类别可以单独定价，小班课填每人的价格">
        <InputNumber
          theme="normal"
          value={toYuan(f.price)}
          min={0}
          max={100_000}
          allowInputOverLimit={false}
          decimalPlaces={2}
          suffix="元"
          // Emptied or negative is not a price, so the last one stays. ¥0 has to be typed.
          onChange={(v) => set({ price: toFen(v as number) ?? f.price })}
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
              <span className="muted">标准价和类别价都按这个折扣计算</span>
            </>
          )}
        </Space>
      </Field>
      <Field label="选项">
        <Space direction="vertical">
          <Checkbox
            checked={f.isTrial}
            disabled={f.capacity > 1 && !f.isTrial}
            onChange={(v) => set({ isTrial: v })}
          >
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
      <div className="form-section">
        <div className="form-section-title">预约规则</div>
        <div className="muted">
          没有单独设置的规则，都按设置页的默认预约规则，默认改了也会跟着变。
        </div>
        {!ruleDefaults && ruleDefaultsError && (
          <div className="field-error">
            默认规则没有加载出来，暂时不能单独设置。
            <Button variant="text" theme="primary" size="small" onClick={onRetryDefaults}>
              重试
            </Button>
          </div>
        )}
      </div>
      <RuleOverrideFields
        value={f.rules}
        defaults={ruleDefaults}
        onChange={(rules) => set({ rules })}
      />
    </div>
  )
}
