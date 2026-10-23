// WeChat subscription messages (订阅消息). A user grants one message per tap on the mini program's
// prompt, so the coach pages ask on every few taps; a send without a grant fails with 43101.

import type { StudentNoticeKind } from '@rs/shared'

const VALUE_KEYS = [
  'student',
  'lesson',
  'time',
  'oldTime',
  'coach',
  'place',
  'reason',
  'refund',
  'note',
] as const

/** The values a message can carry; each template field maps to one of them. */
export type NoticeValues = Partial<Record<(typeof VALUE_KEYS)[number], string>>

export interface NoticeTemplate {
  id: string
  /** Template field key, such as thing1 or time2, to the value it shows. */
  fields: Record<string, keyof NoticeValues>
}

export type NoticeKind = `coach_${'booked' | 'cancelled'}` | `student_${StudentNoticeKind}`

export interface Notifier {
  template(kind: NoticeKind): NoticeTemplate | undefined
  /** 'refused' when the user has no grant left; throws when WeChat could not be reached. */
  send(
    openid: string,
    template: NoticeTemplate,
    page: string,
    values: NoticeValues,
  ): Promise<'sent' | 'refused'>
}

/**
 * Reads a template from an env value such as `AbC123 thing1=student time2=time thing3=lesson`:
 * the template ID from the mini program console, then each field it has and what goes in it.
 */
export function parseTemplate(value: string | undefined): NoticeTemplate | undefined {
  const [id, ...pairs] = value?.trim().split(/\s+/) ?? []
  if (!id) return undefined
  const fields: NoticeTemplate['fields'] = {}
  for (const pair of pairs) {
    const [field, name] = pair.split('=')
    if (!field || !VALUE_KEYS.includes(name as (typeof VALUE_KEYS)[number])) {
      throw new Error(`Bad notice template field "${pair}"`)
    }
    fields[field] = name as keyof NoticeValues
  }
  if (Object.keys(fields).length === 0) throw new Error(`Notice template ${id} has no fields`)
  return { id, fields }
}

const LIMITS: [prefix: string, chars: number][] = [
  ['thing', 20],
  ['name', 10],
  ['phrase', 5],
  ['character_string', 32],
]

/** Fits a value to the length limit of its field type. WeChat rejects empty values. */
export function fieldValue(field: string, value: string) {
  const limit = LIMITS.find(([prefix]) => field.startsWith(prefix))?.[1]
  const chars = [...value]
  if (limit && chars.length > limit) return `${chars.slice(0, limit - 1).join('')}…`
  return value || '-'
}

export function wechatNotifier(options: {
  appId: string
  secret: string
  state: 'developer' | 'trial' | 'formal'
  templates: Partial<Record<NoticeKind, NoticeTemplate>>
  fetchImpl?: typeof fetch
}): Notifier {
  const fetchImpl = options.fetchImpl ?? fetch
  let token: { value: string; expiresAt: number } | null = null

  async function accessToken() {
    if (token && token.expiresAt > Date.now()) return token.value
    // The stable token endpoint does not invalidate tokens other servers already hold.
    const res = await fetchImpl('https://api.weixin.qq.com/cgi-bin/stable_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credential',
        appid: options.appId,
        secret: options.secret,
      }),
    })
    const data = (await res.json()) as {
      access_token?: string
      expires_in?: number
      errmsg?: string
    }
    if (!data.access_token) throw new Error(`access token: ${data.errmsg ?? res.status}`)
    token = {
      value: data.access_token,
      expiresAt: Date.now() + ((data.expires_in ?? 7200) - 300) * 1000,
    }
    return token.value
  }

  return {
    template: (kind) => options.templates[kind],
    async send(openid, template, page, values) {
      const data = Object.fromEntries(
        Object.entries(template.fields).map(([field, name]) => [
          field,
          { value: fieldValue(field, values[name] ?? '') },
        ]),
      )
      const res = await fetchImpl(
        `https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${await accessToken()}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            touser: openid,
            template_id: template.id,
            page,
            data,
            miniprogram_state: options.state,
            lang: 'zh_CN',
          }),
        },
      )
      const result = (await res.json()) as { errcode?: number; errmsg?: string }
      if (!result.errcode) return 'sent'
      if (result.errcode === 43101) return 'refused'
      // An expired or revoked token: fetch a new one on the next try.
      if (result.errcode === 40001 || result.errcode === 42001) token = null
      throw new Error(`subscribe send: ${result.errcode} ${result.errmsg ?? ''}`)
    },
  }
}

/** Logs messages instead of sending them, for trying templates out without WeChat. */
export function logNotifier(
  templates: Partial<Record<NoticeKind, NoticeTemplate>>,
  log: (message: string, detail?: unknown) => void,
): Notifier {
  return {
    template: (kind) => templates[kind],
    async send(openid, template, page, values) {
      log('notice', { openid, template: template.id, page, values })
      return 'sent'
    },
  }
}

/** The template IDs of the given kinds that are set up, for a page to ask the user about. */
export function templateIds(notifier: Notifier | undefined, kinds: NoticeKind[]) {
  return kinds.flatMap((kind) => notifier?.template(kind)?.id ?? [])
}
