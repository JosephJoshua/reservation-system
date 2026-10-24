// What a student would see, worked out from the admin's lists the way the API's /catalog and
// /home do, with the record being edited put in place of the saved one.
import {
  type BannerDto,
  type BookingRules,
  type CatalogDto,
  type CoachDto,
  formatYuan,
  type HomeDto,
  type LessonTypeDto,
  type LinkTarget,
  lessonPrice,
  type PackageProductDto,
  type PriceTag,
  packagePrice,
  rulesFor,
  venueParts,
} from '@rs/shared'
import type { Banner, Coach, CoachCategory, LessonType, PackageProduct } from '../types'

export type CoachForm = Omit<Coach, 'id' | 'bound' | 'bindCode' | 'bindCodeExpiresAt'>
export type LessonForm = Omit<LessonType, 'id'>
export type ProductForm = Omit<PackageProduct, 'id'>
export type BannerForm = Omit<Banner, 'id'>

/** The record being previewed; `id` is null for a new one. */
export type Draft =
  | { kind: 'coach'; id: number | null; form: CoachForm }
  | { kind: 'lessonType'; id: number | null; form: LessonForm }
  | { kind: 'package'; id: number | null; form: ProductForm }
  | { kind: 'banner'; id: number | null; form: BannerForm }
  /** The venue details and notice from the settings, which the 预约 tab shows. */
  | {
      kind: 'home'
      id: null
      venue: HomeDto['venue']
      notice: { text: string; endsAt: string | null } & LinkTarget
      payment: { trialEnabled: boolean; packagesEnabled: boolean }
      /** The banners as the page shows them, so a change in order or a new one shows at once. */
      banners?: Banner[]
      /** The banner the carousel shows, kept in even when students would not see it. */
      bannerId?: number
    }

export interface PreviewSource {
  types: LessonType[]
  coaches: Coach[]
  categories: CoachCategory[]
  products: PackageProduct[]
  banners: Banner[]
  home: HomeDto
  /** From the settings; null when this login can't read them, and both are taken as on. */
  payment: { trialEnabled: boolean; packagesEnabled: boolean } | null
  /** The venue's 默认预约规则, which a lesson type's own rules go over. */
  rules: BookingRules
}

/** The id a new record gets in the preview. */
export const NEW_ID = -1

/**
 * The list with the draft in place of the saved record, or added when it is new, in the API's
 * order: by 排序, then by id with a new record last.
 */
function put<T extends { id: number; sort?: number }>(
  list: T[],
  id: number | null,
  form: Omit<T, 'id'>,
): T[] {
  const row = { ...form, id: id ?? NEW_ID } as T
  const rows =
    id !== null && list.some((r) => r.id === id)
      ? list.map((r) => (r.id === id ? row : r))
      : [...list, row]
  const order = (r: T) => (r.id === NEW_ID ? Number.MAX_SAFE_INTEGER : r.id)
  return rows.sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || order(a) - order(b))
}

export function withDraft(source: PreviewSource, draft: Draft): PreviewSource {
  switch (draft.kind) {
    case 'coach':
      return {
        ...source,
        coaches: put(source.coaches, draft.id, {
          ...draft.form,
          bound: false,
          bindCode: null,
          bindCodeExpiresAt: null,
        }),
      }
    case 'lessonType':
      return { ...source, types: put(source.types, draft.id, draft.form) }
    case 'package':
      return { ...source, products: put(source.products, draft.id, draft.form) }
    case 'banner':
      return { ...source, banners: put(source.banners, draft.id, draft.form) }
    case 'home':
      // Shown even when expired, so the admin sees it; hiddenReasons says it is not live.
      return {
        ...source,
        home: {
          ...source.home,
          venue: draft.venue,
          notice: draft.notice.text,
          // As saved; the API also drops a link students cannot open, which the picker flags.
          noticeLink: { linkKind: draft.notice.linkKind, linkId: draft.notice.linkId },
        },
        payment: draft.payment,
        banners: draft.banners ?? source.banners,
      }
  }
}

export function draftId(draft: Draft) {
  return draft.id ?? NEW_ID
}

const at = (iso: string | null) => (iso ? new Date(iso) : null)

function typePrice(t: LessonType, categoryPrice: number | null, now: Date): PriceTag {
  return lessonPrice(
    {
      price: t.price,
      salePercent: t.salePercent,
      startsAt: at(t.saleStartsAt),
      endsAt: at(t.saleEndsAt),
    },
    categoryPrice,
    now,
  )
}

export function productPrice(p: ProductForm, now: Date): PriceTag {
  return packagePrice(
    {
      price: p.price,
      salePrice: p.salePrice,
      startsAt: at(p.saleStartsAt),
      endsAt: at(p.saleEndsAt),
    },
    now,
  )
}

function bannerShowing(b: BannerForm, now: Date) {
  return (
    b.active &&
    (!b.startsAt || new Date(b.startsAt) < now) &&
    (!b.endsAt || new Date(b.endsAt) >= now)
  )
}

/**
 * The student's catalog as the API builds it. `shown` keeps the previewed record in even where a
 * student would not see it, so the admin still sees how it looks; `hiddenReasons` says why.
 */
export function studentCatalog(
  source: PreviewSource,
  now: Date,
  shown?: { kind: Draft['kind']; id: number },
): CatalogDto & { banners: BannerDto[]; categoryOf: Map<number, string> } {
  const trialEnabled = source.payment?.trialEnabled ?? true
  const packagesEnabled = source.payment?.packagesEnabled ?? true
  const is = (kind: Draft['kind'], id: number) => shown?.kind === kind && shown.id === id
  const types = source.types.filter(
    (t) => is('lessonType', t.id) || (t.active && !t.adminOnly && (!t.isTrial || trialEnabled)),
  )
  const categoryName = new Map(source.categories.map((c) => [c.id, c.name]))
  const coaches: CoachDto[] = source.coaches
    .filter((c) => c.active || is('coach', c.id))
    .map((c) => ({
      id: c.id,
      name: c.name,
      category: (c.categoryId && categoryName.get(c.categoryId)) || '',
      title: c.title,
      tags: c.tags,
      avatarUrl: c.avatarUrl,
      lessons: types.flatMap((t) => {
        if (!c.lessonTypeIds.includes(t.id)) return []
        const category = source.categories.find((cat) => cat.id === c.categoryId)
        const own = category?.prices.find((p) => p.lessonTypeId === t.id)?.price ?? null
        return [{ lessonTypeId: t.id, price: typePrice(t, own, now) }]
      }),
    }))
  const lessonTypes: LessonTypeDto[] = types.map((t) => {
    const prices = coaches.flatMap((c) => c.lessons.filter((l) => l.lessonTypeId === t.id))
    const cheapest = prices.reduce<(typeof prices)[number] | null>(
      (min, p) => (!min || p.price.price < min.price.price ? p : min),
      null,
    )
    return {
      id: t.id,
      name: t.name,
      description: t.description,
      durationMinutes: t.durationMinutes,
      isTrial: t.isTrial,
      capacity: t.capacity,
      minStudents: t.minStudents,
      fromPrice: cheapest?.price ?? null,
      rules: rulesFor(source.rules, t.rules),
    }
  })
  const typeIds = new Set(types.map((t) => t.id))
  const packageProducts: PackageProductDto[] = source.products
    .filter(
      (p) => is('package', p.id) || (packagesEnabled && p.onSale && typeIds.has(p.lessonTypeId)),
    )
    .map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      lessonTypeId: p.lessonTypeId,
      coachIds: p.coachIds,
      lessonCount: p.lessonCount,
      validityDays: p.validityDays,
      price: productPrice(p, now),
    }))
  const banners = source.banners
    // The previewed banner shows even before its image is uploaded, as an empty slide.
    .filter((b) => is('banner', b.id) || (b.imageUrl && bannerShowing(b, now)))
    .map((b) => ({
      id: b.id,
      imageUrl: b.imageUrl,
      title: b.title,
      linkKind: b.linkKind,
      linkId: b.linkId,
    }))
  return {
    lessonTypes,
    coaches,
    packageProducts,
    banners,
    categoryOf: categoryName,
    payment: { trialEnabled, perClassEnabled: true, packagesEnabled },
    policies: { booking: '', agreement: '', privacy: '', version: '' },
  }
}

/** 10月24日 14:00, in venue time. */
const fmt = (iso: string) => {
  const p = venueParts(new Date(iso))
  return `${p.month}月${p.day}日 ${String(p.hours).padStart(2, '0')}:${String(p.minutes).padStart(2, '0')}`
}

/** Why students would not see the previewed record now, in admin copy. Empty when they would. */
export function hiddenReasons(source: PreviewSource, draft: Draft, now: Date): string[] {
  const trialEnabled = source.payment?.trialEnabled ?? true
  const packagesEnabled = source.payment?.packagesEnabled ?? true
  const typeVisible = (t: LessonType | undefined) =>
    !!t && t.active && !t.adminOnly && (!t.isTrial || trialEnabled)
  switch (draft.kind) {
    case 'coach': {
      const f = draft.form
      if (!f.active) return ['教练已停用，学员看不到这位教练']
      const taught = source.types.filter((t) => f.lessonTypeIds.includes(t.id) && typeVisible(t))
      return taught.length ? [] : ['还没有可预约的课程，学员只能看到介绍，不能预约']
    }
    case 'lessonType': {
      const f = draft.form
      const reasons: string[] = []
      if (!f.active) reasons.push('课程已停用，学员看不到')
      else if (f.adminOnly) reasons.push('仅测试学员可见，其他学员看不到')
      else if (f.isTrial && !trialEnabled) reasons.push('体验课已在设置中关闭，学员看不到')
      const id = draftId(draft)
      if (!source.coaches.some((c) => c.active && c.lessonTypeIds.includes(id))) {
        reasons.push('还没有在职教练教这门课，学员无法预约。在教练里勾选所教课程')
      }
      return reasons
    }
    case 'package': {
      const f = draft.form
      if (!f.onSale) return ['未在售，学员看不到']
      if (!packagesEnabled) return ['课时包已在设置中关闭，学员看不到']
      if (!typeVisible(source.types.find((t) => t.id === f.lessonTypeId))) {
        return ['所属课程学员看不到，这个课时包也不显示']
      }
      return []
    }
    case 'home': {
      const { text, endsAt } = draft.notice
      const reasons =
        text && endsAt && new Date(endsAt) <= now ? ['公告已过结束时间，学员看不到'] : []
      const banner = source.banners.find((b) => b.id === draft.bannerId)
      if (banner) {
        const form = { kind: 'banner', id: banner.id, form: banner } as const
        reasons.push(...hiddenReasons(source, form, now).map((r) => `轮播图：${r}`))
      }
      return reasons
    }
    case 'banner': {
      const f = draft.form
      if (!f.active) return ['已设为隐藏，学员看不到']
      if (f.startsAt && new Date(f.startsAt) >= now)
        return [`${fmt(f.startsAt)} 开始展示，现在学员还看不到`]
      if (f.endsAt && new Date(f.endsAt) < now) return ['展示时间已过，学员看不到']
      return []
    }
  }
}

export const yuan = (fen: number) => `¥${formatYuan(fen)}`

export function priceText(tag: PriceTag | null): { price: string; original: string } {
  if (!tag) return { price: '', original: '' }
  return {
    price: yuan(tag.price),
    original: tag.originalPrice == null ? '' : yuan(tag.originalPrice),
  }
}

export type CatalogData = ReturnType<typeof studentCatalog>
