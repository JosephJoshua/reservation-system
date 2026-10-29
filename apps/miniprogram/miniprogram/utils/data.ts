import type { CatalogDto, LateCancelRule, MeDto } from '../lib/shared'
import { ApiError, api, publicApi } from './api'

let catalog: { value: CatalogDto; at: number } | null = null

/** The catalog changes rarely, so pages share one copy for a minute. */
export async function getCatalog(fresh = false): Promise<CatalogDto> {
  if (!fresh && catalog && Date.now() - catalog.at < 60_000) return catalog.value
  const value = await api<CatalogDto>('GET', '/catalog')
  catalog = { value, at: Date.now() }
  return value
}

/** When the shared catalog was fetched, so a page can tell it was refreshed meanwhile. */
export function catalogFetchedAt(): number {
  return catalog?.at ?? 0
}

export function getMe(): Promise<MeDto> {
  return api<MeDto>('GET', '/me')
}

const NOTICE_PROMPT_MAX_MS = 10_000

/**
 * Asks to send the student the given messages, one each. WeChat only shows the prompt when this
 * starts inside a tap handler, before any await. Resolves once the prompt is closed, so a payment
 * sheet does not open on top of it, or after 10 seconds at most.
 */
export function askForNotices(
  templates: MeDto['noticeTemplates'],
  kinds: (keyof MeDto['noticeTemplates'])[],
): Promise<void> {
  // One template may serve two kinds, such as a 课程变动 template for cancels and moves.
  const tmplIds = [...new Set(kinds.flatMap((kind) => templates[kind] ?? []))]
  if (!tmplIds.length) return Promise.resolve()
  return new Promise((resolve) => {
    // Booking must never hang on the prompt, should WeChat not report back.
    const fallback = setTimeout(resolve, NOTICE_PROMPT_MAX_MS)
    wx.requestSubscribeMessage({
      tmplIds: tmplIds.slice(0, 3),
      complete: () => {
        clearTimeout(fallback)
        resolve()
      },
    })
  })
}

/** One line on what cancelling late costs, for the confirm and detail pages. */
export function cancelRuleText(hours: number, rule: LateCancelRule): string {
  const late =
    rule.kind === 'forfeit' || rule.percent === 0
      ? '之后再取消，则不退费用和课时'
      : rule.percent === 100
        ? '之后取消也全额退款'
        : `之后再取消，则退还 ${rule.percent}% 的费用，但不退课时`
  // With no deadline, only a lesson that has started is late, and it cannot be cancelled then.
  return hours === 0 ? '开课前随时可以免费取消。' : `开课前 ${hours} 小时以上可免费取消；${late}。`
}

/** The version of the policies in force, which an agreement row offers from when it is shown. */
export async function policyVersion(): Promise<string> {
  return (await publicApi<CatalogDto['policies']>('GET', '/policies')).version
}

/**
 * The version a page's agreement row offers: null when the student has agreed to the policies in
 * force already, so the page shows no row.
 */
export function agreementFor(me: MeDto): Promise<string | null> {
  return me.agreedPolicies ? Promise.resolve(null) : policyVersion()
}

/**
 * Records that the student agreed to the policies at `version`, the one the page offered when it
 * showed the agreement. The server refuses an older one with policy_changed.
 */
export async function agreePolicies(version: string): Promise<void> {
  await api<void>('POST', '/me/consent', { version })
}

export const isPolicyChanged = (e: unknown): boolean =>
  e instanceof ApiError && e.code === 'policy_changed'

/**
 * After policy_changed: says the texts were updated and answers the version now in force, for
 * the student to read and agree to again, or null when it could not be loaded.
 */
export async function askToAgreeAgain(): Promise<string | null> {
  const version = await policyVersion().catch(() => null)
  await wx.showModal({
    title: '条款已更新',
    content: '请重新阅读用户协议和隐私政策，同意后再提交。',
    showCancel: false,
  })
  return version
}
