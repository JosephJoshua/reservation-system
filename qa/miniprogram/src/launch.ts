import { execFileSync } from 'node:child_process'
import { utimesSync } from 'node:fs'
import { join } from 'node:path'
import automator from 'miniprogram-automator'

export type MiniProgram = Awaited<ReturnType<typeof automator.launch>>

const wsEndpoint = process.env.QA_WS_ENDPOINT
const recompileFirst = process.env.QA_RECOMPILE === '1'
const cliPath =
  process.env.WECHAT_DEVTOOLS_CLI ?? '/Applications/wechatwebdevtools.app/Contents/MacOS/cli'

/**
 * Recompiles the open project in place. Screenshots and downloads pile up in the simulator's file
 * storage until saveFile fails with "exceeded the maximum size", and DevTools only recounts it on
 * a compile. The simulator visibly restarts, so this runs only when QA_RECOMPILE=1.
 */
function recompile(projectPath: string) {
  const appJson = join(projectPath, 'miniprogram', 'app.json')
  const now = new Date()
  utimesSync(appJson, now, now)
  const port = new URL(wsEndpoint as string).port
  execFileSync(cliPath, ['auto', '--project', projectPath, '--auto-port', port], {
    stdio: 'ignore',
    timeout: 120_000,
  })
}

/**
 * Opens the mini program for a run. With QA_WS_ENDPOINT set (for example ws://127.0.0.1:9420)
 * this attaches to the DevTools instance already open there (recompiling it first with
 * QA_RECOMPILE=1), clears its storage and relaunches the first page, so every run reuses one simulator instead of opening a new window.
 */
export async function openMiniProgram(projectPath: string): Promise<MiniProgram> {
  if (!wsEndpoint) {
    return automator.launch({
      projectPath,
      ...(process.env.WECHAT_DEVTOOLS_CLI ? { cliPath: process.env.WECHAT_DEVTOOLS_CLI } : {}),
    })
  }
  if (recompileFirst) recompile(projectPath)
  // Right after a compile the automation server may not be listening yet, and the app may have no
  // page, so the first calls fail on a refused connection or missing page meta. A busy Mac can
  // stall DevTools for over a minute, so retry for up to 90 s.
  for (let attempt = 1; ; attempt++) {
    let miniProgram: MiniProgram | undefined
    try {
      miniProgram = await automator.connect({ wsEndpoint })
      await miniProgram.callWxMethod('clearStorageSync')
      await miniProgram.reLaunch('/pages/booking/index')
      return miniProgram
    } catch (err) {
      await miniProgram?.disconnect().catch(() => {})
      if (attempt >= 60) throw err
      console.log(`simulator not ready (${(err as Error).message}), retrying`)
      await new Promise((resolve) => setTimeout(resolve, 1500))
    }
  }
}

/** Ends a run, leaving an attached simulator open for the next one. */
export async function closeMiniProgram(miniProgram: MiniProgram) {
  if (wsEndpoint) await miniProgram.disconnect()
  else await miniProgram.close()
}
