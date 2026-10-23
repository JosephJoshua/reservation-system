import type { Deps } from './deps'
import { expireIdempotencyKeys } from './idempotency'
import { notifyCoaches } from './services/coach-notices'
import { syncAllSlots } from './services/coaches'
import { expireOrders } from './services/orders'
import { sweepRefunds } from './services/refunds'
import { notifyStudents } from './services/student-notices'

const SLOT_SYNC_MS = 3_600_000
let lastSlotSync = 0

/**
 * Closes expired orders, pushes refunds along and tells coaches and students about lessons. Runs
 * every 30 seconds; slots from coaches' weekly hours roll forward once an hour.
 */
export async function sweep(deps: Deps) {
  // Coach chores run on their own, so a failure in payments does not stop them, or the reverse.
  try {
    const now = deps.now().getTime()
    if (Math.abs(now - lastSlotSync) >= SLOT_SYNC_MS) {
      lastSlotSync = now
      syncAllSlots(deps)
    }
    await notifyCoaches(deps)
  } catch (e) {
    deps.log('coach sweep failed', (e as Error).message)
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
