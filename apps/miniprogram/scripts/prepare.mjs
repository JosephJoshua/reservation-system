// Prepares files the WeChat DevTools project needs but cannot resolve from a pnpm workspace:
// the TDesign component build, the shared package bundle, and the brand tokens.
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
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

const sharedEntry = require.resolve('@rs/shared')
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
