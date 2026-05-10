import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.FRONTEND_BASE_URL || 'http://127.0.0.1:8000';

export default defineConfig({
  testDir: '.',
  testMatch: ['*.spec.ts'],
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  fullyParallel: true,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
