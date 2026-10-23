import type { CatalogDto, LateCancelRule, StudentDto } from '../lib/shared'
import { api } from './api'

let catalog: { value: CatalogDto; at: number } | null = null

/** The catalog changes rarely, so pages share one copy for a minute. */
export async function getCatalog(fresh = false): Promise<CatalogDto> {
  if (!fresh && catalog && Date.now() - catalog.at < 60_000) return catalog.value
  const value = await api<CatalogDto>('GET', '/catalog')
  catalog = { value, at: Date.now() }
  return value
}

export function getMe(): Promise<StudentDto> {
  return api<StudentDto>('GET', '/me')
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

const AGREED_KEY = 'agreedPolicies'

export function hasAgreed(): boolean {
  return wx.getStorageSync(AGREED_KEY) === true
}

export function setAgreed(): void {
  wx.setStorageSync(AGREED_KEY, true)
}
