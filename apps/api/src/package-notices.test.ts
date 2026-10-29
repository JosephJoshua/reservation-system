import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { immediate } from './db/client'
import { migrationsFolder } from './db/migrate'
import { packageNotices, packageProducts, packages, students } from './db/schema'
import { lastDay, notifyPackages } from './services/package-notices'
import { type Harness, setup } from './test/harness'
import { fieldValue, type NoticeKind, type NoticeValues, type Notifier } from './wx-notify'

type Sent = { openid: string; page: string; values: NoticeValues }

function withNotifier(h: Harness, result: 'sent' | 'refused' | 'fail' = 'sent') {
  const sent: Sent[] = []
  const state = { result }
  const notifier: Notifier = {
    template: (kind: NoticeKind) =>
      kind === 'student_package' ? { id: 'tpl_package', fields: { thing1: 'package' } } : undefined,
    async send(openid, _template, page, values) {
      if (state.result === 'fail') throw new Error('offline')
      sent.push({ openid, page, values })
      return state.result
    },
  }
  h.deps.notifier = notifier
  return { sent, state }
}

/** A student with a paid package of `lessonCount` lessons valid for `validityDays`. */
async function withPackage(h: Harness, { lessonCount = 3, validityDays = 30, name = 'a' } = {}) {
  const seeded = h.seed()
  const product = h.db
    .insert(packageProducts)
    .values({
      name: '3 次课',
      lessonTypeId: seeded.lesson.id,
      lessonCount,
      price: 54000,
      validityDays,
    })
    .returning()
    .get()
  const t = await h.student(name)
  await h.call('PUT', '/me', { name: '小明' }, t)
  const res = await h.call('POST', '/packages/purchase', { productId: product.id }, t)
  expect(res.status).toBe(201)
  await h.fakePay(res.json.orderId)
  const pkg = h.db.select().from(packages).get()
  if (!pkg) throw new Error('no package')
  return { ...seeded, product, t, pkg }
}

const at = (h: Harness, iso: string) => {
  h.clock.now = new Date(iso)
}

const rows = (h: Harness) =>
  h.db
    .select()
    .from(packageNotices)
    .all()
    .map((n) => ({ kind: n.kind, result: n.result }))

async function book(h: Harness, t: string, slotId: number, lessonTypeId: number) {
  const res = await h.call('POST', '/bookings', { slotId, lessonTypeId }, t)
  expect(res.status).toBe(201)
  expect(res.json.status).toBe('confirmed')
  return res.json.bookingId as number
}

describe('package notices', () => {
  it('offers the template to the mini program', async () => {
    const h = setup()
    withNotifier(h)
    const t = await h.student('a')
    expect((await h.call('GET', '/me', undefined, t)).json.noticeTemplates).toEqual({
      package: 'tpl_package',
    })
  })

  it('reminds once, 7 days before expiry, while lessons are left', async () => {
    const h = setup()
    const { sent } = withNotifier(h)
    const { pkg } = await withPackage(h)
    // Bought 2026-10-23, valid 30 days: through 2026-11-22, expiring at its end.
    expect(lastDay(pkg.expiresAt)).toBe('2026年11月22日')
    at(h, '2026-11-15T15:00:00Z') // 7 days and 1 hour before
    await notifyPackages(h.deps)
    expect(sent).toEqual([])
    at(h, '2026-11-15T16:00:00Z')
    await notifyPackages(h.deps)
    await notifyPackages(h.deps)
    expect(sent).toEqual([
      {
        openid: 'dev_a',
        page: 'pages/my-packages/index',
        values: {
          student: '小明',
          package: '3 次课',
          left: '3节',
          expiry: '2026年11月22日',
          place: 'Lumi乒乓',
          status: '即将到期',
          note: '还有3节未约，到期后不能再约课',
        },
      },
    ])
    expect(rows(h)).toEqual([{ kind: 'expiring', result: 'sent' }])
  })

  it('reminds again of a new expiry after an extension, and not of an expired package', async () => {
    const h = setup()
    const { sent } = withNotifier(h)
    const { pkg } = await withPackage(h)
    at(h, '2026-11-20T00:00:00Z')
    await notifyPackages(h.deps)
    expect(sent).toHaveLength(1)
    const admin = await h.admin()
    expect(
      (await h.call('POST', `/admin/packages/${pkg.id}/extend`, { days: 3 }, admin)).status,
    ).toBe(204)
    await notifyPackages(h.deps)
    expect(sent.map((s) => s.values.expiry)).toEqual(['2026年11月22日', '2026年11月25日'])
    at(h, '2026-11-26T00:00:00Z')
    await notifyPackages(h.deps)
    expect(sent).toHaveLength(2)
  })

  it('drops a reminder whose expiry was extended before it was sent', async () => {
    const h = setup()
    const { sent, state } = withNotifier(h, 'fail')
    const { pkg } = await withPackage(h)
    at(h, '2026-11-20T00:00:00Z')
    await notifyPackages(h.deps)
    expect(h.logs.map((l) => l.message)).toContain('package notice failed')
    const admin = await h.admin()
    await h.call('POST', `/admin/packages/${pkg.id}/extend`, { days: 30 }, admin)
    state.result = 'sent'
    at(h, '2026-11-20T00:10:00Z')
    await notifyPackages(h.deps)
    expect(sent).toEqual([])
    expect(rows(h)).toEqual([])
  })

  it('does not remind of a package with no lessons left to book, or bought inside the window', async () => {
    const h = setup()
    const { sent } = withNotifier(h)
    const { coach, lesson, t } = await withPackage(h, { lessonCount: 1 })
    await book(h, t, h.slot(coach.id, '2026-10-26').id, lesson.id)
    await notifyPackages(h.deps)
    expect(sent.map((s) => s.values.status)).toEqual(['课时已约完'])
    at(h, '2026-11-20T00:00:00Z')
    await notifyPackages(h.deps)
    expect(sent).toHaveLength(1)

    const short = setup()
    const s = withNotifier(short)
    await withPackage(short, { validityDays: 5 })
    await notifyPackages(short.deps)
    at(short, '2026-10-27T00:00:00Z')
    await notifyPackages(short.deps)
    expect(s.sent).toEqual([])
  })

  it('tells when the last lesson is booked, once, unless it came back first', async () => {
    const h = setup()
    const { sent } = withNotifier(h)
    const { coach, lesson, t } = await withPackage(h, { lessonCount: 2 })
    await book(h, t, h.slot(coach.id, '2026-10-26', 9).id, lesson.id)
    await notifyPackages(h.deps)
    expect(sent).toEqual([])

    const last = await book(h, t, h.slot(coach.id, '2026-10-26', 10).id, lesson.id)
    // Queued, then cancelled before it went out: the lesson is back, so no message.
    immediate(h.db, (tx) => {
      tx.insert(packageNotices)
        .values({
          packageId: 1,
          kind: 'used_up',
          expiresAt: h.db.select().from(packages).get()?.expiresAt ?? new Date(),
          createdAt: h.deps.now(),
        })
        .run()
    })
    expect((await h.call('POST', `/bookings/${last}/cancel`, {}, t)).status).toBe(200)
    await notifyPackages(h.deps)
    expect(sent).toEqual([])
    expect(rows(h)).toEqual([])

    await book(h, t, h.slot(coach.id, '2026-10-26', 11).id, lesson.id)
    await notifyPackages(h.deps)
    await notifyPackages(h.deps)
    expect(sent.map((s) => s.values)).toEqual([
      {
        student: '小明',
        package: '3 次课',
        left: '0节',
        expiry: '2026年11月22日',
        place: 'Lumi乒乓',
        status: '课时已约完',
        note: '课时已全部约完，可续购课时包',
      },
    ])
    // Back and used up again later: told once is enough.
    const [booking] = (await h.call('GET', '/bookings', undefined, t)).json.filter(
      (b: { status: string }) => b.status === 'confirmed',
    )
    await h.call('POST', `/bookings/${booking.id}/cancel`, {}, t)
    await notifyPackages(h.deps)
    await book(h, t, h.slot(coach.id, '2026-10-26', 12).id, lesson.id)
    await notifyPackages(h.deps)
    expect(sent).toHaveLength(1)
  })

  it('skips used up when another package is left, and for deleted accounts', async () => {
    const h = setup()
    const { sent } = withNotifier(h)
    const { coach, lesson, product, t } = await withPackage(h, { lessonCount: 1 })
    const again = await h.call('POST', '/packages/purchase', { productId: product.id }, t)
    await h.fakePay(again.json.orderId)
    await book(h, t, h.slot(coach.id, '2026-10-26').id, lesson.id)
    await notifyPackages(h.deps)
    expect(sent).toEqual([])
    expect(rows(h)).toEqual([{ kind: 'used_up', result: 'skipped' }])

    h.db.update(packages).set({ lessonsRemaining: 0 }).where(eq(packages.id, 2)).run()
    h.db.update(students).set({ openid: 'deleted:1:x' }).run()
    await notifyPackages(h.deps)
    expect(sent).toEqual([])
    expect(rows(h)).toEqual([
      { kind: 'used_up', result: 'skipped' },
      { kind: 'used_up', result: 'skipped' },
    ])
  })

  it('reminds of a lesson that came back to a package close to expiry', async () => {
    const h = setup()
    const { sent } = withNotifier(h)
    const { coach, lesson, t } = await withPackage(h, { lessonCount: 1 })
    at(h, '2026-11-17T00:00:00Z')
    const id = await book(h, t, h.slot(coach.id, '2026-11-20').id, lesson.id)
    // Queued just before the booking and sent after it: nothing left to remind of.
    immediate(h.db, (tx) => {
      tx.insert(packageNotices)
        .values({
          packageId: 1,
          kind: 'expiring',
          expiresAt: tx.select().from(packages).get()?.expiresAt ?? new Date(),
          createdAt: h.deps.now(),
        })
        .run()
    })
    await notifyPackages(h.deps)
    expect(sent.map((s) => s.values.status)).toEqual(['课时已约完'])
    expect((await h.call('POST', `/bookings/${id}/cancel`, {}, t)).status).toBe(200)
    await notifyPackages(h.deps)
    expect(sent.map((s) => s.values.status)).toEqual(['课时已约完', '即将到期'])
  })

  it('tells used up when the other package is only for other coaches', async () => {
    const h = setup()
    const { sent } = withNotifier(h)
    const { coach, lesson, t, pkg } = await withPackage(h, { lessonCount: 1 })
    const second = h.db
      .insert(packages)
      .values({ ...pkg, id: undefined, coachIds: [coach.id + 1], lessonsRemaining: 5 })
      .returning()
      .get()
    await book(h, t, h.slot(coach.id, '2026-10-26').id, lesson.id)
    await notifyPackages(h.deps)
    expect(sent.map((s) => s.values.status)).toEqual(['课时已约完'])
    expect(second.lessonsRemaining).toBe(5)
  })

  it('records refusals and retries failed sends until they are a day old', async () => {
    const h = setup()
    const { sent, state } = withNotifier(h, 'refused')
    const { coach, lesson, t } = await withPackage(h, { lessonCount: 1 })
    await book(h, t, h.slot(coach.id, '2026-10-26').id, lesson.id)
    await notifyPackages(h.deps)
    expect(rows(h)).toEqual([{ kind: 'used_up', result: 'refused' }])

    state.result = 'fail'
    at(h, '2026-11-20T00:00:00Z')
    h.db.update(packages).set({ lessonsRemaining: 1 }).run()
    await notifyPackages(h.deps)
    expect(rows(h)).toEqual([
      { kind: 'used_up', result: 'refused' },
      { kind: 'expiring', result: null },
    ])
    // Not before the retry time.
    state.result = 'sent'
    await notifyPackages(h.deps)
    expect(sent).toHaveLength(1)
    at(h, '2026-11-20T00:06:00Z')
    await notifyPackages(h.deps)
    expect(sent).toHaveLength(2)

    state.result = 'fail'
    h.db.delete(packageNotices).where(eq(packageNotices.kind, 'expiring')).run()
    await notifyPackages(h.deps)
    at(h, '2026-11-21T00:07:00Z')
    state.result = 'sent'
    await notifyPackages(h.deps)
    expect(sent).toHaveLength(2)
    expect(rows(h)).toContainEqual({ kind: 'expiring', result: 'skipped' })
  })

  it('lists students with packages expiring in 30 days for the admin, soonest first', async () => {
    const h = setup()
    withNotifier(h)
    const { lesson } = await withPackage(h, { validityDays: 40 })
    const later = h.db
      .insert(packageProducts)
      .values({
        name: '短期包',
        lessonTypeId: lesson.id,
        lessonCount: 2,
        price: 1,
        validityDays: 20,
      })
      .returning()
      .get()
    const used = h.db
      .insert(packageProducts)
      .values({ name: '空包', lessonTypeId: lesson.id, lessonCount: 1, price: 1, validityDays: 10 })
      .returning()
      .get()
    const b = await h.student('b')
    await h.call('PUT', '/me', { name: '小红' }, b)
    for (const [token, product] of [
      [b, later],
      [b, used],
    ] as const) {
      const res = await h.call('POST', '/packages/purchase', { productId: product.id }, token)
      await h.fakePay(res.json.orderId)
    }
    h.db.update(packages).set({ lessonsRemaining: 0 }).where(eq(packages.name, '空包')).run()
    const admin = await h.admin()
    expect((await h.call('GET', '/admin/students?expiring=1', undefined, admin)).json).toEqual([
      expect.objectContaining({
        name: '小红',
        expiring: expect.objectContaining({
          name: '短期包',
          lessonsRemaining: 2,
          notice: null,
          more: 0,
        }),
      }),
    ])
    at(h, '2026-11-06T00:00:00Z')
    await notifyPackages(h.deps)
    const fresh = await h.admin()
    const list = (await h.call('GET', '/admin/students?expiring=1', undefined, fresh)).json
    expect(list.map((s: { name: string }) => s.name)).toEqual(['小红', '小明'])
    expect(list[0].expiring).toMatchObject({ notice: 'sent' })
    expect(
      (await h.call('GET', '/admin/students?expiring=1&q=小明', undefined, fresh)).json,
    ).toHaveLength(1)
    expect((await h.call('GET', '/admin/students?expiring=2', undefined, fresh)).status).toBe(400)
  })
})

describe('fieldValue', () => {
  it('keeps the number for number fields', () => {
    expect(fieldValue('number2', '3节')).toBe('3')
    expect(fieldValue('thing2', '3节')).toBe('3节')
    expect(fieldValue('number2', '小明')).toBe('小明')
  })
})

describe('0010_package_notices', () => {
  it('treats packages already used up as told', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = off')
    const files = readFileSync(join(migrationsFolder, 'meta/_journal.json'), 'utf8')
    const tags = (JSON.parse(files) as { entries: { tag: string }[] }).entries.map((e) => e.tag)
    const index = tags.findIndex((t) => t.endsWith('_package_notices'))
    const run = (tag: string) => {
      const sql = readFileSync(join(migrationsFolder, `${tag}.sql`), 'utf8')
      for (const statement of sql.split('--> statement-breakpoint')) db.exec(statement)
    }
    for (const tag of tags.slice(0, index)) run(tag)
    const insert = db.prepare(
      "insert into packages (student_id, product_id, name, lesson_type_id, coach_ids, lessons_purchased, lessons_remaining, price_paid, expires_at, status, order_id) values (1, 1, 'p', 1, '[]', 3, ?, 1, 5, 'active', 1)",
    )
    insert.run(0)
    insert.run(2)
    run(tags[index] as string)
    expect(db.prepare('select package_id, kind, result from package_notices').all()).toEqual([
      { package_id: 1, kind: 'used_up', result: 'skipped' },
    ])
  })
})
