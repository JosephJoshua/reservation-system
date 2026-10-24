// Opens every tab of the student mini program and the 外观 page following the system theme, then
// forced light and forced dark through the setting's storage key, and saves a screenshot of each.
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import automator from 'miniprogram-automator'
import { setTheme } from './theme'

const projectPath = fileURLToPath(new URL('../../../apps/miniprogram', import.meta.url))
const outDir = fileURLToPath(new URL('../screenshots', import.meta.url))
mkdirSync(outDir, { recursive: true })

const tabs = [
  { path: '/pages/booking/index', name: 'booking' },
  { path: '/pages/lessons/index', name: 'lessons' },
  { path: '/pages/profile/index', name: 'profile' },
]

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
  for (const theme of ['system', 'light', 'dark'] as const) {
    mkdirSync(`${outDir}/${theme}`, { recursive: true })
    await setTheme(miniProgram, theme === 'system' ? null : theme)
    await miniProgram.reLaunch('/pages/booking/index')
    for (const tab of tabs) {
      const page = await miniProgram.switchTab(tab.path)
      if (!page) throw new Error(`Could not open ${tab.path}`)
      await page.waitFor(500)
      if (page.path !== tab.path.slice(1)) throw new Error(`Expected ${tab.path}, got ${page.path}`)
      await miniProgram.screenshot({ path: `${outDir}/${theme}/${tab.name}.png` })
      console.log(`ok ${theme} ${tab.path}`)
    }
    const settings = await miniProgram.navigateTo('/pages/theme/index')
    if (!settings) throw new Error('Could not open /pages/theme/index')
    await settings.waitFor(500)
    if ((await settings.data('setting')) !== theme) throw new Error(`外观 does not show ${theme}`)
    await miniProgram.screenshot({ path: `${outDir}/${theme}/theme.png` })
    console.log(`ok ${theme} /pages/theme/index`)
  }
  if (errors.length > 0) throw new Error(`Runtime errors:\n${errors.join('\n')}`)
} finally {
  // Back to the default, following the system.
  try {
    await setTheme(miniProgram, null)
  } finally {
    await miniProgram.close()
  }
}
