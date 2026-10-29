import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// The app imports the shared package and its settings from lib/, which the build writes; the tests
// read them from source instead, so they run without a build.
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^(\.\.\/)+lib\/shared$/,
        replacement: fileURLToPath(new URL('../../packages/shared/src/client.ts', import.meta.url)),
      },
      {
        find: /^(\.\.\/)+lib\/env$/,
        replacement: fileURLToPath(new URL('./test/env.ts', import.meta.url)),
      },
    ],
  },
  test: { include: ['test/**/*.test.ts'] },
})
