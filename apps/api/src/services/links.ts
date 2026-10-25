import { type LinkTarget, NO_LINK, type VenueSettings } from '@rs/shared'
import { eq } from 'drizzle-orm'
import type { Q } from '../db/client'
import { coaches, lessonTypes, packageProducts } from '../db/schema'
import { ApiError } from '../errors'

const missing = () => new ApiError(400, 'link_missing', '跳转目标不存在，请重新选择')

/** Refuses a link to a record that does not exist. A hidden one is allowed: it may come back. */
export function checkLinkTarget(tx: Q, link: LinkTarget): void {
  const { linkKind: kind, linkId: id } = link
  if (id === null) return
  const table = kind === 'coach' ? coaches : kind === 'package' ? packageProducts : lessonTypes
  if (!tx.select({ id: table.id }).from(table).where(eq(table.id, id)).get()) throw missing()
}

/**
 * The link as students should get it: a target they cannot open now, such as a hidden coach or a
 * package off sale, comes back as no link, so the tap does nothing rather than open an error.
 */
export function liveLink(tx: Q, settings: VenueSettings, link: LinkTarget): LinkTarget {
  return linkOpen(tx, settings, link) ? { linkKind: link.linkKind, linkId: link.linkId } : NO_LINK
}

function linkOpen(tx: Q, settings: VenueSettings, { linkKind, linkId }: LinkTarget): boolean {
  const typeOpen = (id: number) => {
    const t = tx.select().from(lessonTypes).where(eq(lessonTypes.id, id)).get()
    return !!t && t.active && !t.adminOnly && (!t.isTrial || settings.payment.trialEnabled)
  }
  switch (linkKind) {
    case 'none':
      return false
    case 'lesson_type':
      return linkId !== null && typeOpen(linkId)
    case 'coach': {
      if (linkId === null) return false
      return !!tx.select().from(coaches).where(eq(coaches.id, linkId)).get()?.active
    }
    case 'package': {
      if (linkId === null || !settings.payment.packagesEnabled) return false
      const p = tx.select().from(packageProducts).where(eq(packageProducts.id, linkId)).get()
      return !!p && p.onSale && typeOpen(p.lessonTypeId)
    }
    case 'packages':
      return settings.payment.packagesEnabled
    case 'venue':
      return !!settings.venue.address || settings.venue.latitude !== null
    case 'my_packages':
    case 'lessons':
    case 'booking_policy':
      return true
  }
}
