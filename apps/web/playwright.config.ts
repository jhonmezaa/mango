import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests of the SPA against the local mock (`vite --mode mock`): the app runs its
 * real flows (SRP login, generated API client) and no AWS account is involved. The same flow
 * against a real installation is `tests/e2e/marketplace.py`.
 */
const PORT = Number(process.env.MANGO_E2E_PORT ?? 5273);

export default defineConfig({
  testDir: './e2e',
  // The mock keeps its state in the dev server's memory: one worker, in order.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${String(PORT)}`,
    locale: 'es-MX',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm exec vite --mode mock --port ${String(PORT)} --strictPort`,
    url: `http://localhost:${String(PORT)}`,
    // A server left running would carry the state of an earlier run.
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
