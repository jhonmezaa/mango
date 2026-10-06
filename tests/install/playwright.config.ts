import { defineConfig, devices } from '@playwright/test';

import { loadConfig } from './src/config.ts';

/**
 * Journeys against a real installation (Cognito, CSP, cookies, AgentCore). The installation and
 * its test users come from a local file (`MANGO_INSTALL_CONFIG`); see README.md.
 *
 * Nothing Playwright records by itself is kept: a trace or a video holds the session cookie,
 * the tokens and the TOTP code as they were typed. On a failure the suite takes its own
 * screenshots, with addresses and ids masked, outside the repository.
 */
const config = loadConfig();

export default defineConfig({
  testDir: './specs',
  // One installation, a handful of test users and a TOTP window each: one worker, in order.
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  // A retry would sign in again and hide a flaky journey: a failure is reported as it is.
  retries: 0,
  reporter: [['./src/report.ts']],
  timeout: 120_000,
  expect: { timeout: 20_000 },
  outputDir: `${config.runDir}/playwright`,
  preserveOutput: 'never',
  use: {
    baseURL: config.baseUrl,
    locale: 'es-MX',
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
