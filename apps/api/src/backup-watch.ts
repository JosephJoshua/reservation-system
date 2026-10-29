import { statSync } from 'node:fs'

/**
 * A nightly backup that has not succeeded for this long has stopped. A day and a half, so a run
 * that takes hours longer than usual (the first encrypted one uploads every image again) is not
 * reported.
 */
export const BACKUP_STALE_MS = 36 * 3_600_000
const CHECK_MS = 3_600_000
// While backups stay stopped the alert repeats once a day.
const REPEAT_MS = 24 * 3_600_000

export interface BackupWatch {
  /** deploy/backup/backup.sh touches it after each successful backup. */
  markerPath: string
  /** WeCom group robot, the one backup.sh alerts on failures. */
  webhook: string
  now: () => Date
  log: (message: string, detail?: unknown) => void
  post?: typeof fetch
}

function markerTime(path: string): number | null {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

/**
 * How long since the last successful backup, or null while it is recent. Before the first
 * backup the app's start counts, so a new server has a day to make one.
 */
export function backupAge(marker: number | null, startedAt: number, now: number): number | null {
  const age = now - (marker ?? startedAt)
  return age > BACKUP_STALE_MS ? age : null
}

/**
 * Checks once an hour that backups still succeed, as the backup container cannot report its own
 * absence. Logs every stale check and posts to the robot once a day while they stay stale.
 */
export function startBackupWatch(w: BackupWatch, intervalMs = CHECK_MS) {
  const startedAt = w.now().getTime()
  let alertedAt: number | null = null
  const check = async () => {
    const now = w.now().getTime()
    const marker = markerTime(w.markerPath)
    const age = backupAge(marker, startedAt, now)
    if (age === null) {
      alertedAt = null
      return
    }
    const hours = Math.floor(age / 3_600_000)
    const text =
      marker === null
        ? `球馆系统还没有成功的备份，应用已运行 ${hours} 小时，请检查备份容器`
        : `球馆系统已 ${hours} 小时没有成功的备份，请检查备份容器`
    w.log('backup stale', { hours, marker: w.markerPath })
    if (alertedAt !== null && now - alertedAt < REPEAT_MS) return
    alertedAt = now
    try {
      const res = await (w.post ?? fetch)(w.webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'text', text: { content: text } }),
      })
      // The robot answers 200 with a non-zero errcode for a wrong key or too many messages.
      const body = (await res.json().catch(() => ({}))) as { errcode?: number; errmsg?: string }
      if (!res.ok || (body.errcode ?? 0) !== 0) {
        throw new Error(`HTTP ${res.status} errcode ${body.errcode} ${body.errmsg ?? ''}`)
      }
    } catch (e) {
      // Tried again at the next check.
      alertedAt = null
      w.log('backup alert failed', (e as Error).message)
    }
  }
  const timer = setInterval(() => {
    check().catch((e) => w.log('backup check failed', (e as Error).message))
  }, intervalMs)
  timer.unref()
  return { check, stop: () => clearInterval(timer) }
}
