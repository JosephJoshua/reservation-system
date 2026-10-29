import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { orders, sessions } from './db/schema'
import { loginNameWaitMs } from './services/auth'
import { hashToken } from './services/ids'
import { serveSites } from './sites'
import { ADMIN_PASSWORD, type Harness, setup } from './test/harness'

const login = (h: Harness, username: string, password: string, from = '10.0.0.1') =>
  h.call('POST', '/admin/login', { username, password }, undefined, { 'X-Forwarded-For': from })
const minutes = (h: Harness, n: number) => {
  h.clock.now = new Date(h.clock.now.getTime() + n * 60_000)
}

async function addDesk(h: Harness) {
  const admin = await h.admin()
  const res = await h.call(
    'POST',
    '/admin/staff',
    { name: '前台', username: 'desk', password: 'desk-pass-1', roles: ['front_desk'] },
    admin,
  )
  expect(res.status).toBe(201)
}

describe('staff login limits', () => {
  it('backs a login name off from wrong passwords, starting at a minute', () => {
    expect([0, 9, 10, 11, 12, 13, 14, 20].map((n) => loginNameWaitMs(n) / 60_000)).toEqual([
      0, 0, 1, 2, 4, 8, 15, 15,
    ])
  })

  it("does not let one login's good logins reset guesses at another", async () => {
    const h = setup()
    await addDesk(h)
    const statuses: number[] = []
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 9; i++) statuses.push((await login(h, 'admin', `guess-${i}`)).status)
      expect((await login(h, 'desk', 'desk-pass-1')).status).toBe(200)
    }
    // The tenth wrong password in a row starts the wait; the desk's own logins never clear it.
    expect(statuses.slice(0, 10)).toEqual([...Array(10).fill(401)])
    expect(statuses.slice(10)).toEqual(Array(17).fill(429))
    expect((await login(h, 'admin', ADMIN_PASSWORD)).json.error.message).toBe(
      '尝试次数过多，请 1 分钟后再试',
    )
  })

  it('counts a name across addresses, and waits longer with each further miss', async () => {
    const h = setup()
    for (let i = 0; i < 10; i++) {
      expect((await login(h, 'admin', 'x', `10.1.0.${i}`)).status).toBe(401)
    }
    expect((await login(h, 'admin', ADMIN_PASSWORD, '10.2.0.1')).status).toBe(429)
    minutes(h, 1)
    expect((await login(h, 'admin', 'x', '10.2.0.2')).status).toBe(401)
    minutes(h, 1)
    expect((await login(h, 'admin', ADMIN_PASSWORD, '10.2.0.3')).status).toBe(429)
    minutes(h, 1)
    expect((await login(h, 'admin', ADMIN_PASSWORD, '10.2.0.3')).status).toBe(200)
    // A good login starts the count afresh.
    expect((await login(h, 'admin', 'x', '10.2.0.4')).status).toBe(401)
    expect((await login(h, 'admin', ADMIN_PASSWORD, '10.2.0.4')).status).toBe(200)
  })

  it('waits 15 minutes at most, and forgets misses 15 minutes after the last', async () => {
    const h = setup()
    for (let i = 0; i < 10; i++) await login(h, 'admin', 'x')
    // Tries while waiting do not count.
    expect((await login(h, 'admin', 'x')).status).toBe(429)
    for (const wait of [1, 2, 4, 8]) {
      minutes(h, wait)
      expect((await login(h, 'admin', 'x')).status).toBe(401)
    }
    minutes(h, 14)
    expect((await login(h, 'admin', ADMIN_PASSWORD)).status).toBe(429)
    minutes(h, 1)
    expect((await login(h, 'admin', ADMIN_PASSWORD)).status).toBe(200)

    for (let i = 0; i < 9; i++) await login(h, 'admin', 'x')
    minutes(h, 16)
    expect((await login(h, 'admin', 'x')).status).toBe(401)
    expect((await login(h, 'admin', ADMIN_PASSWORD)).status).toBe(200)
  })

  it('keeps a name in from an address it signed in from while others guess at it', async () => {
    const h = setup()
    expect((await login(h, 'admin', ADMIN_PASSWORD, '10.9.9.9')).status).toBe(200)
    for (let i = 0; i < 12; i++) await login(h, 'admin', 'x', `10.1.0.${i}`)
    expect((await login(h, 'admin', ADMIN_PASSWORD, '10.1.0.99')).status).toBe(429)
    expect((await login(h, 'admin', ADMIN_PASSWORD, '10.9.9.9')).status).toBe(200)
  })

  it('gives a shared address room for typos, but not unlimited guesses', async () => {
    const h = setup()
    await addDesk(h)
    // Venue Wi-Fi: one address for everyone. Someone else's typos do not shut the desk out.
    for (let i = 0; i < 10; i++) await login(h, 'nobody', 'x', '1.2.3.4')
    expect((await login(h, 'desk', 'desk-pass-1', '1.2.3.4')).status).toBe(200)
    for (let i = 0; i < 40; i++) await login(h, `name${i}`, 'x', '1.2.3.4')
    // Fifty misses from one address stop it, and a good login does not reset that.
    expect((await login(h, 'desk', 'desk-pass-1', '1.2.3.4')).status).toBe(429)
    expect((await login(h, 'desk', 'desk-pass-1', '5.6.7.8')).status).toBe(200)
    expect((await login(h, 'desk', 'desk-pass-1', '1.2.3.4')).status).toBe(429)
    minutes(h, 16)
    expect((await login(h, 'desk', 'desk-pass-1', '1.2.3.4')).status).toBe(200)
  })
})

describe('sessions', () => {
  it('keeps only a hash of each token', async () => {
    const h = setup()
    const admin = await h.admin()
    const student = await h.student('a')
    const rows = h.db.select().from(sessions).all()
    expect(rows.map((r) => r.tokenHash).sort()).toEqual(
      [hashToken(admin), hashToken(student)].sort(),
    )
    expect(JSON.stringify(rows)).not.toContain(admin)
    // Neither the hash nor a made-up token signs anyone in.
    expect((await h.call('GET', '/admin/me', undefined, hashToken(admin))).status).toBe(401)
    expect((await h.call('GET', '/me', undefined, hashToken(student))).status).toBe(401)
    expect((await h.call('GET', '/admin/me', undefined, admin)).status).toBe(200)
    expect((await h.call('POST', '/admin/logout', undefined, admin)).status).toBe(204)
    expect((await h.call('GET', '/admin/me', undefined, admin)).status).toBe(401)
  })

  it('signs a deactivated coach out for good', async () => {
    const h = setup()
    const { coach } = h.seed()
    const admin = await h.admin()
    const code = (await h.call('POST', `/admin/coaches/${coach.id}/bind-code`, undefined, admin))
      .json.code
    const token = (await h.call('POST', '/coach/bind', { code: 'dev:coach', bindCode: code })).json
      .token
    expect((await h.call('GET', '/coach/me', undefined, token)).status).toBe(200)
    const save = (active: boolean) =>
      h.call('PUT', `/admin/coaches/${coach.id}`, { name: coach.name, active }, admin)
    expect((await save(false)).status).toBe(200)
    expect(h.db.select().from(sessions).where(eq(sessions.coachId, coach.id)).all()).toEqual([])
    expect((await save(true)).status).toBe(200)
    expect((await h.call('GET', '/coach/me', undefined, token)).status).toBe(401)
    // The same WeChat signs in again as usual.
    expect((await h.call('POST', '/coach/login', { code: 'dev:coach' })).status).toBe(200)
  })

  it('keeps a coach signed in through other edits', async () => {
    const h = setup()
    const { coach } = h.seed()
    const admin = await h.admin()
    const code = (await h.call('POST', `/admin/coaches/${coach.id}/bind-code`, undefined, admin))
      .json.code
    const token = (await h.call('POST', '/coach/bind', { code: 'dev:coach', bindCode: code })).json
      .token
    await h.call('PUT', `/admin/coaches/${coach.id}`, { name: '王指导' }, admin)
    expect((await h.call('GET', '/coach/me', undefined, token)).status).toBe(200)
  })
})

describe('coach bind codes', () => {
  it('limits wrong codes per WeChat user', async () => {
    const h = setup()
    const { coach } = h.seed()
    const admin = await h.admin()
    const code = (await h.call('POST', `/admin/coaches/${coach.id}/bind-code`, undefined, admin))
      .json.code
    const bind = (wx: string, bindCode: string) =>
      h.call('POST', '/coach/bind', { code: `dev:${wx}`, bindCode })
    for (let i = 0; i < 10; i++) expect((await bind('guesser', 'AAAA2222')).status).toBe(400)
    expect((await bind('guesser', code)).status).toBe(429)
    // Another WeChat user is not held up, and a right code clears the count.
    expect((await bind('other', 'AAAA2222')).status).toBe(400)
    expect((await bind('coach', code)).status).toBe(200)
  })
})

describe('fake payments', () => {
  it('lets only the student who placed an order pay it', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const owner = await h.student('owner')
    const other = await h.student('other')
    const booked = await h.call(
      'POST',
      '/bookings',
      { slotId: h.slot(coach.id).id, lessonTypeId: lesson.id, payWith: 'wechat' },
      owner,
    )
    const orderId = booked.json.orderId as number
    const pay = (token?: string) => h.call('POST', `/dev/fake-pay/${orderId}`, undefined, token)
    const admin = await h.admin()
    expect((await pay()).status).toBe(401)
    expect((await pay(admin)).status).toBe(401)
    expect((await pay(other)).status).toBe(404)
    const status = () => h.db.select().from(orders).where(eq(orders.id, orderId)).get()?.status
    expect(status()).toBe('pending')
    expect((await pay(owner)).status).toBe(204)
    expect(status()).toBe('paid')
  })
})

describe('frames', () => {
  it('keeps the admin and the manual out of other sites’ frames', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rs-sites-'))
    for (const site of ['admin', 'help']) {
      mkdirSync(join(dir, site, 'assets'), { recursive: true })
      writeFileSync(join(dir, site, 'index.html'), '<!doctype html><title>x</title>')
      writeFileSync(join(dir, site, 'assets', 'a.js'), '')
    }
    writeFileSync(join(dir, 'help', '404.html'), '<!doctype html><title>404</title>')
    const root = new Hono()
    serveSites(root, { adminDir: join(dir, 'admin'), helpDir: join(dir, 'help') })
    for (const path of [
      '/admin',
      '/admin/',
      '/admin/bookings',
      '/admin/assets/a.js',
      '/admin/assets/gone.js',
      '/help',
      '/help/',
      '/help/assets/a.js',
      '/help/missing.html',
    ]) {
      const res = await root.request(path)
      expect([path, res.headers.get('X-Frame-Options')]).toEqual([path, 'DENY'])
      expect(res.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'none'")
    }
    expect((await root.request('/admin/bookings')).status).toBe(200)
    expect((await root.request('/help/missing.html')).status).toBe(404)
  })
})

describe('error logs', () => {
  // The SQLite driver reports a failed query by its error alone, without the query's values.
  it('keeps the values of a failed query out', async () => {
    const h = setup()
    const t = await h.student('a')
    h.db.$client.exec(
      "create trigger no_students before update on students begin select raise(abort, 'blocked'); end",
    )
    const res = await h.call('PUT', '/me', { name: '张三丰', phone: '13912345678' }, t)
    expect(res.status).toBe(500)
    expect(h.logs).toMatchObject([
      { message: 'unhandled error', detail: { path: '/api/me', error: /blocked/ } },
    ])
    const logged = JSON.stringify(h.logs)
    expect(logged).not.toContain('13912345678')
    expect(logged).not.toContain('张三丰')
  })
})
