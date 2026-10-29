import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BACKUP_STALE_MS, backupAge, startBackupWatch } from './backup-watch'

const H = 3_600_000

describe('backupAge', () => {
  it('is null while the last backup is under 36 hours old', () => {
    expect(backupAge(0, 0, 35 * H)).toBeNull()
    expect(backupAge(0, 0, 37 * H)).toBe(37 * H)
  })

  it('counts from the app start before the first backup', () => {
    expect(backupAge(null, 10 * H, 40 * H)).toBeNull()
    expect(backupAge(null, 0, BACKUP_STALE_MS + 1)).toBe(BACKUP_STALE_MS + 1)
  })
})

describe('startBackupWatch', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  function watch(status = 200, reply = { errcode: 0, errmsg: 'ok' }) {
    const dir = mkdtempSync(join(tmpdir(), 'rs-backup-watch-'))
    dirs.push(dir)
    const markerPath = join(dir, 'backup-ok')
    let now = Date.parse('2026-10-29T00:00:00Z')
    const posts: string[] = []
    const logs: string[] = []
    const w = startBackupWatch(
      {
        markerPath,
        webhook: 'https://robot.example/hook',
        now: () => new Date(now),
        log: (m) => logs.push(m),
        post: async (_url, init) => {
          posts.push(JSON.parse(String(init?.body)).text.content)
          return new Response(JSON.stringify(reply), { status })
        },
      },
      1_000_000_000,
    )
    w.stop()
    const backedUp = (at: number) => {
      writeFileSync(markerPath, '')
      utimesSync(markerPath, at / 1000, at / 1000)
    }
    return {
      w,
      posts,
      logs,
      backedUp,
      at: () => now,
      later: (ms: number) => {
        now += ms
      },
    }
  }

  it('alerts when backups stop, once a day, and stops alerting when one succeeds', async () => {
    const t = watch()
    t.backedUp(t.at())
    t.later(35 * H)
    await t.w.check()
    expect(t.posts).toEqual([])

    t.later(2 * H)
    await t.w.check()
    expect(t.posts).toEqual(['球馆系统已 37 小时没有成功的备份，请检查备份容器'])
    t.later(H)
    await t.w.check()
    expect(t.posts).toHaveLength(1)
    expect(t.logs).toEqual(['backup stale', 'backup stale'])
    t.later(24 * H)
    await t.w.check()
    expect(t.posts).toHaveLength(2)

    t.backedUp(t.at())
    await t.w.check()
    t.later(37 * H)
    await t.w.check()
    expect(t.posts).toHaveLength(3)
  })

  it('alerts when no backup was ever made', async () => {
    const t = watch()
    t.later(37 * H)
    await t.w.check()
    expect(t.posts).toEqual(['球馆系统还没有成功的备份，应用已运行 37 小时，请检查备份容器'])
  })

  it('tries the robot again at the next check when it fails', async () => {
    const t = watch(500)
    t.later(37 * H)
    await t.w.check()
    t.later(H)
    await t.w.check()
    expect(t.posts).toHaveLength(2)
    expect(t.logs).toContain('backup alert failed')
  })

  it('counts a robot that answers 200 with an error code as failed', async () => {
    const t = watch(200, { errcode: 93000, errmsg: 'invalid webhook url' })
    t.later(37 * H)
    await t.w.check()
    t.later(H)
    await t.w.check()
    expect(t.posts).toHaveLength(2)
    expect(t.logs).toContain('backup alert failed')
  })
})
