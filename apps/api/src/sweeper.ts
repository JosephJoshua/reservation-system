import type { Deps } from './deps'
import { expireIdempotencyKeys } from './idempotency'
import { notifyCoaches } from './services/coach-notices'
import { removeStrayPhotos } from './services/feedback'
import { expireOrders } from './services/orders'
import { notifyPackages } from './services/package-notices'
import { sweepRefunds } from './services/refunds'
import { cancelUnderfilledSessions, finishCancelledSessions } from './services/sessions'
import { notifyStudents } from './services/student-notices'

const HOURLY_MS = 3_600_000
const lastRun = new Map<string, number>()

/** Runs `chore` when an hour has passed since it last ran here. */
function hourly(deps: Deps, name: string, chore: () => void) {
  const now = deps.now().getTime()
  if (Math.abs(now - (lastRun.get(name) ?? 0)) < HOURLY_MS) return
  lastRun.set(name, now)
  chore()
}

/**
 * Closes expired orders, pushes refunds along, calls off group sessions short of students,
 * tells coaches and students about lessons and students about packages running out. Runs
 * every 30 seconds; unused lesson photos are removed once an hour.
 */
export async function sweep(deps: Deps) {
  try {
    hourly(deps, 'photos', () => removeStrayPhotos(deps))
  } catch (e) {
    deps.log('photo sweep failed', (e as Error).message)
  }
  // Coach chores run on their own, so a failure in payments does not stop them, or the reverse.
  try {
    await notifyCoaches(deps)
  } catch (e) {
    deps.log('coach sweep failed', (e as Error).message)
  }
  try {
    await cancelUnderfilledSessions(deps)
    await finishCancelledSessions(deps)
  } catch (e) {
    deps.log('session sweep failed', (e as Error).message)
  }
  try {
    await expireOrders(deps)
    await sweepRefunds(deps)
  } finally {
    try {
      expireIdempotencyKeys(deps)
    } catch (e) {
      deps.log('idempotency sweep failed', (e as Error).message)
    }
    // Last, so slow WeChat sends never hold up payments, but also when payments fail.
    try {
      await notifyStudents(deps)
    } catch (e) {
      deps.log('student notices failed', (e as Error).message)
    }
    try {
      await notifyPackages(deps)
    } catch (e) {
      deps.log('package notices failed', (e as Error).message)
    }
  }
}

/** Starts sweeping; the returned stop function resolves once a sweep in progress has finished. */
export function startSweeper(deps: Deps, intervalMs = 30_000) {
  let running: Promise<void> | null = null
  const timer = setInterval(() => {
    if (running) return
    running = sweep(deps)
      .catch((e) => deps.log('sweep failed', (e as Error).message))
      .finally(() => {
        running = null
      })
  }, intervalMs)
  timer.unref()
  return async () => {
    clearInterval(timer)
    await running
  }
}
