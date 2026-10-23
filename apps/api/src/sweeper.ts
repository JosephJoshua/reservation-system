import type { Deps } from './deps'
import { notifyCoaches } from './services/coach-notices'
import { syncAllSlots } from './services/coaches'
import { expireOrders } from './services/orders'
import { sweepRefunds } from './services/refunds'

const SLOT_SYNC_MS = 3_600_000
let lastSlotSync = 0

/**
 * Closes expired orders, pushes refunds along and tells coaches about their lessons. Runs every
 * 30 seconds; slots from coaches' weekly hours roll forward once an hour.
 */
export async function sweep(deps: Deps) {
  await expireOrders(deps)
  await sweepRefunds(deps)
  await notifyCoaches(deps)
  const now = deps.now().getTime()
  if (Math.abs(now - lastSlotSync) >= SLOT_SYNC_MS) {
    lastSlotSync = now
    syncAllSlots(deps)
  }
}

export function startSweeper(deps: Deps, intervalMs = 30_000) {
  let running = false
  const timer = setInterval(async () => {
    if (running) return
    running = true
    try {
      await sweep(deps)
    } catch (e) {
      deps.log('sweep failed', (e as Error).message)
    } finally {
      running = false
    }
  }, intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}
