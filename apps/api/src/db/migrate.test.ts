import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { migrationsFolder, packageRoot } from './migrate'

const apiRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))

describe('migrationsFolder', () => {
  it('points at apps/api/drizzle', () => {
    expect(migrationsFolder).toBe(join(apiRoot, 'drizzle'))
  })

  it('resolves the same root from the bundled dist directory', () => {
    expect(packageRoot(join(apiRoot, 'dist'))).toBe(apiRoot)
  })
})
