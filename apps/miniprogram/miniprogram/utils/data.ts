import type { CatalogDto, LateCancelRule, PackageDto, StudentDto } from '../lib/shared'
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

/** Mirrors the API's choice: the usable package that expires first. */
export function usablePackage(
  packages: PackageDto[],
  lessonTypeId: number,
  coachId: number,
  startsAt: string,
): PackageDto | null {
  return (
    packages
      .filter(
        (p) =>
          p.status === 'active' &&
          p.lessonTypeId === lessonTypeId &&
          p.lessonsRemaining > 0 &&
          p.expiresAt > startsAt &&
          (p.coachIds.length === 0 || p.coachIds.includes(coachId)),
      )
      .sort((a, b) =>
        a.expiresAt === b.expiresAt ? a.id - b.id : a.expiresAt < b.expiresAt ? -1 : 1,
      )[0] ?? null
  )
}

/** One line on what cancelling late costs, for the confirm and detail pages. */
export function cancelRuleText(hours: number, rule: LateCancelRule): string {
  const late =
    rule.kind === 'forfeit'
      ? '之后取消不退款，课时包课时照常扣除'
      : rule.percent === 100
        ? '之后取消也全额退款'
        : `之后取消退还 ${rule.percent}%，课时包课时照常扣除`
  return `开课前 ${hours} 小时可免费取消，${late}。`
}

const AGREED_KEY = 'agreedPolicies'

export function hasAgreed(): boolean {
  return wx.getStorageSync(AGREED_KEY) === true
}

export function setAgreed(): void {
  wx.setStorageSync(AGREED_KEY, true)
}
