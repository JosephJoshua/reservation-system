import type { HomeDto, LinkTarget } from '../lib/shared'
import { navigateOnce, switchTabOnce } from './nav'
import { openOnce } from './tap'

/** Opens the venue on a map, or copies the address when no map point is set. */
export function openVenue(venue: HomeDto['venue']): void {
  const { latitude, longitude, address, name } = venue
  if (latitude == null || longitude == null) {
    if (address) openOnce((complete) => wx.setClipboardData({ data: address, complete }))
    return
  }
  openOnce((complete) =>
    wx.openLocation({ latitude, longitude, name, address, scale: 16, complete }),
  )
}

/** Follows a banner or notice link set in the admin. The API sends none for a dead target. */
export function openLink(link: LinkTarget, venue: HomeDto['venue'] | null): void {
  const id = link.linkId
  switch (link.linkKind) {
    case 'lesson_type':
      if (id) navigateOnce(`/pages/book/index?lessonTypeId=${id}`)
      return
    case 'coach':
      if (id) navigateOnce(`/pages/coach-detail/index?id=${id}`)
      return
    case 'package':
      if (id) navigateOnce(`/pages/packages/index?id=${id}`)
      return
    case 'packages':
      navigateOnce('/pages/packages/index')
      return
    case 'my_packages':
      navigateOnce('/pages/my-packages/index')
      return
    case 'lessons':
      switchTabOnce('/pages/lessons/index')
      return
    case 'venue':
      if (venue) openVenue(venue)
      return
    case 'booking_policy':
      navigateOnce('/pages/policy/index?kind=booking')
      return
  }
}
