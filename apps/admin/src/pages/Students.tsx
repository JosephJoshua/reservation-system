import {
  cleanTags,
  type FeedbackItemDto,
  gripLabels,
  grips,
  PROFILE_MAX_TAGS,
  PROFILE_NOTE_LENGTH,
  PROFILE_TAG_LENGTH,
  packagePrice,
  profileCounts,
  profileEdit,
  profileTraits,
  type StudentProfileDto,
  type StudentProfileEdit,
  studentLevelLabels,
  studentLevels,
  tagsError,
} from '@rs/shared'
import { useEffect, useRef, useState } from 'react'
import {
  Button,
  Card,
  Dialog,
  Drawer,
  Input,
  InputNumber,
  Loading,
  MessagePlugin,
  Popconfirm,
  type PrimaryTableCol,
  Radio,
  Select,
  Space,
  Switch,
  Tabs,
  Tag,
  TagInput,
  Textarea,
} from 'tdesign-react'
import { api, RequestError } from '../api'
import { BookForStudent } from '../BookForStudent'
import { LessonTime } from '../bookingCells'
import { DataTable } from '../DataTable'
import { BindWechatDialog, EditStudentDialog, NewStudentDialog } from '../DeskStudent'
import { ExportButton } from '../ExportButton'
import { FeedbackPhotos } from '../FeedbackPhotos'
import { Field } from '../Field'
import { fmtDate, fmtDateTime, toFen, toYuan, yuan } from '../format'
import {
  attempt,
  hashParam,
  onceKey,
  useActionKeys,
  useApi,
  useIdempotencyKey,
  useIsPhone,
  useSubmitting,
} from '../hooks'
import {
  bookingStatusLabel,
  ledgerKindLabel,
  offlineMethodLabel,
  packageStatusLabel,
} from '../labels'
import { useOnLessonChanged } from '../lessonLink'
import {
  DateFilter,
  Filter,
  FilterBar,
  hashWith,
  isDay,
  oneOf,
  Pager,
  SearchInput,
  setRange,
  useListFilters,
  usePagedList,
} from '../lists'
import { useCan } from '../me'
import { leaveTo } from '../SaveBar'
import type { AdminBooking, LedgerEntry, PackageProduct, StudentDetail, StudentRow } from '../types'
import { Feedback } from './Feedback'
import { Orders } from './Orders'

function idFromHash() {
  const id = Number(hashParam('id'))
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

/** The student of 学员详情, as in `#/students/12`, or null on the list. */
function pageFromHash() {
  const id = Number(window.location.hash.split('?')[0]?.split('/')[2])
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

const groupOptions = [
  { label: '有剩余课时', value: 'lessons' },
  { label: '课时包即将到期', value: 'expiring' },
  { label: '未绑定微信', value: 'desk' },
  { label: '测试学员', value: 'tester' },
  { label: '已注销', value: 'deleted' },
]

/** The list's address with `id` set or cleared, keeping its filters: the drawer's step. */
const withDrawer = (id: number | null) => hashWith({ id: id ? String(id) : null })

const LIST_KEY = 'rs:students-list'

/** The list as it was last shown, with its filters, for 学员详情's way back to it. */
function listAddress() {
  try {
    const saved = sessionStorage.getItem(LIST_KEY)
    if (saved?.startsWith('#/students?')) return saved
  } catch {}
  return '#/students'
}

export function Students() {
  const money = useCan('finance')
  const canAdd = useCan('students')
  // The header search links here with `q` to show all its results.
  const filters = useListFilters(
    { q: '', group: '', from: '', to: '' },
    {
      path: '#/students',
      valid: {
        group: oneOf(...groupOptions.map((o) => o.value)),
        from: isDay,
        to: isDay,
      },
    },
  )
  const f = filters.values
  const [openId, setOpenId] = useState<number | null>(idFromHash)
  const [pageId, setPageId] = useState<number | null>(pageFromHash)
  const [creating, setCreating] = useState(false)
  const expiring = f.group === 'expiring'
  const params = new URLSearchParams()
  if (f.q) params.set('q', f.q)
  if (f.group) params.set(f.group, '1')
  // The 即将到期 list is by expiry date, not when they joined.
  if (!expiring) setRange(params, f.from, f.to)
  const list = usePagedList<StudentRow>(
    // Not loaded under 学员详情; it loads when the list is back.
    pageId ? null : `/admin/students?${params}`,
    filters,
  )

  // Read when the address changes, so the listener stays put: one removed while the hashchange
  // is going out, as when the filters change with it, would not hear it.
  const reload = useRef(list.reload)
  reload.current = list.reload
  // After the list puts its filters in the address.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the filters or page change
  useEffect(() => {
    if (pageId || !window.location.hash.startsWith('#/students')) return
    try {
      sessionStorage.setItem(LIST_KEY, hashWith({ id: null }))
    } catch {}
  }, [pageId, filters.values, filters.page])
  // The drawer open before the address changed.
  const wasOpen = useRef(openId)
  useEffect(() => {
    const onHash = () => {
      const id = idFromHash()
      const closed = id === null && wasOpen.current !== null
      wasOpen.current = id
      setOpenId(id)
      setPageId(pageFromHash())
      // Closed with the back button: show what changed in the drawer. Back from 学员详情 the
      // list loads anyway.
      if (closed && pageFromHash() === null) void reload.current()
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  if (pageId) return <StudentPage key={pageId} id={pageId} />

  return (
    <div className="paged-list">
      <FilterBar
        main={
          <>
            <SearchInput
              placeholder="姓名、手机号或编号"
              width={240}
              value={f.q}
              onChange={(q) => filters.set({ q })}
            />
            {!expiring && (
              <DateFilter
                from={f.from}
                to={f.to}
                placeholder={['加入日期', '结束日期']}
                onChange={(from, to) => filters.set({ from, to })}
              />
            )}
          </>
        }
        more={
          <Filter label="学员">
            <Select
              style={{ width: 160 }}
              clearable
              placeholder="全部学员"
              value={f.group || undefined}
              onChange={(v) => {
                const group = String(v ?? '')
                // 即将到期 is by expiry date, so it leaves out when they joined.
                filters.set(group === 'expiring' ? { group, from: '', to: '' } : { group })
              }}
              options={groupOptions}
            />
          </Filter>
        }
        inline
        set={filters.changed(['group'])}
        onClear={() => filters.reset(['group'])}
        actions={
          (canAdd || money) && (
            <>
              {canAdd && (
                <Button theme="primary" onClick={() => setCreating(true)}>
                  前台建档
                </Button>
              )}
              {/* The export lists students by when they joined, with no other filter. */}
              {!f.group && money && (
                <ExportButton
                  kind="students"
                  range={f.from && f.to ? [f.from, f.to] : undefined}
                  filters={{ q: f.q }}
                  filterText={f.q ? `搜索“${f.q}”` : undefined}
                />
              )}
            </>
          )
        }
      />
      {expiring && (
        <p className="muted">
          30 天内到期且有剩余课时的学员，按到期日排序。到期前 7 天会给学员发送提醒。
        </p>
      )}
      <DataTable
        rowKey="id"
        loading={list.loading}
        data={list.rows}
        onOpen={(row) => void leaveTo(`#/students/${row.id}`)}
        empty={
          list.error ??
          (f.q || f.from
            ? '没有找到学员'
            : expiring
              ? '30 天内没有到期的课时包'
              : f.group === 'desk'
                ? '前台建档的学员都已绑定微信'
                : f.group
                  ? '没有符合条件的学员'
                  : '还没有学员')
        }
        columns={[
          {
            colKey: 'name',
            title: '姓名',
            cell: ({ row }) =>
              row.deletedAt ? (
                <span className="muted">已注销</span>
              ) : (
                <span className="name-cell">
                  <a href={`#/students/${row.id}`}>
                    {row.name || <span className="muted">未填写</span>}
                  </a>
                  {!row.wechatBound && (
                    <Tag size="small" variant="light" theme="warning">
                      未绑定微信
                    </Tag>
                  )}
                </span>
              ),
          },
          { colKey: 'id', title: '编号', width: 80 },
          {
            colKey: 'phone',
            title: '手机号',
            cell: ({ row }) =>
              row.phone ? (
                <span className="name-cell">
                  {row.phone}
                  {row.phoneShared && (
                    <Tag size="small" variant="light" theme="danger">
                      手机号重复
                    </Tag>
                  )}
                </span>
              ) : (
                '-'
              ),
          },
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
                  title: '加入时间',
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
                  window.location.hash = withDrawer(row.id)
                }}
              >
                查看
              </Button>
            ),
          },
        ]}
      />
      <Pager list={list} filters={filters} />
      {creating && (
        <NewStudentDialog
          initial={f.q}
          onClose={() => setCreating(false)}
          onDone={(student) => {
            setCreating(false)
            void list.reload()
            window.location.hash = withDrawer(student.id)
          }}
        />
      )}
      {openId && (
        <StudentDrawer
          id={openId}
          onChanged={() => void list.reload()}
          onClose={() => {
            setOpenId(null)
            // Replaced rather than pushed, so back does not open the drawer again.
            if (idFromHash()) history.replaceState(null, '', withDrawer(null))
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

/**
 * One student's record and what can be done with it, shared by the 学员 drawer and 学员详情:
 * the dialogs it opens are rendered by `dialogs`.
 */
function useStudent(id: number, onChanged: () => void) {
  const detail = useApi<StudentDetail>(`/admin/students/${id}`)
  useOnLessonChanged(detail.reload)
  const products = useApi<PackageProduct[]>('/admin/package-products')
  const [selling, setSelling] = useState(false)
  const [booking, setBooking] = useState(false)
  const [binding, setBinding] = useState(false)
  const [editingInfo, setEditingInfo] = useState(false)
  // The profile as it was when the editor opened, which the save is checked against.
  const [editingProfile, setEditingProfile] = useState<StudentProfileEdit | null>(null)
  const [action, setAction] = useState<PackageActionKind | null>(null)
  const s = detail.data
  const reload = () => void detail.reload()

  const dialogs = s && (
    <>
      {editingProfile && (
        <ProfileDialog
          studentId={s.id}
          loaded={editingProfile}
          onClose={() => setEditingProfile(null)}
          onDone={() => {
            setEditingProfile(null)
            reload()
          }}
        />
      )}
      {editingInfo && (
        <EditStudentDialog
          student={s}
          onClose={() => setEditingInfo(false)}
          onDone={() => {
            setEditingInfo(false)
            // The list shows the name and phone too.
            onChanged()
            reload()
          }}
        />
      )}
      {binding && (
        <BindWechatDialog
          studentId={s.id}
          onClose={() => setBinding(false)}
          onBound={() => {
            onChanged()
            reload()
          }}
        />
      )}
      {booking && (
        <BookForStudent
          student={s}
          onClose={() => setBooking(false)}
          onDone={() => {
            setBooking(false)
            reload()
          }}
        />
      )}
      {selling && (
        <OfflineSale
          studentId={s.id}
          products={products.data ?? []}
          reloadProducts={products.reload}
          onClose={() => setSelling(false)}
          onDone={() => {
            setSelling(false)
            reload()
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
            reload()
          }}
        />
      )}
      {action?.kind === 'ledger' && (
        <Ledger packageId={action.packageId} onClose={() => setAction(null)} />
      )}
    </>
  )

  return {
    detail,
    s,
    dialogs,
    onChanged,
    sell: () => {
      // Prices and what is on sale may have changed since the page loaded.
      void products.reload()
      setSelling(true)
    },
    book: () => setBooking(true),
    bind: () => setBinding(true),
    editInfo: () => setEditingInfo(true),
    editProfile: () => s && setEditingProfile(profileEdit(s.profile)),
    packageAction: setAction,
  }
}

type PackageActionKind = { kind: 'grant' | 'extend' | 'ledger'; packageId: number }
type Student = ReturnType<typeof useStudent>

/** The student's phone, when they joined, the 测试学员 switch, or that they were deleted. */
function StudentFacts({ student }: { student: Student }) {
  const { s, detail, editInfo } = student
  const canManage = useCan('manage')
  const canEdit = useCan('students')
  const keys = useActionKeys()
  if (!s) return null
  if (s.deletedAt) {
    return (
      <span className="muted">
        {fmtDate(s.deletedAt)}{' '}
        个人信息已删除：姓名、手机号、学员档案和微信身份都已清除，订单和上课记录仍会保留。
      </span>
    )
  }
  return (
    <Space align="center" breakLine>
      <span>{s.phone || '未填写手机号'}</span>
      {canEdit && (
        <Button size="small" variant="text" theme="primary" onClick={editInfo}>
          修改姓名和手机号
        </Button>
      )}
      <span className="muted">
        {s.deletedAt ? '建档于' : s.wechatBound ? '注册于' : '前台建档于'} {fmtDate(s.createdAt)}
      </span>
      {canManage && (
        <Space size={6} align="center">
          <span className="muted">测试学员</span>
          <Switch
            size="small"
            value={s.tester}
            onChange={async (v) => {
              const key = keys.get(`tester-${v}`)
              if (
                await attempt(() => api('PATCH', `/admin/students/${s.id}`, { tester: v }, { key }))
              ) {
                keys.done(`tester-${v}`)
                await detail.reload()
              }
            }}
          />
        </Space>
      )}
    </Space>
  )
}

/** Students sharing the phone, and the WeChat link with 删除学员 for one the desk added. */
function StudentNotices({ student }: { student: Student }) {
  const { s, detail, bind, onChanged } = student
  const canEdit = useCan('students')
  const canManage = useCan('manage')
  if (!s) return null
  return (
    <>
      {s.samePhone.length > 0 && (
        <div className="desk-banner">
          <span>
            手机号与
            {s.samePhone.map((o) => (
              <a key={o.id} href={`#/students/${o.id}`}>
                「{o.name || '未填写姓名'}」（编号 {o.id}）
              </a>
            ))}
            相同。到店时请学员打开小程序「我的」核对学员编号。
          </span>
        </div>
      )}
      {!s.deletedAt && !s.wechatBound && (canEdit || canManage) && (
        <div className="desk-banner">
          <span>
            未绑定微信。学员可以直接来上课；绑定后，课时包、预约和订单会同步到学员的小程序。
          </span>
          <Space size={8} breakLine={false}>
            {canEdit && (
              <Button size="small" theme="primary" onClick={bind}>
                绑定微信
              </Button>
            )}
            {canManage && (
              <Popconfirm
                theme="warning"
                content="删除后，姓名、手机号和学员档案会被清除，订单和上课记录会匿名保留。仅在学员要求删除个人信息时使用。"
                confirmBtn={{ content: '删除', theme: 'danger' }}
                cancelBtn="返回"
                onConfirm={async () => {
                  const key = onceKey(`delete-student-${s.id}`)
                  if (
                    await attempt(
                      () => api('DELETE', `/admin/students/${s.id}`, undefined, { key }),
                      '已删除',
                    )
                  ) {
                    onChanged()
                    await detail.reload()
                  }
                }}
              >
                <Button size="small" variant="outline" theme="danger">
                  删除学员
                </Button>
              </Popconfirm>
            )}
          </Space>
        </div>
      )}
    </>
  )
}

function ProfileCard({ student }: { student: Student }) {
  const { s, editProfile } = student
  const canEdit = useCan('students')
  if (!s) return null
  return (
    <Card
      title="学员档案"
      bordered
      actions={
        s.deletedAt || !canEdit ? null : (
          <Button size="small" onClick={editProfile}>
            编辑
          </Button>
        )
      }
    >
      <ProfileView profile={s.profile} deleted={Boolean(s.deletedAt)} />
    </Card>
  )
}

function FeedbackCard({ student }: { student: Student }) {
  const { s } = student
  if (!s?.feedback.length) return null
  return (
    <Card title={`课后点评（${s.profile.feedbackCount}）`} bordered>
      <FeedbackList key={s.id} items={s.feedback} total={s.profile.feedbackCount} />
    </Card>
  )
}

function PackagesCard({ student }: { student: Student }) {
  const { s, sell, packageAction } = student
  const canEdit = useCan('students')
  const canManage = useCan('manage')
  if (!s) return null
  return (
    <Card
      title="课时包"
      bordered
      actions={
        s.deletedAt || !canEdit ? null : (
          <Button size="small" onClick={sell}>
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
          { colKey: 'name', title: '名称' },
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
          {
            colKey: 'pricePaid',
            title: '实付',
            width: 90,
            cell: ({ row }) => yuan(row.pricePaid),
          },
          {
            colKey: 'status',
            title: '状态',
            width: 90,
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
                canManage &&
                (row.status === 'active' ||
                  row.status === 'used_up' ||
                  row.status === 'expired') ? (
                  <>
                    <Button
                      size="small"
                      variant="text"
                      theme="primary"
                      onClick={() => packageAction({ kind: 'grant', packageId: row.id })}
                    >
                      加课时
                    </Button>
                    <Button
                      size="small"
                      variant="text"
                      theme="primary"
                      onClick={() => packageAction({ kind: 'extend', packageId: row.id })}
                    >
                      延期
                    </Button>
                  </>
                ) : null}
                <Button
                  size="small"
                  variant="text"
                  theme="primary"
                  onClick={() => packageAction({ kind: 'ledger', packageId: row.id })}
                >
                  记录
                </Button>
              </Space>
            ),
          },
        ]}
      />
    </Card>
  )
}

const bookingColumns: PrimaryTableCol<StudentDetail['bookings'][number]>[] = [
  {
    colKey: 'startsAt',
    title: '时间',
    cell: ({ row }) => <LessonTime slotId={row.slotId}>{fmtDateTime(row.startsAt)}</LessonTime>,
  },
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
]

// How many of the latest bookings the drawer shows; 学员详情 pages through all of them.
const DRAWER_BOOKINGS = 10

/** The latest bookings, in the drawer. */
function BookingsCard({ student }: { student: Student }) {
  const { s, book } = student
  const canBook = useCan('bookings')
  if (!s) return null
  return (
    <Card
      title="预约记录"
      bordered
      actions={
        s.deletedAt || !canBook ? null : (
          <Button size="small" onClick={book}>
            代约
          </Button>
        )
      }
    >
      <DataTable
        rowKey="id"
        data={s.bookings.slice(0, DRAWER_BOOKINGS)}
        empty="没有预约"
        columns={bookingColumns}
      />
      {s.bookings.length > DRAWER_BOOKINGS && (
        <p>
          <a href={`#/students/${s.id}?tab=bookings`}>查看全部预约</a>
        </p>
      )}
    </Card>
  )
}

/** All of a student's bookings on 学员详情, latest first, by status. 代约 is in its header. */
function StudentBookings({ student }: { student: Student }) {
  const { s } = student
  const filters = useListFilters({ status: '' })
  const params = new URLSearchParams({ studentId: String(s?.id ?? 0), order: 'desc' })
  if (filters.values.status) params.set('status', filters.values.status)
  const list = usePagedList<AdminBooking>(s ? `/admin/bookings?${params}` : null, filters)
  const { reload } = list
  // A booking, cancel or move from this page changes the student's record too.
  const seen = useRef(s)
  useEffect(() => {
    if (seen.current === s) return
    seen.current = s
    void reload()
  }, [s, reload])
  if (!s) return null
  return (
    <div className="paged-list">
      <FilterBar
        more={
          <Filter label="状态">
            <Select
              style={{ width: 120 }}
              clearable
              placeholder="全部状态"
              value={filters.values.status || undefined}
              onChange={(v) => filters.set({ status: String(v ?? '') })}
              options={Object.entries(bookingStatusLabel).map(([value, [label]]) => ({
                value,
                label,
              }))}
            />
          </Filter>
        }
        inline
        set={filters.changed(['status'])}
        onClear={() => filters.reset()}
      />
      <DataTable
        rowKey="id"
        loading={list.loading}
        data={list.rows}
        empty={list.error ?? (filters.values.status ? '没有符合条件的预约' : '没有预约')}
        columns={bookingColumns}
      />
      <Pager list={list} filters={filters} />
    </div>
  )
}

/** A quick look at a student over the list, with everything on one scroll. */
function StudentDrawer({
  id,
  onChanged,
  onClose,
}: {
  id: number
  /** The student's row in the list changed, such as when they are deleted or linked. */
  onChanged: () => void
  onClose: () => void
}) {
  const student = useStudent(id, onChanged)
  const { s, detail } = student
  const phone = useIsPhone()
  // Opened after mounting rather than mounted open, so the drawer takes focus and Esc closes it.
  const [shown, setShown] = useState(false)
  useEffect(() => setShown(true), [])

  return (
    <Drawer
      visible={shown}
      size={phone ? '100%' : '800px'}
      header={
        <div className="drawer-head">
          <span>{s ? `${studentName(s)} · 编号 ${s.id}` : '学员'}</span>
          <Button size="small" variant="outline" href={`#/students/${id}`}>
            打开详情
          </Button>
        </div>
      }
      footer={false}
      onClose={onClose}
    >
      {!s && detail.error && <p className="muted">{detail.error}</p>}
      {!s && !detail.error && <Loading size="small" />}
      {s && (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <StudentFacts student={student} />
          <StudentNotices student={student} />
          <ProfileCard student={student} />
          <FeedbackCard student={student} />
          <PackagesCard student={student} />
          <BookingsCard student={student} />
        </Space>
      )}
      {student.dialogs}
    </Drawer>
  )
}

const studentName = (s: StudentDetail) => (s.deletedAt ? '已注销的学员' : s.name || '未填写姓名')

const studentTabs = ['overview', 'packages', 'bookings', 'feedback', 'orders'] as const
type StudentTab = (typeof studentTabs)[number]

/**
 * 学员详情: one student on a page of their own, with an address to link to, and tabs for their
 * packages, bookings, 课后点评 and orders.
 */
function StudentPage({ id }: { id: number }) {
  const student = useStudent(id, () => {})
  const { s, detail, sell, book } = student
  // Opened from the list or a link: starts at the top, as other pages do.
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [])
  const canEdit = useCan('students')
  const canBook = useCan('bookings')
  const money = useCan('finance')
  const [picked, setTab] = useState(() => hashParam('tab'))
  // A tab this login can't open, such as 订单 from a link, shows 概况.
  const allowed = (t: string | null): t is StudentTab =>
    studentTabs.includes(t as StudentTab) &&
    (t !== 'feedback' || canBook) &&
    (t !== 'orders' || money)
  const tab = allowed(picked) ? picked : 'overview'
  const pick = (t: StudentTab) => {
    setTab(t)
    // In the address for a refresh or a copied link, without a step for the back button.
    history.replaceState(
      history.state,
      '',
      `#/students/${id}${t === 'overview' ? '' : `?tab=${t}`}`,
    )
  }
  // Takes a tab that fell back to 概况 out of the address too.
  const fellBack = picked !== null && picked !== tab
  useEffect(() => {
    if (fellBack) history.replaceState(history.state, '', `#/students/${id}`)
  }, [fellBack, id])

  const now = Date.now()
  const active = s?.packages.filter((p) => p.status === 'active') ?? []
  const next = s?.bookings
    .filter((b) => b.status === 'confirmed' && Date.parse(b.startsAt) > now)
    .at(-1)

  return (
    <div className="detail-page">
      <nav className="breadcrumb" aria-label="位置">
        <a href={listAddress()}>学员</a>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{s ? studentName(s) : '学员详情'}</span>
      </nav>
      {!s && detail.error && <p className="muted">{detail.error}</p>}
      {!s && !detail.error && <Loading size="small" />}
      {s && (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <div className="detail-head">
            <div>
              <h2 className="detail-title">
                {studentName(s)}
                <span className="muted detail-id">编号 {s.id}</span>
              </h2>
              <StudentFacts student={student} />
            </div>
            {!s.deletedAt && (
              <Space size={8} breakLine>
                {canBook && <Button onClick={book}>代约</Button>}
                {canEdit && (
                  <Button variant="outline" onClick={sell}>
                    前台售卖
                  </Button>
                )}
              </Space>
            )}
          </div>
          <StudentNotices student={student} />
          <Tabs value={tab} onChange={(v) => pick(v as StudentTab)} className="detail-tabs">
            <Tabs.TabPanel value="overview" label="概况" destroyOnHide={false}>
              <Space direction="vertical" size={16} style={{ width: '100%' }}>
                <div className="stat-grid kpi-grid">
                  <Card bordered>
                    <div className="muted">剩余课时</div>
                    <div className="stat">
                      {active.reduce((n, p) => n + p.lessonsRemaining, 0)} 节
                    </div>
                    <div className="stat-sub">{active.length} 个有效课时包</div>
                  </Card>
                  <Card bordered>
                    <div className="muted">下次上课</div>
                    <div className="stat">{next ? fmtDateTime(next.startsAt) : '暂无'}</div>
                    <div className="stat-sub">
                      {next ? `${next.lessonType.name} · ${next.coach.name}` : '没有待上的课'}
                    </div>
                  </Card>
                  <Card bordered>
                    <div className="muted">已上课</div>
                    <div className="stat">{s.profile.lessons} 节</div>
                    <div className="stat-sub">
                      {s.profile.noShows ? `缺席 ${s.profile.noShows} 次` : '没有缺席'}
                    </div>
                  </Card>
                </div>
                <ProfileCard student={student} />
                {/* Without the 课后点评 tab, the latest ones show here. */}
                {!canBook && <FeedbackCard student={student} />}
              </Space>
            </Tabs.TabPanel>
            <Tabs.TabPanel value="packages" label="课时包">
              <PackagesCard student={student} />
            </Tabs.TabPanel>
            <Tabs.TabPanel value="bookings" label="预约">
              <StudentBookings student={student} />
            </Tabs.TabPanel>
            {canBook && (
              <Tabs.TabPanel value="feedback" label="课后点评">
                <Feedback studentId={s.id} />
              </Tabs.TabPanel>
            )}
            {money && (
              <Tabs.TabPanel value="orders" label="订单">
                <Orders studentId={s.id} />
              </Tabs.TabPanel>
            )}
          </Tabs>
        </Space>
      )}
      {student.dialogs}
    </div>
  )
}

function ProfileView({ profile: p, deleted }: { profile: StudentProfileDto; deleted: boolean }) {
  const traits = profileTraits(p)
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
        <div className="muted">
          还没有填写水平、握拍、标签和备注。教练可以在小程序的课程页填写，场馆也可以在这里填写。
        </div>
      )}
      <div className="muted">{profileCounts(p)}</div>
      {p.updatedBy && p.updatedAt && (
        <div className="muted">
          {p.updatedBy.kind === 'coach' ? `${p.updatedBy.name}（教练）` : p.updatedBy.name} 修改于{' '}
          {fmtDateTime(p.updatedAt)}
        </div>
      )}
    </div>
  )
}

/** The 课后点评 the student sees, from every coach, newest first; the latest few until opened. */
function FeedbackList({ items, total }: { items: FeedbackItemDto[]; total: number }) {
  const [all, setAll] = useState(false)
  const shown = all ? items : items.slice(0, 3)
  return (
    <div className="student-feedback">
      {shown.map((f) => (
        <div key={f.bookingId} className="feedback-cell">
          <div className="muted">
            {fmtDateTime(f.startsAt)} · {f.coachName} · {f.lessonTypeName}
          </div>
          <div className="feedback-text">{f.text}</div>
          <FeedbackPhotos photos={f.photos} />
        </div>
      ))}
      {items.length > shown.length && (
        <Button variant="text" theme="primary" onClick={() => setAll(true)}>
          {items.length < total ? `显示最近 ${items.length} 条` : `显示全部 ${items.length} 条`}
        </Button>
      )}
      {all && items.length < total && (
        <div className="muted">更早的点评可在课后点评页按日期查看</div>
      )}
    </div>
  )
}

/** Coaches keep the profile from their lesson pages and staff here; students never see it. */
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
  const tags = cleanTags([...form.tags, typing])

  const submit = async () => {
    const error = tagsError(tags)
    if (error) {
      void MessagePlugin.warning(error)
      return
    }
    const ok = await attempt(
      () =>
        api(
          'PUT',
          `/admin/students/${studentId}/profile`,
          { ...form, tags },
          { key, ifMatch: loaded },
        ).catch((e) => {
          throw e instanceof RequestError && e.code === 'edited_elsewhere'
            ? new RequestError(e.status, e.code, '已被其他人修改，已显示最新档案，请核对后再改')
            : e
        }),
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
      cancelBtn="返回"
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
          help={`最多 ${PROFILE_MAX_TAGS} 个，每个不超过 ${PROFILE_TAG_LENGTH} 个字，按回车添加`}
        >
          <TagInput
            value={form.tags}
            inputValue={typing}
            max={PROFILE_MAX_TAGS}
            clearable
            placeholder="如：反手弱、备赛、青少年"
            onInputChange={(v, ctx) => {
              // The box drops unadded text on blur; keep it as a tag instead.
              if (ctx?.trigger === 'blur' && tags.length <= PROFILE_MAX_TAGS) {
                set({ tags })
                setTyping('')
              } else if (ctx?.trigger !== 'blur') {
                setTyping(String(v))
              }
            }}
            onChange={(v, ctx) => {
              // Removing a tag keeps what is still being typed.
              if (ctx.trigger !== 'tag-remove') setTyping('')
              set({ tags: cleanTags((v as string[]).map(String)) })
            }}
          />
        </Field>
        <Field label="备注" help="仅场馆和教练可见，学员看不到。请勿记录病史等健康信息。">
          <Textarea
            value={form.note}
            maxlength={PROFILE_NOTE_LENGTH}
            autosize={{ minRows: 4, maxRows: 10 }}
            placeholder="如：打法特点、训练目标"
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

// Refusals that mean the price or the package changed since the list loaded.
const SALE_CHANGED = ['listed_price_only', 'product_off_sale', 'package_changed']

function OfflineSale({
  studentId,
  products,
  reloadProducts,
  onClose,
  onDone,
}: {
  studentId: number
  products: PackageProduct[]
  reloadProducts: () => Promise<void>
  onClose: () => void
  onDone: () => void
}) {
  const onSale = products.filter((p) => p.onSale)
  // Only 管理员 may charge other than the listed price.
  const canPrice = useCan('manage')
  const [productId, setProductId] = useState<number | undefined>(onSale[0]?.id)
  const product = products.find((p) => p.id === productId)
  const [amount, setAmount] = useState<number | undefined>(toYuan(product && priceNow(product)))
  const [method, setMethod] = useState<keyof typeof offlineMethodLabel>('alipay')
  const [note, setNote] = useState('')
  const submitting = useSubmitting()
  const key = useIdempotencyKey()
  const listed = product?.onSale ? priceNow(product) : undefined
  // Others charge the listed price as it stands, which follows the list when it reloads.
  const fen = canPrice ? toFen(amount) : (listed ?? null)

  // The list reloaded: a package taken off sale meanwhile gives way to one still on sale.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the list changes
  useEffect(() => {
    if (onSale.some((p) => p.id === productId)) return
    const first = onSale[0]
    setProductId(first?.id)
    setAmount(toYuan(first && priceNow(first)))
  }, [products])

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
            // Refused if another admin changed what the package grants since this was loaded.
            expectedTerms: product && {
              lessonTypeId: product.lessonTypeId,
              coachIds: product.coachIds,
              lessonCount: product.lessonCount,
              validityDays: product.validityDays,
            },
          },
          { key },
        ),
      '已记录',
      {
        stale: SALE_CHANGED,
        // A changed price or package reloads the list and keeps the dialog, to check and confirm.
        onStale: (e) => (SALE_CHANGED.includes(e.code) ? reloadProducts() : onDone()),
      },
    )
    if (ok) onDone()
  }

  return (
    <Dialog
      visible
      header="前台售卖课时包"
      cancelBtn="返回"
      confirmBtn={{
        content: '确认收款',
        disabled: !productId || fen === null || fen > 10_000_000,
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
        <Field
          label="实收金额"
          help={
            !canPrice
              ? '按标价收款，改价请联系管理员'
              : fen === null || fen > 10_000_000
                ? '请填写 0 到 100000 元之间的金额'
                : undefined
          }
        >
          <InputNumber
            theme="normal"
            status={canPrice && (fen === null || fen > 10_000_000) ? 'error' : 'default'}
            value={canPrice ? amount : toYuan(listed)}
            disabled={!canPrice}
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
  const [n, setN] = useState<number | undefined>(1)
  const [note, setNote] = useState('')
  const submitting = useSubmitting()
  const key = useIdempotencyKey()
  const max = kind === 'grant' ? 50 : 365
  const valid = n !== undefined && Number.isInteger(n) && n >= 1 && n <= max
  const submit = async () => {
    if (!valid) return
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
      cancelBtn="返回"
      confirmBtn={{
        content: '确认',
        disabled: !valid || (kind === 'grant' && !note.trim()),
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
            max={max}
            suffix={kind === 'grant' ? '节' : '天'}
            status={valid ? 'default' : 'error'}
            tips={valid ? undefined : `请填 1 到 ${max} 的整数`}
            onChange={(v) => setN(v === '' || v === undefined ? undefined : Number(v))}
          />
        </Field>
        <Field label="原因">
          <Textarea
            value={note}
            maxlength={100}
            placeholder={kind === 'grant' ? '必填，如：教练请假补课' : '选填'}
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
