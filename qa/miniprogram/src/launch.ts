import automator from 'miniprogram-automator'

export type MiniProgram = Awaited<ReturnType<typeof automator.launch>>

const wsEndpoint = process.env.QA_WS_ENDPOINT

/**
 * Opens the mini program for a run. With QA_WS_ENDPOINT set (for example ws://127.0.0.1:9420)
 * this attaches to the DevTools instance already open there, clears its storage and relaunches
 * the first page, so every run reuses one simulator instead of opening a new window.
 */
export async function openMiniProgram(projectPath: string): Promise<MiniProgram> {
  if (!wsEndpoint) {
    return automator.launch({
      projectPath,
      ...(process.env.WECHAT_DEVTOOLS_CLI ? { cliPath: process.env.WECHAT_DEVTOOLS_CLI } : {}),
    })
  }
  const miniProgram = await automator.connect({ wsEndpoint })
  await miniProgram.callWxMethod('clearStorageSync')
  await miniProgram.reLaunch('/pages/booking/index')
  return miniProgram
}

/** Ends a run, leaving an attached simulator open for the next one. */
export async function closeMiniProgram(miniProgram: MiniProgram) {
  if (wsEndpoint) await miniProgram.disconnect()
  else await miniProgram.close()
}
