import { defineConfig, devices } from '@playwright/test'

const ci = !!process.env.CI

const admin = { ...devices['Desktop Chrome'], baseURL: 'http://localhost:5173/admin/' }

// Specs that save 设置 or 首页内容, or read rules another of them changes. They run one at a time.
const settingsSpecs =
  /admin\/(booking-rules|edit-pages|links|moves|qa-regressions|settings-sections|tables|venue-location)\.spec\.ts/

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  reporter: ci ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    // Chromium names a download "download" when the system locale cannot hold the file name, as
    // with the 发票-….csv exports on a machine whose LANG is unset.
    launchOptions: { env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' } },
  },
  projects: [
    {
      name: 'admin',
      testMatch: /admin\/.*\.spec\.ts/,
      testIgnore: settingsSpecs,
      use: admin,
    },
    {
      // A settings save carries the version it was loaded at, so two at once refuse each other.
      name: 'admin-settings',
      testMatch: settingsSpecs,
      workers: 1,
      use: admin,
    },
  ],
  webServer: [
    {
      // A fresh database each run, so specs that save settings find them as they expect.
      command: 'rm -f ../../apps/api/data/e2e.db* && pnpm --filter @rs/api start',
      url: 'http://localhost:8787/api/health',
      env: { DATABASE_PATH: 'data/e2e.db', PORT: '8787' },
      reuseExistingServer: !ci,
    },
    {
      command: 'pnpm --filter @rs/admin dev',
      url: 'http://localhost:5173/admin/',
      reuseExistingServer: !ci,
    },
  ],
})
