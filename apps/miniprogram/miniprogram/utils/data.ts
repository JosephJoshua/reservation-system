import type { CatalogDto, LateCancelRule, MeDto } from '../lib/shared'
import { api, publicApi } from './api'

let catalog: { value: CatalogDto; at: number } | null = null

/** The catalog changes rarely, so pages share one copy for a minute. */
export async function getCatalog(fresh = false): Promise<CatalogDto> {
  if (!fresh && catalog && Date.now() - catalog.at < 60_000) return catalog.value
  const value = await api<CatalogDto>('GET', '/catalog')
  catalog = { value, at: Date.now() }
  return value
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
    rule.kind === 'forfeit'
      ? '逾期不退费用和课时'
      : rule.percent === 100
        ? '逾期也全额退款'
        : `逾期退 ${rule.percent}% 费用，不退课时`
  return `开课前 ${hours} 小时可免费取消，${late}。`
}

/** Records that the student agreed to the policies now in force, as the policy page shows them. */
export async function agreePolicies(): Promise<void> {
  const { version } = await publicApi<CatalogDto['policies']>('GET', '/policies')
  await api<void>('POST', '/me/consent', { version })
}
