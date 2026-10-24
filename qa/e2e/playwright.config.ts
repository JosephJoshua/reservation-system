import { defineConfig, devices } from '@playwright/test'

const ci = !!process.env.CI

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
      use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:5173/admin/' },
    },
  ],
  webServer: [
    {
      command: 'pnpm --filter @rs/api start',
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
