import type { CatalogDto, LateCancelRule, MeDto } from '../lib/shared'
import { ApiError, api, publicApi, savedToken } from './api'

let catalog: { value: CatalogDto; at: number; token: string } | null = null

/**
 * How long pages share one copy of the catalog. A 体验课 waiting for payment can be paid or lapse
 * at any time, maybe on another phone, so a catalog saying so is fetched again on the next show.
 */
const catalogMaxAge = (value: CatalogDto) => (value.payment.trialPending ? 3_000 : 60_000)

/**
 * The catalog changes rarely, so pages share one copy for a while. It holds the student's own
 * 体验课 state, so a copy is never shown to another account after a switch or 注销.
 */
export async function getCatalog(fresh = false): Promise<CatalogDto> {
  if (
    !fresh &&
    catalog &&
    catalog.token === savedToken() &&
    Date.now() - catalog.at < catalogMaxAge(catalog.value)
  ) {
    return catalog.value
  }
  const before = savedToken()
  const value = await api<CatalogDto>('GET', '/catalog')
  // The session the call used: the saved one, or the one its login saved. One that changed
  // meanwhile may belong to another account, so the answer is not kept for it.
  const token = savedToken()
  if (!before || before === token) catalog = { value, at: Date.now(), token }
  return value
}

/** Why a 体验课 is shown but cannot be booked: used up, or taken by one still to pay. */
export const TRIAL_USED_UP = '体验课次数已用完'
export const TRIAL_PENDING = '你有体验课待支付'

/**
 * Why this student cannot book a 体验课 now, or '' when they can. Missing from an older API: they
 * can, and the booking says otherwise.
 */
export function trialBlock(catalog: CatalogDto): string {
  if (catalog.payment.trialAvailable !== false) return ''
  return catalog.payment.trialPending ? TRIAL_PENDING : TRIAL_USED_UP
}

/** Drops the cached catalog, say after the session moved to another student record. */
export function forgetCatalog(): void {
  catalog = null
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

/**
 * Whether a submit was refused for want of consent to the policies in force: agreed to an older
 * version than the page offered (policy_changed), or the policies changed after the page loaded
 * for a student who had agreed, so it showed no agreement (consent_required).
 */
export const needsAgreement = (e: unknown): boolean =>
  e instanceof ApiError && (e.code === 'policy_changed' || e.code === 'consent_required')

/**
 * After needsAgreement: asks the student to read and agree, and answers the version now in force
 * for the page's agreement row, or null when it could not be loaded. `updated` is false for a
 * student who was offered no version yet, who is not told the texts changed.
 */
export async function askToAgree(updated: boolean): Promise<string | null> {
  const version = await policyVersion().catch(() => null)
  await wx.showModal({
    title: updated ? '条款已更新' : '请阅读并同意用户协议和隐私政策',
    content: updated ? '请重新阅读用户协议和隐私政策，同意后再提交。' : '勾选同意后再提交。',
    showCancel: false,
  })
  return version
}
