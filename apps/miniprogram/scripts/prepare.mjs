// Prepares files the WeChat DevTools project needs but cannot resolve from a pnpm workspace:
// the TDesign component build, the shared package bundle, and the brand tokens.
// API_BASE_URL (default http://localhost:8787) is written to lib/env.js for the app to read.
// The gitignored project.private.config.json carries WX_APPID when set, so a different AppID
// (such as a sandbox test AppID) works without editing project.config.json, and turns off the
// domain check when the API is plain http, which only a local development server is.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const appDir = fileURLToPath(new URL('../miniprogram/', import.meta.url))
const libDir = join(appDir, 'lib')
const npmDir = join(appDir, 'miniprogram_npm')

rmSync(npmDir, { recursive: true, force: true })
rmSync(libDir, { recursive: true, force: true })
mkdirSync(libDir, { recursive: true })

const tdesignDist = join(
  dirname(require.resolve('tdesign-miniprogram/package.json')),
  'miniprogram_dist',
)
cpSync(tdesignDist, join(npmDir, 'tdesign-miniprogram'), { recursive: true })

cpSync(require.resolve('@rs/theme/brand.wxss'), join(libDir, 'brand.wxss'))

const sharedEntry = require.resolve('@rs/shared/client')
await build({
  entryPoints: [sharedEntry],
  outfile: join(libDir, 'shared.js'),
  bundle: true,
  format: 'cjs',
  platform: 'neutral',
  target: 'es2017',
  logLevel: 'warning',
})
const typesPath = relative(libDir, sharedEntry).replace(/\\/g, '/').replace(/\.ts$/, '')
writeFileSync(join(libDir, 'shared.d.ts'), `export * from '${typesPath}'\n`)

const apiBaseUrl = (process.env.API_BASE_URL?.trim() || 'http://localhost:8787').replace(/\/+$/, '')
writeFileSync(
  join(libDir, 'env.js'),
  `module.exports = { apiBaseUrl: ${JSON.stringify(apiBaseUrl)} }\n`,
)
writeFileSync(join(libDir, 'env.d.ts'), 'export declare const apiBaseUrl: string\n')

// DevTools keeps its own local settings in the same file, so merge into it.
const privateConfigPath = fileURLToPath(new URL('../project.private.config.json', import.meta.url))
const privateConfig = existsSync(privateConfigPath)
  ? JSON.parse(readFileSync(privateConfigPath, 'utf8'))
  : {}
const appid = process.env.WX_APPID?.trim()
if (appid) privateConfig.appid = appid
if (apiBaseUrl.startsWith('http://')) {
  privateConfig.setting = { ...privateConfig.setting, urlCheck: false }
}
if (Object.keys(privateConfig).length > 0) {
  writeFileSync(privateConfigPath, `${JSON.stringify(privateConfig, null, 2)}\n`)
}
