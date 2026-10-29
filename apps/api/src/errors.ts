import { versionOf } from '@rs/shared'
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { z } from 'zod'

/** An error the client can show: `message` is short Chinese copy, `code` is for logic. */
export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export const notFound = (what = '内容') => new ApiError(404, 'not_found', `${what}不存在`)

export async function parseBody<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown
  try {
    // An empty body reaches the schema as undefined, for endpoints whose body is optional.
    const text = await c.req.text()
    raw = text.trim() === '' ? undefined : JSON.parse(text)
  } catch {
    throw new ApiError(400, 'invalid_body', '请求格式错误')
  }
  const result = schema.safeParse(raw)
  if (!result.success) {
    const issue = result.error.issues[0]
    // Custom checks carry a message written for people; the rest name the field.
    const message =
      !issue || issue.code === 'custom'
        ? (issue?.message ?? '请求格式错误')
        : issueMessage(issue, raw)
    throw new ApiError(400, 'invalid_body', message)
  }
  return result.data
}

// What admins and students call the fields they type into, by full path first, then by name.
const FIELD_LABELS: Record<string, string> = {
  'venue.name': '场馆名称',
  'venue.phone': '场馆电话',
  'notice.text': '公告',
  'notice.endsAt': '公告结束时间',
  'policies.booking': '预约须知',
  'policies.agreement': '用户协议',
  name: '名称',
  bio: '简介',
  description: '说明',
  how: '处理方式',
  address: '地址',
  phone: '手机号',
  openingHours: '营业时间',
  latitude: '纬度',
  longitude: '经度',
  advanceDays: '可提前预约天数',
  minNoticeMinutes: '最晚预约时间',
  cancelDeadlineHours: '免费取消时间',
  percent: '退款比例',
  timeoutMinutes: '支付时限',
  trialLimitPerStudent: '每人体验课次数',
  studentMoves: '学员自助改约次数',
  durationMinutes: '时长',
  capacity: '人数上限',
  minStudents: '最低开班人数',
  price: '价格',
  rate: '课时费',
  salePrice: '限时价',
  salePercent: '折扣',
  saleStartsAt: '优惠开始时间',
  saleEndsAt: '优惠结束时间',
  lessonCount: '课时数',
  validityDays: '有效期',
  amount: '金额',
  lessons: '课时数',
  days: '天数',
  reason: '原因',
  note: '备注',
  tags: '标签',
  startsAt: '开始时间',
  endsAt: '结束时间',
  imageUrl: '图片',
}

function fieldLabel(path: PropertyKey[]) {
  const full = path.filter((p) => typeof p === 'string').join('.')
  const last = [...path].reverse().find((p) => typeof p === 'string')
  return FIELD_LABELS[full] ?? (typeof last === 'string' ? FIELD_LABELS[last] : undefined)
}

function valueAt(raw: unknown, path: PropertyKey[]) {
  let v = raw
  for (const key of path)
    v = v && typeof v === 'object' ? (v as Record<PropertyKey, unknown>)[key] : undefined
  return v
}

/** Short Chinese copy for a failed field, so the admin knows what to fix. */
function issueMessage(issue: z.core.$ZodIssue, raw: unknown) {
  const label = fieldLabel(issue.path)
  // Fields people do not type into keep their path, for whoever reads the logs.
  if (!label) return `请求格式错误：${issue.path.join('.')}`
  const missing = issue.code === 'invalid_type' && valueAt(raw, issue.path) === undefined
  if (missing || (issue.code === 'too_small' && issue.origin === 'string')) return `请填写${label}`
  if (issue.code === 'too_big' && issue.origin === 'string') return `${label}太长`
  if (issue.code === 'too_small' || issue.code === 'too_big') return `${label}超出允许范围`
  return `${label}格式不对`
}

export function parseQuery<T extends z.ZodType>(c: Context, schema: T): z.infer<T> {
  const result = schema.safeParse(c.req.query())
  if (!result.success) throw new ApiError(400, 'invalid_query', '请求参数错误')
  return result.data
}

export function idParam(c: Context, name = 'id'): number {
  const id = Number(c.req.param(name))
  if (!Number.isSafeInteger(id) || id <= 0) throw notFound()
  return id
}

/** True for a SQLite unique-constraint violation. */
/**
 * Refuses a save made on top of a change the editor has not seen. The editor sends `If-Match` with
 * `versionOf` the record it loaded; `current` is the record as the API would send it now.
 */
export function checkVersion(c: Context, current: unknown) {
  const expected = c.req.header('If-Match')
  if (expected && expected !== versionOf(current)) {
    throw new ApiError(409, 'edited_elsewhere', '已被其他人修改，请刷新后再改')
  }
}

export function isUniqueViolation(e: unknown): boolean {
  // Drizzle may wrap the driver error, so walk the cause chain.
  for (let err = e, depth = 0; err && depth < 5; depth++) {
    if (typeof err !== 'object') return false
    if ((err as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE') return true
    err = (err as { cause?: unknown }).cause
  }
  return false
}
