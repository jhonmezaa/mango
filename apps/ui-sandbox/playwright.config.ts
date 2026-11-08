import { defineConfig, devices } from '@playwright/test';

/**
 * The runner in a real browser, without AWS: the second origin served as CloudFront would
 * (e2e/server.mjs, from the end-to-end build) and a host page with the SPA's utility, on another
 * site. Build first: `pnpm build && pnpm build:e2e`.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  use: { baseURL: 'http://localhost:4602' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node e2e/server.mjs',
      url: 'http://127.0.0.1:4601/runner-config.json',
      reuseExistingServer: false,
    },
    {
      command: 'vite --config e2e/vite.host.config.ts',
      url: 'http://localhost:4602/',
      reuseExistingServer: false,
    },
  ],
});
