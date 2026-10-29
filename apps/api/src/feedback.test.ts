import { existsSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { actionLog, bookings, studentNotices, students } from './db/schema'
import { removeStrayPhotos } from './services/feedback'
import { notifyStudents } from './services/student-notices'
import { type Harness, setup } from './test/harness'
import type { NoticeValues } from './wx-notify'

// The harness clock is 2026-10-23 10:00 at the venue.

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46])

async function bindCoach(h: Harness, coachId: number, wx = 'coach') {
  const admin = await h.admin()
  const { code } = (await h.call('POST', `/admin/coaches/${coachId}/bind-code`, {}, admin)).json
  const res = await h.call('POST', '/coach/bind', { code: `dev:${wx}`, bindCode: code })
  expect(res.status).toBe(200)
  return res.json.token as string
}

/** A paid lesson on 10-25 at 10:00 that has just ended, its coach signed in. */
async function taught(h: Harness, { attended = true } = {}) {
  const { coach, lesson } = h.seed()
  const t = await h.student('a')
  const slot = h.slot(coach.id, '2026-10-25', 10)
  const res = await h.call('POST', '/bookings', { slotId: slot.id, lessonTypeId: lesson.id }, t)
  await h.fakePay(res.json.orderId)
  const id = res.json.bookingId as number
  const ct = await bindCoach(h, coach.id)
  h.clock.now = new Date('2026-10-25T03:05:00Z')
  if (attended) {
    const marked = await h.call(
      'PUT',
      `/coach/lessons/${id}/attendance`,
      { attendance: 'attended' },
      ct,
    )
    expect(marked.status).toBe(200)
  }
  return { coach, lesson, t, ct, id }
}

async function upload(
  h: Harness,
  ct: string,
  id: number,
  data: Buffer = JPEG,
  type = 'image/jpeg',
) {
  const form = new FormData()
  form.append('file', new Blob([data], { type }), 'photo.jpg')
  const res = await h.app.request(`/api/coach/lessons/${id}/photos`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ct}` },
    body: form,
  })
  // biome-ignore lint/suspicious/noExplicitAny: test helper returns loosely typed JSON
  const json: any = await res.json()
  return { status: res.status, json }
}

const write = (h: Harness, ct: string, id: number, text: string, photos: string[] = []) =>
  h.call('PUT', `/coach/lessons/${id}/feedback`, { text, photos }, ct)

const files = (h: Harness) => readdirSync(h.deps.uploadsDir).sort()

function sentNotices(h: Harness) {
  const sent: NoticeValues[] = []
  h.deps.notifier = {
    template: (kind) =>
      kind === 'student_feedback' ? { id: kind, fields: { a: 'note' } } : undefined,
    async send(_openid, _template, page, values) {
      expect(page).toMatch(/^pages\/booking-detail\/index\?id=\d+$/)
      sent.push(values)
      return 'sent'
    },
  }
  return sent
}

describe('lesson feedback', () => {
  it('lets the coach write it with photos once the student came, and the student see it', async () => {
    const h = setup()
    const { t, ct, id } = await taught(h)
    const before = (await h.call('GET', `/coach/lessons/${id}`, undefined, ct)).json
    expect(before).toMatchObject({ feedback: null, feedbackBlocked: null })

    const photo = await upload(h, ct, id)
    expect(photo.status).toBe(201)
    expect(photo.json.url).toMatch(new RegExp(`^/api/uploads/fb${id}-[0-9a-f]{12}\\.jpg$`))
    const saved = await write(h, ct, id, '  正手进步很大，下次练反手。 ', [photo.json.url])
    expect(saved.status).toBe(200)
    expect(saved.json.feedback).toMatchObject({
      text: '正手进步很大，下次练反手。',
      photos: [photo.json.url],
      hidden: false,
      visible: true,
    })
    // The private note is untouched.
    expect(saved.json.coachNote).toBe('')

    const seen = (await h.call('GET', `/bookings/${id}`, undefined, t)).json
    expect(seen.feedback).toEqual({
      text: '正手进步很大，下次练反手。',
      photos: [photo.json.url],
      updatedAt: '2026-10-25T03:05:00.000Z',
    })
    const record = (await h.call('GET', '/feedback', undefined, t)).json
    expect(record).toMatchObject([
      {
        bookingId: id,
        coachName: '王教练',
        lessonTypeName: '一对一私教',
        text: '正手进步很大，下次练反手。',
      },
    ])
    // Another student sees none of it.
    const other = await h.student('b')
    expect((await h.call('GET', '/feedback', undefined, other)).json).toEqual([])
    expect((await h.call('GET', '/feedback')).status).toBe(401)
    expect((await h.call('GET', `/bookings/${id}`, undefined, other)).status).toBe(404)
  })

  it('needs the student to have come, and closes a week after the lesson', async () => {
    const h = setup()
    const { ct, id } = await taught(h, { attended: false })
    const blocked = async () =>
      (await h.call('GET', `/coach/lessons/${id}`, undefined, ct)).json.feedbackBlocked
    expect((await write(h, ct, id, '好')).json.error.code).toBe('not_attended')
    expect((await upload(h, ct, id)).json.error.code).toBe('not_attended')
    expect(await blocked()).toBe('签到为到课后才能写点评')
    await h.call('PUT', `/coach/lessons/${id}/attendance`, { attendance: 'no_show' }, ct)
    expect((await write(h, ct, id, '好')).json.error.code).toBe('not_attended')
    expect(await blocked()).toBe('学员缺席，不能写点评')
    await h.call('PUT', `/coach/lessons/${id}/attendance`, { attendance: 'attended' }, ct)
    expect((await write(h, ct, id, '好')).status).toBe(200)

    // A week from the attendance mark at 03:05, which came after the lesson ended.
    h.clock.now = new Date('2026-11-01T03:05:00Z')
    expect((await write(h, ct, id, '改一下')).status).toBe(200)
    h.clock.now = new Date('2026-11-01T03:05:01Z')
    expect((await write(h, ct, id, '再改一下')).json.error.code).toBe('too_late')
    expect((await h.call('GET', `/coach/lessons/${id}`, undefined, ct)).json.feedbackBlocked).toBe(
      '已超过 7 天点评期限',
    )
    // Deleting stays open: the coach's words are never stuck on show.
    const deleted = await h.call('DELETE', `/coach/lessons/${id}/feedback`, undefined, ct)
    expect(deleted.json.feedback).toBeNull()
  })

  it('leaves the coach a week after the venue marks attendance late', async () => {
    const h = setup()
    const { ct, id } = await taught(h, { attended: false })
    h.clock.now = new Date('2026-11-04T03:00:00Z')
    const admin = await h.admin()
    const marked = await h.call(
      'PUT',
      `/admin/bookings/${id}/attendance`,
      { attendance: 'attended' },
      admin,
    )
    expect(marked.status).toBeLessThan(300)
    expect((await h.call('GET', `/coach/lessons/${id}`, undefined, ct)).json.feedbackBlocked).toBe(
      null,
    )
    // Marking it again does not move the window.
    h.clock.now = new Date('2026-11-05T03:00:00Z')
    const again = await h.call(
      'PUT',
      `/admin/bookings/${id}/attendance`,
      { attendance: 'attended' },
      await h.admin(),
    )
    expect(again.status).toBeLessThan(300)
    h.clock.now = new Date('2026-11-11T03:00:00Z')
    expect((await write(h, ct, id, '补写的点评')).status).toBe(200)
    h.clock.now = new Date('2026-11-11T03:00:01Z')
    expect((await write(h, ct, id, '再补一句')).json.error.code).toBe('too_late')
  })

  it("only lets the lesson's own coach write it", async () => {
    const h = setup()
    const { id } = await taught(h)
    const { coach: other } = h.seed()
    const otherToken = await bindCoach(h, other.id, 'other')
    expect((await write(h, otherToken, id, '好')).status).toBe(404)
    expect((await upload(h, otherToken, id)).status).toBe(404)
    expect(
      (await h.call('DELETE', `/coach/lessons/${id}/feedback`, undefined, otherToken)).status,
    ).toBe(404)
  })

  it('refuses empty or long text, too many photos and photos of another lesson', async () => {
    const h = setup()
    const { ct, id, t, coach, lesson } = await taught(h)
    expect((await write(h, ct, id, '   ')).status).toBe(400)
    expect((await write(h, ct, id, '好'.repeat(501))).status).toBe(400)

    const urls: string[] = []
    for (let i = 0; i < 7; i++) urls.push((await upload(h, ct, id)).json.url)
    expect((await write(h, ct, id, '好', urls)).json.error.code).toBe('too_many_photos')
    // The same photo twice counts once.
    expect(
      (await write(h, ct, id, '好', [urls[0] as string, urls[0] as string])).json.feedback.photos,
    ).toEqual([urls[0]])

    // A second lesson of the same coach: its photos cannot borrow the first lesson's files.
    h.clock.now = new Date('2026-10-23T02:00:00Z')
    const slot = h.slot(coach.id, '2026-10-26', 10)
    const res = await h.call('POST', '/bookings', { slotId: slot.id, lessonTypeId: lesson.id }, t)
    await h.fakePay(res.json.orderId)
    const second = res.json.bookingId as number
    h.clock.now = new Date('2026-10-26T03:05:00Z')
    await h.call('PUT', `/coach/lessons/${second}/attendance`, { attendance: 'attended' }, ct)
    for (const photo of [urls[1] as string, '/api/uploads/banner.png', '/api/uploads/../data.db']) {
      expect((await write(h, ct, second, '好', [photo])).json.error.code).toBe('bad_photo')
    }
  })

  it('takes only images, by their content', async () => {
    const h = setup()
    const { ct, id } = await taught(h)
    const html = await upload(h, ct, id, Buffer.from('<script>alert(1)</script>'), 'image/jpeg')
    expect(html.json.error.code).toBe('bad_type')
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])
    expect((await upload(h, ct, id, png, 'application/octet-stream')).json.url).toMatch(/\.png$/)
    const big = Buffer.concat([JPEG, Buffer.alloc(5 * 1024 * 1024)])
    expect((await upload(h, ct, id, big)).json.error.code).toBe('too_large')
  })

  it('removes the files of photos taken out, and all of them when the feedback is deleted', async () => {
    const h = setup()
    const { ct, id, t } = await taught(h)
    const a = (await upload(h, ct, id)).json.url as string
    const b = (await upload(h, ct, id)).json.url as string
    const name = (url: string) => url.replace('/api/uploads/', '')
    await write(h, ct, id, '好', [a, b])
    await write(h, ct, id, '好', [b])
    expect(files(h)).toEqual([name(b)])

    // Uploaded in the editor but left out when saving.
    const dropped = (await upload(h, ct, id)).json.url as string
    await write(h, ct, id, '好', [b])
    expect(files(h)).toEqual([name(b)])
    expect(existsSync(join(h.deps.uploadsDir, name(dropped)))).toBe(false)

    // Uploaded but never saved.
    const stray = (await upload(h, ct, id)).json.url as string
    const deleted = await h.call('DELETE', `/coach/lessons/${id}/feedback`, undefined, ct)
    expect(deleted.json).toMatchObject({ feedback: null, feedbackBlocked: null })
    expect(existsSync(join(h.deps.uploadsDir, name(stray)))).toBe(false)
    expect(files(h)).toEqual([])
    expect((await h.call('GET', `/bookings/${id}`, undefined, t)).json.feedback).toBeNull()
    // Deleting again is fine.
    expect((await h.call('DELETE', `/coach/lessons/${id}/feedback`, undefined, ct)).status).toBe(
      200,
    )
  })

  it('caps photos uploaded for one lesson and not saved, until the feedback is saved', async () => {
    const h = setup()
    const { ct, id } = await taught(h)
    const saved: string[] = []
    for (let i = 0; i < 6; i++) saved.push((await upload(h, ct, id)).json.url)
    await write(h, ct, id, '好', saved)
    // Saved photos do not count: 24 more fit, from editors closed without saving.
    const unsaved: string[] = []
    for (let i = 0; i < 24; i++) unsaved.push((await upload(h, ct, id)).json.url)
    const over = await upload(h, ct, id)
    expect(over).toMatchObject({ status: 409, json: { error: { code: 'too_many_photos' } } })
    expect(files(h)).toHaveLength(30)
    // Saving clears the ones left out, which makes room again.
    expect((await write(h, ct, id, '好', unsaved.slice(0, 2))).status).toBe(200)
    expect(files(h)).toHaveLength(2)
    expect((await upload(h, ct, id)).status).toBe(201)
  })

  it('refuses a save naming a photo another save has just removed', async () => {
    const h = setup()
    const { ct, id } = await taught(h)
    const a = (await upload(h, ct, id)).json.url as string
    const b = (await upload(h, ct, id)).json.url as string
    // Two phones open on the same feedback: the first save keeps only its own photo.
    expect((await write(h, ct, id, '手机一', [a])).status).toBe(200)
    const late = await write(h, ct, id, '手机二', [b])
    expect(late.json.error.code).toBe('bad_photo')
    const view = (await h.call('GET', `/coach/lessons/${id}`, undefined, ct)).json
    expect(view.feedback).toMatchObject({ text: '手机一', photos: [a] })
  })

  it('removes a day-old photo no feedback uses, and nothing else', async () => {
    const h = setup()
    const { ct, id } = await taught(h)
    const name = (url: string) => url.replace('/api/uploads/', '')
    const used = name((await upload(h, ct, id)).json.url)
    await write(h, ct, id, '好', [`/api/uploads/${used}`])
    const old = name((await upload(h, ct, id)).json.url)
    const fresh = name((await upload(h, ct, id)).json.url)
    writeFileSync(join(h.deps.uploadsDir, 'coach-1.jpg'), JPEG)
    const ago = (hours: number) => new Date(h.clock.now.getTime() - hours * 3_600_000)
    for (const n of [used, old, 'coach-1.jpg']) {
      utimesSync(join(h.deps.uploadsDir, n), ago(25), ago(25))
    }
    utimesSync(join(h.deps.uploadsDir, fresh), ago(23), ago(23))
    removeStrayPhotos(h.deps)
    expect(files(h)).toEqual(['coach-1.jpg', fresh, used].sort())
  })

  it('tells the student once, with what the coach wrote last', async () => {
    const h = setup()
    const sent = sentNotices(h)
    const { ct, id } = await taught(h)
    await write(h, ct, id, '第一版')
    // A double tap, and a fix before the sweeper ran.
    await write(h, ct, id, '第一版')
    await write(h, ct, id, '改好的点评')
    await notifyStudents(h.deps)
    await write(h, ct, id, '又改了一次')
    await h.call('DELETE', `/coach/lessons/${id}/feedback`, undefined, ct)
    await write(h, ct, id, '重新写')
    await notifyStudents(h.deps)
    expect(sent.map((v) => v.note)).toEqual(['改好的点评'])
    expect(
      h.db.select().from(studentNotices).where(eq(studentNotices.kind, 'feedback')).all(),
    ).toHaveLength(1)
  })

  it('holds the message while the feedback is hidden or the lesson not marked attended', async () => {
    const h = setup()
    const sent = sentNotices(h)
    const { ct, id } = await taught(h)
    await write(h, ct, id, '好')
    await h.call('PUT', `/coach/lessons/${id}/attendance`, { attendance: 'no_show' }, ct)
    const coachView = (await h.call('GET', `/coach/lessons/${id}`, undefined, ct)).json
    expect(coachView.feedback).toMatchObject({ hidden: false, visible: false })
    await notifyStudents(h.deps)
    expect(sent).toEqual([])
    await h.call('PUT', `/coach/lessons/${id}/attendance`, { attendance: 'attended' }, ct)
    const admin = await h.admin()
    const [item] = (await h.call('GET', '/admin/feedback', undefined, admin)).json
    await h.call('PUT', `/admin/feedback/${item.id}/hidden`, { hidden: true }, admin)
    h.clock.now = new Date(h.clock.now.getTime() + 6 * 60_000)
    await notifyStudents(h.deps)
    expect(sent).toEqual([])

    await h.call('PUT', `/admin/feedback/${item.id}/hidden`, { hidden: false }, admin)
    h.clock.now = new Date(h.clock.now.getTime() + 6 * 60_000)
    await notifyStudents(h.deps)
    expect(sent.map((v) => v.note)).toEqual(['好'])
  })

  it('does not hold the message for hidden feedback when it could not be sent anyway', async () => {
    const h = setup()
    const { ct, id } = await taught(h)
    await write(h, ct, id, '好')
    const admin = await h.admin()
    const [item] = (await h.call('GET', '/admin/feedback', undefined, admin)).json
    await h.call('PUT', `/admin/feedback/${item.id}/hidden`, { hidden: true }, admin)
    // No notifier configured.
    await notifyStudents(h.deps)
    expect(
      h.db.select().from(studentNotices).where(eq(studentNotices.kind, 'feedback')).get(),
    ).toMatchObject({ bookingId: id, result: 'skipped', retryAt: null })
  })

  it('drops the message at once when the lesson is cancelled before it went out', async () => {
    const h = setup()
    const sent = sentNotices(h)
    const { ct, id } = await taught(h)
    await write(h, ct, id, '好')
    // No route cancels a taught lesson today; the rule holds should one ever do so.
    h.db.update(bookings).set({ status: 'cancelled' }).where(eq(bookings.id, id)).run()
    await notifyStudents(h.deps)
    expect(sent).toEqual([])
    expect(
      h.db.select().from(studentNotices).where(eq(studentNotices.kind, 'feedback')).get(),
    ).toMatchObject({ result: 'skipped', retryAt: null })
  })

  it('drops the message about feedback deleted before it went out, and tells a rewrite', async () => {
    const h = setup()
    const sent = sentNotices(h)
    const { ct, id } = await taught(h)
    await write(h, ct, id, '写错了学员')
    await h.call('DELETE', `/coach/lessons/${id}/feedback`, undefined, ct)
    await notifyStudents(h.deps)
    expect(sent).toEqual([])
    expect(
      h.db.select().from(studentNotices).where(eq(studentNotices.kind, 'feedback')).get()?.result,
    ).toBe('skipped')
    await write(h, ct, id, '正确的点评')
    await notifyStudents(h.deps)
    expect(sent.map((v) => v.note)).toEqual(['正确的点评'])
  })

  it('gives up on the message a day after the feedback was written', async () => {
    const h = setup()
    const sent = sentNotices(h)
    const { ct, id } = await taught(h)
    await write(h, ct, id, '好')
    const admin = await h.admin()
    const [item] = (await h.call('GET', '/admin/feedback', undefined, admin)).json
    await h.call('PUT', `/admin/feedback/${item.id}/hidden`, { hidden: true }, admin)
    await notifyStudents(h.deps)
    h.clock.now = new Date(h.clock.now.getTime() + 25 * 3_600_000)
    await h.call('PUT', `/admin/feedback/${item.id}/hidden`, { hidden: false }, admin)
    await notifyStudents(h.deps)
    expect(sent).toEqual([])
    expect(
      h.db.select().from(studentNotices).where(eq(studentNotices.kind, 'feedback')).get()?.result,
    ).toBe('skipped')
  })

  it('lets the venue hide it from the student and put it back, logging each change once', async () => {
    const h = setup()
    const { ct, id, t } = await taught(h)
    await write(h, ct, id, '不当内容')
    const admin = await h.admin()
    const [item] = (await h.call('GET', '/admin/feedback', undefined, admin)).json
    expect(item).toMatchObject({ bookingId: id, text: '不当内容', hidden: false, visible: true })

    for (let i = 0; i < 2; i++) {
      const hid = await h.call('PUT', `/admin/feedback/${item.id}/hidden`, { hidden: true }, admin)
      expect(hid.json).toMatchObject({ hidden: true, visible: false })
    }
    expect((await h.call('GET', `/bookings/${id}`, undefined, t)).json.feedback).toBeNull()
    expect((await h.call('GET', '/feedback', undefined, t)).json).toEqual([])
    const coachView = (await h.call('GET', `/coach/lessons/${id}`, undefined, ct)).json
    expect(coachView).toMatchObject({
      feedback: { hidden: true },
      feedbackBlocked: '点评已被场馆隐藏，如需修改请联系场馆',
    })
    expect((await write(h, ct, id, '改了')).json.error.code).toBe('feedback_hidden')
    expect((await upload(h, ct, id)).json.error.code).toBe('feedback_hidden')
    expect(coachView.feedback.text).toBe('不当内容')

    await h.call('PUT', `/admin/feedback/${item.id}/hidden`, { hidden: false }, admin)
    expect((await h.call('GET', `/bookings/${id}`, undefined, t)).json.feedback.text).toBe(
      '不当内容',
    )
    const log = h.db
      .select()
      .from(actionLog)
      .all()
      .filter((e) => e.action.startsWith('feedback.'))
    expect(log.map((e) => e.action)).toEqual(['feedback.hide', 'feedback.show'])
    expect(log[0]?.summary).toBe('10月25日 10:00 王教练 一对一私教 的课后点评')
    expect(
      (await h.call('PUT', '/admin/feedback/999/hidden', { hidden: true }, admin)).status,
    ).toBe(404)
  })

  it('keeps hidden feedback the coach deletes as an empty row, so it cannot be written again', async () => {
    const h = setup()
    const sent = sentNotices(h)
    const { ct, id, t } = await taught(h)
    const photo = (await upload(h, ct, id)).json.url as string
    await write(h, ct, id, '不当内容', [photo])
    const admin = await h.admin()
    const [item] = (await h.call('GET', '/admin/feedback', undefined, admin)).json
    await h.call('PUT', `/admin/feedback/${item.id}/hidden`, { hidden: true }, admin)

    for (let i = 0; i < 2; i++) {
      const res = await h.call('DELETE', `/coach/lessons/${id}/feedback`, undefined, ct)
      expect(res.json).toMatchObject({ feedback: null, feedbackBlocked: '点评已删除，不能再写' })
    }
    expect(files(h)).toEqual([])
    expect((await write(h, ct, id, '换个说法')).json.error.code).toBe('feedback_deleted')
    expect((await upload(h, ct, id)).json.error.code).toBe('feedback_deleted')
    const [row] = (await h.call('GET', '/admin/feedback', undefined, admin)).json
    expect(row).toMatchObject({ text: '', photos: [], hidden: true, deleted: true, visible: false })
    const show = await h.call('PUT', `/admin/feedback/${item.id}/hidden`, { hidden: false }, admin)
    expect(show.json.error.code).toBe('feedback_deleted')
    expect((await h.call('GET', `/bookings/${id}`, undefined, t)).json.feedback).toBeNull()
    expect((await h.call('GET', '/feedback', undefined, t)).json).toEqual([])

    // Its message is dropped rather than held for a day.
    await notifyStudents(h.deps)
    expect(sent).toEqual([])
    expect(
      h.db.select().from(studentNotices).where(eq(studentNotices.kind, 'feedback')).get()?.result,
    ).toBe('skipped')
  })

  it('filters the admin list by coach, student and lesson date', async () => {
    const h = setup()
    const { ct, id, coach } = await taught(h)
    await write(h, ct, id, '好')
    const admin = await h.admin()
    const list = (q: string) =>
      h.call('GET', `/admin/feedback?${q}`, undefined, admin).then((r) => r.json)
    expect(await list(`coachId=${coach.id}`)).toHaveLength(1)
    expect(await list(`coachId=${coach.id + 1}`)).toHaveLength(0)
    const [item] = await list('')
    expect(await list(`studentId=${item.student.id}`)).toHaveLength(1)
    expect(await list(`studentId=${item.student.id + 1}`)).toHaveLength(0)
    expect(await list('from=2026-10-25T00:00:00Z&to=2026-10-26T00:00:00Z')).toHaveLength(1)
    expect(await list('from=2026-10-26T00:00:00Z')).toHaveLength(0)
  })

  it('goes with the account when the student deletes it, photos included', async () => {
    const h = setup()
    const { ct, id, t } = await taught(h)
    const photo = (await upload(h, ct, id)).json.url as string
    await write(h, ct, id, '好', [photo])
    await upload(h, ct, id)
    expect(files(h)).toHaveLength(2)
    const res = await h.call('DELETE', '/me', undefined, t)
    expect(res.status).toBe(204)
    expect(files(h)).toEqual([])
    const admin = await h.admin()
    expect((await h.call('GET', '/admin/feedback', undefined, admin)).json).toEqual([])
    expect((await write(h, ct, id, '好')).json.error.code).toBe('account_deleted')
  })
})

describe('lesson photo files', () => {
  const get = (h: Harness, url: string, token?: string) =>
    h.app.request(url, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined)

  it('stops serving photos of hidden feedback, except to staff, and caches them privately', async () => {
    const h = setup()
    const { ct, id } = await taught(h)
    const { url } = (await upload(h, ct, id)).json
    // Shown in the editor before it is saved.
    const unsaved = await get(h, url)
    expect(unsaved.status).toBe(200)
    expect(unsaved.headers.get('cache-control')).toBe('private, max-age=3600')
    await write(h, ct, id, '好', [url])
    expect((await get(h, url)).status).toBe(200)

    const admin = await h.admin()
    const [item] = (await h.call('GET', '/admin/feedback', undefined, admin)).json
    await h.call('PUT', `/admin/feedback/${item.id}/hidden`, { hidden: true }, admin)
    expect((await get(h, url)).status).toBe(404)
    const staffUrl = url.replace('/api/uploads/', '/api/admin/feedback-photos/')
    const staff = await get(h, staffUrl, admin)
    expect(staff.status).toBe(200)
    expect(staff.headers.get('content-type')).toBe('image/jpeg')
    expect(staff.headers.get('cache-control')).toBe('private, no-store')
    expect((await get(h, staffUrl)).status).toBe(401)
    expect((await get(h, staffUrl, ct)).status).toBe(401)
    // Staff who do not moderate feedback (财务) see what students see, and are not turned away
    // with a 403, which would reload their roles.
    const created = await h.call(
      'POST',
      '/admin/staff',
      { name: '财务', username: 'caiwu', password: 'finance-123', roles: ['finance'] },
      admin,
    )
    expect(created.status).toBe(201)
    const finance = await h.admin('caiwu', 'finance-123')
    expect((await get(h, staffUrl, finance)).status).toBe(404)
    // The coach's lesson page no longer lists them.
    const lesson = (await h.call('GET', `/coach/lessons/${id}`, undefined, ct)).json
    expect(lesson.feedback).toMatchObject({ hidden: true, photos: [] })

    await h.call('PUT', `/admin/feedback/${item.id}/hidden`, { hidden: false }, admin)
    expect((await get(h, url)).status).toBe(200)
    const shown = await get(h, staffUrl, finance)
    expect(shown.status).toBe(200)
    expect(shown.headers.get('cache-control')).toBe('private, max-age=3600')
  })

  it('stops serving photos the student no longer sees, as after a no-show', async () => {
    const h = setup()
    const { ct, id } = await taught(h)
    const { url } = (await upload(h, ct, id)).json
    await write(h, ct, id, '好', [url])
    const marked = await h.call(
      'PUT',
      `/coach/lessons/${id}/attendance`,
      { attendance: 'no_show' },
      ct,
    )
    expect(marked.status).toBe(200)
    expect((await get(h, url)).status).toBe(404)
    const lesson = (await h.call('GET', `/coach/lessons/${id}`, undefined, ct)).json
    expect(lesson.feedback).toMatchObject({ visible: false, photos: [] })
    const admin = await h.admin()
    const staff = await get(h, url.replace('/api/uploads/', '/api/admin/feedback-photos/'), admin)
    expect(staff.status).toBe(200)
    expect(staff.headers.get('cache-control')).toBe('private, no-store')
  })

  it('stops serving photos once the student deleted their account', async () => {
    const h = setup()
    const { ct, id } = await taught(h)
    const { url } = (await upload(h, ct, id)).json
    await write(h, ct, id, '好', [url])
    // A file left behind, say by a restore, still does not show.
    const name = url.replace('/api/uploads/', '')
    h.db.update(students).set({ deletedAt: h.clock.now }).where(eq(students.id, 1)).run()
    expect((await get(h, url)).status).toBe(404)
    expect(existsSync(join(h.deps.uploadsDir, name))).toBe(true)
    const admin = await h.admin()
    const staffUrl = url.replace('/api/uploads/', '/api/admin/feedback-photos/')
    expect((await get(h, staffUrl, admin)).status).toBe(404)
  })

  it('keeps other images public, and checks what an admin upload really is', async () => {
    const h = setup()
    const admin = await h.admin()
    const post = (data: Buffer, type: string) => {
      const form = new FormData()
      form.append('file', new Blob([data], { type }), 'x.png')
      return h.app.request('/api/admin/uploads', {
        method: 'POST',
        headers: { Authorization: `Bearer ${admin}` },
        body: form,
      })
    }
    const html = await post(Buffer.from('<html><script>alert(1)</script>'), 'image/png')
    expect(html.status).toBe(400)
    // A JPEG sent as PNG is stored as what it is.
    const res = await post(JPEG, 'image/png')
    expect(res.status).toBe(201)
    const { url } = (await res.json()) as { url: string }
    expect(url).toMatch(/\.jpg$/)
    const served = await get(h, url)
    expect(served.status).toBe(200)
    expect(served.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
  })
})
