import type { Deps } from './deps'
import { expireOrders } from './services/orders'
import { sweepRefunds } from './services/refunds'

/** Closes expired orders and pushes refunds along. Runs every 30 seconds. */
export async function sweep(deps: Deps) {
  await expireOrders(deps)
  await sweepRefunds(deps)
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
