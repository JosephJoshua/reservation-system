import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { coaches, lessonTypes, packageProducts } from './db/schema'
import { setup } from './test/harness'

async function catalog() {
  const h = setup()
  const admin = await h.admin()
  const post = async (path: string, body: object) =>
    (await h.call('POST', path, body, admin)).json as { id: number }
  const lessonTypeId = (
    await post('/admin/lesson-types', {
      name: '一对一',
      durationMinutes: 60,
      price: 30000,
    })
  ).id
  const categoryId = (
    await post('/admin/coach-categories', {
      name: '金牌',
      prices: [{ lessonTypeId, price: 40000 }],
    })
  ).id
  const coachId = (
    await post('/admin/coaches', {
      name: '王教练',
      categoryId,
      lessonTypeIds: [lessonTypeId],
    })
  ).id
  const packageId = (
    await post('/admin/package-products', {
      name: '十次卡',
      lessonTypeId,
      lessonCount: 10,
      price: 280000,
      validityDays: 180,
    })
  ).id
  return { h, admin, lessonTypeId, coachId, packageId }
}

const image = { imageUrl: '/api/uploads/a.png' }

describe('banner and notice links', () => {
  it('saves every kind of target and hands it to the home page', async () => {
    const { h, admin, lessonTypeId, coachId, packageId } = await catalog()
    const targets = [
      { linkKind: 'coach', linkId: coachId },
      { linkKind: 'lesson_type', linkId: lessonTypeId },
      { linkKind: 'package', linkId: packageId },
      { linkKind: 'packages', linkId: null },
      { linkKind: 'my_packages', linkId: null },
      { linkKind: 'lessons', linkId: null },
      { linkKind: 'booking_policy', linkId: null },
    ]
    for (const t of targets) {
      const res = await h.call('POST', '/admin/banners', { ...image, ...t }, admin)
      expect(res.status).toBe(201)
    }
    const home = (await h.call('GET', '/home')).json
    expect(home.banners.map((b: object) => ({ ...b, id: 0, imageUrl: '', title: '' }))).toEqual(
      targets.map((t) => ({ ...t, id: 0, imageUrl: '', title: '' })),
    )
  })

  it('refuses a record link without its id, a page link with one, and a missing record', async () => {
    const { h, admin, coachId } = await catalog()
    const noId = await h.call('POST', '/admin/banners', { ...image, linkKind: 'coach' }, admin)
    expect(noId.status).toBe(400)
    expect(noId.json.error.message).toBe('请选择跳转目标')
    const pageId = { ...image, linkKind: 'packages', linkId: coachId }
    expect((await h.call('POST', '/admin/banners', pageId, admin)).status).toBe(400)
    const gone = { ...image, linkKind: 'coach', linkId: coachId + 100 }
    const res = await h.call('POST', '/admin/banners', gone, admin)
    expect(res.json.error.code).toBe('link_missing')
    const unknown = { ...image, linkKind: 'web', linkId: null }
    expect((await h.call('POST', '/admin/banners', unknown, admin)).status).toBe(400)

    const settings = (await h.call('GET', '/admin/settings', undefined, admin)).json
    expect(settings.notice).toMatchObject({ linkKind: 'none', linkId: null })
    settings.notice = { text: '新教练', endsAt: null, linkKind: 'coach', linkId: coachId + 100 }
    const bad = await h.call('PUT', '/admin/settings', settings, admin)
    expect(bad.json.error.code).toBe('link_missing')
  })

  it('drops a link students cannot open now, and brings it back when they can', async () => {
    const { h, admin, coachId, packageId } = await catalog()
    await h.call('POST', '/admin/banners', { ...image, linkKind: 'coach', linkId: coachId }, admin)
    await h.call(
      'POST',
      '/admin/banners',
      { ...image, linkKind: 'package', linkId: packageId },
      admin,
    )
    await h.call('POST', '/admin/banners', { ...image, linkKind: 'venue' }, admin)
    const settings = (await h.call('GET', '/admin/settings', undefined, admin)).json
    settings.notice = { text: '新教练', endsAt: null, linkKind: 'coach', linkId: coachId }
    expect((await h.call('PUT', '/admin/settings', settings, admin)).status).toBe(200)

    const kinds = async () => {
      const home = (await h.call('GET', '/home')).json
      return [
        home.noticeLink.linkKind,
        ...home.banners.map((b: { linkKind: string }) => b.linkKind),
      ]
    }
    // No address yet, so the venue link has nowhere to go.
    expect(await kinds()).toEqual(['coach', 'coach', 'package', 'none'])

    h.db.update(coaches).set({ active: false }).where(eq(coaches.id, coachId)).run()
    h.db
      .update(packageProducts)
      .set({ onSale: false })
      .where(eq(packageProducts.id, packageId))
      .run()
    settings.venue.address = '海淀区中关村大街59号'
    const now = (await h.call('GET', '/admin/settings', undefined, admin)).json
    await h.call('PUT', '/admin/settings', { ...now, venue: settings.venue }, admin)
    expect(await kinds()).toEqual(['none', 'none', 'none', 'venue'])

    h.db.update(coaches).set({ active: true }).where(eq(coaches.id, coachId)).run()
    expect(await kinds()).toEqual(['coach', 'coach', 'none', 'venue'])
  })

  it('drops page and lesson links that are switched off', async () => {
    const { h, admin, lessonTypeId } = await catalog()
    for (const t of [{ linkKind: 'packages' }, { linkKind: 'lesson_type', linkId: lessonTypeId }])
      await h.call('POST', '/admin/banners', { ...image, ...t }, admin)
    const settings = (await h.call('GET', '/admin/settings', undefined, admin)).json
    settings.payment.packagesEnabled = false
    await h.call('PUT', '/admin/settings', settings, admin)
    h.db.update(lessonTypes).set({ adminOnly: true }).where(eq(lessonTypes.id, lessonTypeId)).run()
    const home = (await h.call('GET', '/home')).json
    expect(home.banners.map((b: { linkKind: string }) => b.linkKind)).toEqual(['none', 'none'])
    // No notice text, so its link is not sent either.
    expect(home.noticeLink).toEqual({ linkKind: 'none', linkId: null })
  })
})
