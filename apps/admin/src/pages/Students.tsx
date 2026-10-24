import {
  gripLabels,
  grips,
  PROFILE_MAX_TAGS,
  PROFILE_NOTE_LENGTH,
  PROFILE_TAG_LENGTH,
  packagePrice,
  profileEdit,
  type StudentProfileDto,
  type StudentProfileEdit,
  studentLevelLabels,
  studentLevels,
} from '@rs/shared'
import { useEffect, useState } from 'react'
import {
  Button,
  Card,
  Dialog,
  Drawer,
  Input,
  InputNumber,
  Loading,
  Radio,
  Select,
  Space,
  Switch,
  Tag,
  TagInput,
  Textarea,
} from 'tdesign-react'
import { api } from '../api'
import { BookForStudent } from '../BookForStudent'
import { DataTable } from '../DataTable'
import { ExportButton } from '../ExportButton'
import { Field } from '../Field'
import { fmtDate, fmtDateTime, toFen, toYuan, yuan } from '../format'
import { attempt, useApi, useIdempotencyKey, useIsPhone, useSubmitting } from '../hooks'
import {
  bookingStatusLabel,
  ledgerKindLabel,
  offlineMethodLabel,
  packageStatusLabel,
} from '../labels'
import type { LedgerEntry, PackageProduct, StudentDetail, StudentRow } from '../types'

function idFromHash() {
  const id = Number(new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('id'))
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

export function Students() {
  const [q, setQ] = useState('')
  const [query, setQuery] = useState('')
  const [openId, setOpenId] = useState<number | null>(idFromHash)
  const [expiring, setExpiring] = useState(false)
  const list = useApi<StudentRow[]>(
    `/admin/students?q=${encodeURIComponent(query)}${expiring ? '&expiring=1' : ''}`,
  )

  const { reload } = list
  useEffect(() => {
    const onHash = () => {
      const id = idFromHash()
      setOpenId(id)
      // Closed with the back button: show what changed in the drawer.
      if (id === null) void reload()
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [reload])

  return (
    <div>
      <form
        className="toolbar"
        onSubmit={(e) => {
          e.preventDefault()
          setQuery(q)
        }}
      >
        <Input
          style={{ width: 240 }}
          placeholder="姓名或手机号"
          value={q}
          onChange={(v) => setQ(String(v))}
          clearable
          onClear={() => setQuery('')}
        />
        <Button type="submit">搜索</Button>
        <Select
          style={{ width: 160 }}
          clearable
          placeholder="全部学员"
          value={expiring ? 'expiring' : undefined}
          onChange={(v) => setExpiring(v === 'expiring')}
          options={[{ label: '课时包即将到期', value: 'expiring' }]}
        />
        <span className="spacer" />
        {/* The export lists every student; it has no 即将到期 filter. */}
        {!expiring && (
          <ExportButton
            kind="students"
            filters={{ q: query }}
            filterText={query ? `搜索“${query}”` : undefined}
          />
        )}
      </form>
      {expiring && (
        <p className="muted">
          30 天内到期且有剩余课时的学员，按到期日排序。到期前 7 天会给学员发送提醒。
        </p>
      )}
      <DataTable
        rowKey="id"
        loading={list.loading}
        data={list.data ?? []}
        empty={
          list.error ??
          (query ? '没有找到学员' : expiring ? '30 天内没有到期的课时包' : '还没有学员')
        }
        columns={[
          {
            colKey: 'name',
            title: '姓名',
            cell: ({ row }) =>
              row.deletedAt ? (
                <span className="muted">已注销</span>
              ) : (
                row.name || <span className="muted">未填写</span>
              ),
          },
          { colKey: 'phone', title: '手机号', cell: ({ row }) => row.phone || '-' },
          ...(expiring
            ? [
                {
                  colKey: 'package',
                  title: '课时包',
                  cell: ({ row }: { row: StudentRow }) =>
                    row.expiring && (
                      <>
                        {row.expiring.name}
                        {row.expiring.more > 0 && (
                          <span className="muted"> 等 {row.expiring.more + 1} 个</span>
                        )}
                      </>
                    ),
                },
                {
                  colKey: 'left',
                  title: '剩余',
                  width: 80,
                  cell: ({ row }: { row: StudentRow }) =>
                    row.expiring && `${row.expiring.lessonsRemaining} 节`,
                },
                {
                  colKey: 'expiresAt',
                  title: '有效期至',
                  width: 160,
                  cell: ({ row }: { row: StudentRow }) =>
                    row.expiring && <ExpiryCell expiresAt={row.expiring.expiresAt} />,
                },
                {
                  colKey: 'notice',
                  title: '到期提醒',
                  width: 110,
                  // Refused: the student did not allow the message in WeChat.
                  cell: ({ row }: { row: StudentRow }) =>
                    row.expiring?.notice === 'sent' ? (
                      <Tag variant="light" theme="success">
                        已发送
                      </Tag>
                    ) : (
                      <span className="muted">
                        {row.expiring?.notice === 'refused' ? '学员未订阅' : '-'}
                      </span>
                    ),
                },
              ]
            : [
                {
                  colKey: 'createdAt',
                  title: '注册时间',
                  cell: ({ row }: { row: StudentRow }) => fmtDate(row.createdAt),
                },
              ]),
          {
            colKey: 'tester',
            title: '',
            width: 80,
            cell: ({ row }) => (row.tester ? <Tag variant="light">测试</Tag> : null),
          },
          {
            colKey: 'op',
            title: '操作',
            cell: ({ row }) => (
              // Through the address, so back closes the drawer and refresh keeps it open.
              <Button
                variant="text"
                theme="primary"
                onClick={() => {
                  window.location.hash = `/students?id=${row.id}`
                }}
              >
                查看
              </Button>
            ),
          },
        ]}
      />
      {openId && (
        <StudentDrawer
          id={openId}
          onClose={() => {
            setOpenId(null)
            // Replaced rather than pushed, so back does not open the drawer again.
            if (window.location.hash.includes('?')) history.replaceState(null, '', '#/students')
            void list.reload()
          }}
        />
      )}
    </div>
  )
}

/** The last day a package can be used: it expires at the end of that venue day. */
const lastDay = (expiresAt: string) => fmtDate(new Date(new Date(expiresAt).getTime() - 1))

/** Venue days from today to the last day of a package, 0 when today is its last day. */
const daysLeft = (expiresAt: string) =>
  Math.round(
    (Date.parse(`${lastDay(expiresAt)}T00:00:00Z`) -
      Date.parse(`${fmtDate(new Date())}T00:00:00Z`)) /
      86_400_000,
  )

function ExpiryCell({ expiresAt }: { expiresAt: string }) {
  const days = daysLeft(expiresAt)
  return (
    <>
      {lastDay(expiresAt)}{' '}
      <span className={days < 7 ? 'warning-text' : 'muted'}>
        {days === 0 ? '今天' : `${days} 天后`}
      </span>
    </>
  )
}

function StudentDrawer({ id, onClose }: { id: number; onClose: () => void }) {
  const detail = useApi<StudentDetail>(`/admin/students/${id}`)
  const products = useApi<PackageProduct[]>('/admin/package-products')
  const [selling, setSelling] = useState(false)
  const [booking, setBooking] = useState(false)
  const [editingProfile, setEditingProfile] = useState(false)
  const [action, setAction] = useState<{
    kind: 'grant' | 'extend' | 'ledger'
    packageId: number
  } | null>(null)
  const s = detail.data
  const phone = useIsPhone()

  return (
    <Drawer
      visible
      size={phone ? '100%' : '800px'}
      header={s ? (s.deletedAt ? '已注销的学员' : s.name || '学员') : '学员'}
      footer={false}
      onClose={onClose}
    >
      {!s && detail.error && <p className="muted">{detail.error}</p>}
      {!s && !detail.error && <Loading size="small" />}
      {s && (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          {s.deletedAt ? (
            <span className="muted">
              {fmtDate(s.deletedAt)}{' '}
              注销，姓名、手机号、学员档案和微信身份已删除。订单和上课记录保留。
            </span>
          ) : (
            <Space align="center">
              <span>{s.phone || '未填写手机号'}</span>
              <span className="muted">注册于 {fmtDate(s.createdAt)}</span>
              <span className="muted">测试学员</span>
              <Switch
                size="small"
                value={s.tester}
                onChange={async (v) => {
                  if (await attempt(() => api('PATCH', `/admin/students/${s.id}`, { tester: v })))
                    await detail.reload()
                }}
              />
            </Space>
          )}

          <Card
            title="学员档案"
            bordered
            actions={
              s.deletedAt ? null : (
                <Button size="small" onClick={() => setEditingProfile(true)}>
                  编辑
                </Button>
              )
            }
          >
            <ProfileView profile={s.profile} deleted={Boolean(s.deletedAt)} />
          </Card>

          <Card
            title="课时包"
            bordered
            actions={
              s.deletedAt ? null : (
                <Button size="small" onClick={() => setSelling(true)}>
                  前台售卖
                </Button>
              )
            }
          >
            <DataTable
              rowKey="id"
              data={s.packages}
              empty="没有课时包"
              columns={[
                { colKey: 'name', title: '名称', ellipsis: true },
                {
                  colKey: 'left',
                  title: '剩余',
                  width: 80,
                  cell: ({ row }) =>
                    `${row.lessonsRemaining}/${row.lessonsPurchased + row.lessonsGranted}`,
                },
                {
                  colKey: 'expiresAt',
                  title: '有效期至',
                  width: 120,
                  cell: ({ row }) => lastDay(row.expiresAt),
                },
                { colKey: 'pricePaid', title: '实付', cell: ({ row }) => yuan(row.pricePaid) },
                {
                  colKey: 'status',
                  title: '状态',
                  cell: ({ row }) => {
                    const [label, theme] = packageStatusLabel[row.status]
                    return (
                      <Tag theme={theme} variant="light">
                        {label}
                      </Tag>
                    )
                  },
                },
                {
                  colKey: 'op',
                  title: '操作',
                  width: 180,
                  cell: ({ row }) => (
                    <Space size={0} breakLine={false}>
                      {!s.deletedAt &&
                      (row.status === 'active' ||
                        row.status === 'used_up' ||
                        row.status === 'expired') ? (
                        <>
                          <Button
                            size="small"
                            variant="text"
                            theme="primary"
                            onClick={() => setAction({ kind: 'grant', packageId: row.id })}
                          >
                            加课时
                          </Button>
                          <Button
                            size="small"
                            variant="text"
                            theme="primary"
                            onClick={() => setAction({ kind: 'extend', packageId: row.id })}
                          >
                            延期
                          </Button>
                        </>
                      ) : null}
                      <Button
                        size="small"
                        variant="text"
                        onClick={() => setAction({ kind: 'ledger', packageId: row.id })}
                      >
                        记录
                      </Button>
                    </Space>
                  ),
                },
              ]}
            />
          </Card>

          <Card
            title="预约记录"
            bordered
            actions={
              s.deletedAt ? null : (
                <Button size="small" onClick={() => setBooking(true)}>
                  代约
                </Button>
              )
            }
          >
            <DataTable
              rowKey="id"
              data={s.bookings}
              empty="没有预约"
              columns={[
                { colKey: 'startsAt', title: '时间', cell: ({ row }) => fmtDateTime(row.startsAt) },
                {
                  colKey: 'lesson',
                  title: '课程',
                  cell: ({ row }) => `${row.lessonType.name} · ${row.coach.name}`,
                },
                {
                  colKey: 'status',
                  title: '状态',
                  cell: ({ row }) => {
                    const [label, theme] = bookingStatusLabel[row.status]
                    return (
                      <Tag theme={theme} variant="light">
                        {label}
                      </Tag>
                    )
                  },
                },
              ]}
            />
          </Card>
        </Space>
      )}

      {editingProfile && s && (
        <ProfileDialog
          studentId={s.id}
          loaded={profileEdit(s.profile)}
          onClose={() => setEditingProfile(false)}
          onDone={() => {
            setEditingProfile(false)
            void detail.reload()
          }}
        />
      )}
      {booking && s && (
        <BookForStudent
          student={s}
          onClose={() => setBooking(false)}
          onDone={() => {
            setBooking(false)
            void detail.reload()
          }}
        />
      )}
      {selling && s && (
        <OfflineSale
          studentId={s.id}
          products={products.data ?? []}
          onClose={() => setSelling(false)}
          onDone={() => {
            setSelling(false)
            void detail.reload()
          }}
        />
      )}
      {action && action.kind !== 'ledger' && (
        <PackageAction
          kind={action.kind}
          packageId={action.packageId}
          onClose={() => setAction(null)}
          onDone={() => {
            setAction(null)
            void detail.reload()
          }}
        />
      )}
      {action?.kind === 'ledger' && (
        <Ledger packageId={action.packageId} onClose={() => setAction(null)} />
      )}
    </Drawer>
  )
}

function ProfileView({ profile: p, deleted }: { profile: StudentProfileDto; deleted: boolean }) {
  const traits = [p.level && studentLevelLabels[p.level], p.grip && gripLabels[p.grip]].filter(
    (t): t is NonNullable<typeof t> => Boolean(t),
  )
  return (
    <div className="profile">
      {(traits.length > 0 || p.tags.length > 0) && (
        <Space size={8} breakLine>
          {traits.map((t) => (
            <Tag key={`trait:${t}`} theme="primary" variant="light">
              {t}
            </Tag>
          ))}
          {p.tags.map((t) => (
            <Tag key={`tag:${t}`} variant="outline">
              {t}
            </Tag>
          ))}
        </Space>
      )}
      {p.note && <div className="profile-note">{p.note}</div>}
      {!deleted && !traits.length && !p.tags.length && !p.note && (
        <div className="muted">还没有填写水平、握拍、标签和备注，教练上课前会看到这些。</div>
      )}
      <div className="muted">
        已上课 {p.lessons} 次{p.noShows ? `，缺席 ${p.noShows} 次` : ''}
      </div>
    </div>
  )
}

/** Staff fill in the profile; coaches read it on the lesson page, students never see it. */
function ProfileDialog({
  studentId,
  loaded,
  onClose,
  onDone,
}: {
  studentId: number
  loaded: StudentProfileEdit
  onClose: () => void
  onDone: () => void
}) {
  const [form, setForm] = useState(loaded)
  // Text typed in the tag box but not yet added with Enter still counts as a tag.
  const [typing, setTyping] = useState('')
  const submitting = useSubmitting()
  const key = useIdempotencyKey()
  const set = (patch: Partial<StudentProfileEdit>) => setForm((f) => ({ ...f, ...patch }))
  const cleanTags = (tags: string[]) => [
    ...new Set(tags.map((t) => t.trim().slice(0, PROFILE_TAG_LENGTH)).filter(Boolean)),
  ]
  const tags = cleanTags([...form.tags, typing]).slice(0, PROFILE_MAX_TAGS)

  const submit = async () => {
    const ok = await attempt(
      () =>
        api(
          'PUT',
          `/admin/students/${studentId}/profile`,
          { ...form, tags },
          { key, ifMatch: loaded },
        ),
      '已保存',
      // Someone else saved it, or the student deleted their account: show it as it is now.
      { onStale: onDone, stale: ['edited_elsewhere', 'account_deleted'] },
    )
    if (ok) onDone()
  }

  return (
    <Dialog
      visible
      width={560}
      header="编辑学员档案"
      confirmBtn={{ content: '保存', loading: submitting }}
      onConfirm={submit}
      onClose={onClose}
    >
      <div className="fields">
        <Field label="水平">
          <Radio.Group
            theme="button"
            variant="outline"
            value={form.level ?? ''}
            options={[
              { label: '未填', value: '' },
              ...studentLevels.map((l) => ({ label: studentLevelLabels[l], value: l })),
            ]}
            onChange={(v) => set({ level: (v || null) as StudentProfileEdit['level'] })}
          />
        </Field>
        <Field label="握拍">
          <Radio.Group
            theme="button"
            variant="outline"
            value={form.grip ?? ''}
            options={[
              { label: '未填', value: '' },
              ...grips.map((g) => ({ label: gripLabels[g], value: g })),
            ]}
            onChange={(v) => set({ grip: (v || null) as StudentProfileEdit['grip'] })}
          />
        </Field>
        <Field
          label="标签"
          help={`最多 ${PROFILE_MAX_TAGS} 个，每个不超过 ${PROFILE_TAG_LENGTH} 字，回车添加`}
        >
          <TagInput
            value={form.tags}
            inputValue={typing}
            max={PROFILE_MAX_TAGS}
            clearable
            placeholder="如 反手弱、备赛、青少年"
            onInputChange={(v, ctx) => {
              // The box drops unadded text on blur; keep it as a tag instead.
              if (ctx?.trigger === 'blur') {
                set({ tags })
                setTyping('')
              } else setTyping(String(v).slice(0, PROFILE_TAG_LENGTH))
            }}
            onChange={(v) => {
              setTyping('')
              set({ tags: cleanTags((v as string[]).map(String)) })
            }}
          />
        </Field>
        <Field label="备注" help="仅场馆和教练可见，学员看不到">
          <Textarea
            value={form.note}
            maxlength={PROFILE_NOTE_LENGTH}
            autosize={{ minRows: 4, maxRows: 10 }}
            placeholder="如 打法特点、训练目标、身体情况"
            onChange={(v) => set({ note: String(v) })}
          />
        </Field>
      </div>
    </Dialog>
  )
}

/** What the student would pay in the mini program right now, sale included. */
function priceNow(p: PackageProduct) {
  return packagePrice(
    {
      price: p.price,
      salePrice: p.salePrice,
      startsAt: p.saleStartsAt ? new Date(p.saleStartsAt) : null,
      endsAt: p.saleEndsAt ? new Date(p.saleEndsAt) : null,
    },
    new Date(),
  ).price
}

function OfflineSale({
  studentId,
  products,
  onClose,
  onDone,
}: {
  studentId: number
  products: PackageProduct[]
  onClose: () => void
  onDone: () => void
}) {
  const onSale = products.filter((p) => p.onSale)
  const [productId, setProductId] = useState<number | undefined>(onSale[0]?.id)
  const product = products.find((p) => p.id === productId)
  const [amount, setAmount] = useState<number | undefined>(toYuan(product && priceNow(product)))
  const [method, setMethod] = useState<keyof typeof offlineMethodLabel>('alipay')
  const [note, setNote] = useState('')
  const submitting = useSubmitting()
  const key = useIdempotencyKey()
  const fen = toFen(amount)

  const submit = async () => {
    if (!productId || fen === null) return
    const ok = await attempt(
      () =>
        api(
          'POST',
          '/admin/packages/offline-sale',
          {
            studentId,
            productId,
            amount: fen,
            method,
            note,
          },
          { key },
        ),
      '已记录',
      { onStale: onDone },
    )
    if (ok) onDone()
  }

  return (
    <Dialog
      visible
      header="前台售卖课时包"
      confirmBtn={{
        content: '确认收款',
        disabled: !productId || fen === null,
        loading: submitting,
      }}
      onConfirm={submit}
      onClose={onClose}
    >
      <div className="fields">
        <Field label="课时包">
          <Select
            value={productId}
            placeholder={onSale.length ? '选择课时包' : '没有在售的课时包'}
            options={onSale.map((p) => ({
              label: `${p.name}（${yuan(priceNow(p))}）`,
              value: p.id,
            }))}
            onChange={(v) => {
              const p = products.find((x) => x.id === Number(v))
              setProductId(Number(v))
              setAmount(toYuan(p && priceNow(p)))
            }}
          />
        </Field>
        <Field label="实收金额">
          <InputNumber
            theme="normal"
            value={amount}
            min={0}
            decimalPlaces={2}
            suffix="元"
            onChange={(v) => setAmount(v as number)}
          />
        </Field>
        <Field label="收款方式">
          <Select
            value={method}
            options={Object.entries(offlineMethodLabel).map(([value, label]) => ({ value, label }))}
            onChange={(v) => setMethod(v as keyof typeof offlineMethodLabel)}
          />
        </Field>
        <Field label="备注">
          <Input value={note} maxlength={100} onChange={(v) => setNote(String(v))} />
        </Field>
      </div>
    </Dialog>
  )
}

function PackageAction({
  kind,
  packageId,
  onClose,
  onDone,
}: {
  kind: 'grant' | 'extend'
  packageId: number
  onClose: () => void
  onDone: () => void
}) {
  const [n, setN] = useState(1)
  const [note, setNote] = useState('')
  const submitting = useSubmitting()
  const key = useIdempotencyKey()
  const submit = async () => {
    const body = kind === 'grant' ? { lessons: n, note } : { days: n, note }
    if (
      await attempt(
        () => api('POST', `/admin/packages/${packageId}/${kind}`, body, { key }),
        '已保存',
        {
          onStale: onDone,
        },
      )
    )
      onDone()
  }
  return (
    <Dialog
      visible
      header={kind === 'grant' ? '赠送课时' : '延长有效期'}
      confirmBtn={{
        content: '确认',
        disabled: kind === 'grant' && !note.trim(),
        loading: submitting,
      }}
      onConfirm={submit}
      onClose={onClose}
    >
      <div className="fields">
        <Field label={kind === 'grant' ? '课时数' : '天数'}>
          <InputNumber
            theme="normal"
            value={n}
            min={1}
            max={kind === 'grant' ? 50 : 365}
            suffix={kind === 'grant' ? '节' : '天'}
            onChange={(v) => setN(Number(v) || 1)}
          />
        </Field>
        <Field label="原因">
          <Textarea
            value={note}
            maxlength={100}
            placeholder={kind === 'grant' ? '必填，如 教练请假补课' : '选填'}
            onChange={(v) => setNote(String(v))}
          />
        </Field>
      </div>
    </Dialog>
  )
}

function Ledger({ packageId, onClose }: { packageId: number; onClose: () => void }) {
  const { data, loading, error } = useApi<LedgerEntry[]>(`/admin/packages/${packageId}/ledger`)
  return (
    <Dialog visible width={560} header="课时记录" footer={false} onClose={onClose}>
      <DataTable
        rowKey="id"
        loading={loading}
        data={data ?? []}
        empty={error ?? '没有记录'}
        columns={[
          { colKey: 'createdAt', title: '时间', cell: ({ row }) => fmtDateTime(row.createdAt) },
          { colKey: 'kind', title: '类型', cell: ({ row }) => ledgerKindLabel[row.kind] },
          {
            colKey: 'delta',
            title: '课时',
            cell: ({ row }) => (row.delta > 0 ? `+${row.delta}` : row.delta || '-'),
          },
          { colKey: 'note', title: '备注' },
        ]}
      />
    </Dialog>
  )
}
