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
    raw = await c.req.json()
  } catch {
    throw new ApiError(400, 'invalid_body', '请求格式错误')
  }
  const result = schema.safeParse(raw)
  if (!result.success) {
    const issue = result.error.issues[0]
    // Custom checks carry a message written for people; the rest name the field.
    const message =
      issue?.code === 'custom' ? issue.message : `请求格式错误：${issue?.path.join('.') ?? ''}`
    throw new ApiError(400, 'invalid_body', message)
  }
  return result.data
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
export function isUniqueViolation(e: unknown): boolean {
  // Drizzle may wrap the driver error, so walk the cause chain.
  for (let err = e, depth = 0; err && depth < 5; depth++) {
    if (typeof err !== 'object') return false
    if ((err as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE') return true
    err = (err as { cause?: unknown }).cause
  }
  return false
}
