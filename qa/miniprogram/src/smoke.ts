// Opens every tab of the student mini program and saves a screenshot of each.
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import automator from 'miniprogram-automator'

const projectPath = fileURLToPath(new URL('../../../apps/miniprogram', import.meta.url))
const outDir = fileURLToPath(new URL('../screenshots', import.meta.url))
mkdirSync(outDir, { recursive: true })

const tabs = [
  { path: '/pages/booking/index', name: 'booking' },
  { path: '/pages/lessons/index', name: 'lessons' },
  { path: '/pages/profile/index', name: 'profile' },
]

if (!process.env.WX_APPID) {
  throw new Error('Set WX_APPID to a mini program AppID or a test AppID from the WeChat sandbox')
}

const miniProgram = await automator.launch({
  projectPath,
  ...(process.env.WECHAT_DEVTOOLS_CLI ? { cliPath: process.env.WECHAT_DEVTOOLS_CLI } : {}),
})

const errors: string[] = []
miniProgram.on('exception', (err: { message: string }) => errors.push(err.message))
miniProgram.on('console', (msg: { type: string; args: unknown[] }) => {
  if (msg.type === 'error') errors.push(msg.args.map(String).join(' '))
})

try {
  for (const tab of tabs) {
    const page = await miniProgram.switchTab(tab.path)
    if (!page) throw new Error(`Could not open ${tab.path}`)
    await page.waitFor(500)
    if (page.path !== tab.path.slice(1)) throw new Error(`Expected ${tab.path}, got ${page.path}`)
    await miniProgram.screenshot({ path: `${outDir}/${tab.name}.png` })
    console.log(`ok ${tab.path}`)
  }
  if (errors.length > 0) throw new Error(`Runtime errors:\n${errors.join('\n')}`)
} finally {
  await miniProgram.close()
}
