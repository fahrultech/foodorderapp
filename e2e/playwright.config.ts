import { defineConfig } from '@playwright/test';

/**
 * Smoke suite contract:
 * - The seeded dev database is a prerequisite (see e2e/README.md); tests
 *   assert against known seed fixtures (Warung Nusantara, Seoul Street,
 *   demo@foodorder.app, the WARUNGHEMAT promo, FO-SEED* orders).
 * - `webServer` boots the API and the web app if they are not already
 *   running; when you already have them up (as during development) they are
 *   reused as-is. On a cold tree the web entry builds Next.js first, which
 *   can take a couple of minutes.
 * - Single worker on purpose: the suite shares one dev database and one
 *   rate-limit identity per IP (orders bucket: 30/min, auth: 10/min), and
 *   parallel order-creating tests would also race the localStorage-free
 *   guest flow assumptions. Keep it serial until each test gets its own DB.
 */
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.E2E_WEB_URL || 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  webServer: [
    {
      command: 'node dist/main.js',
      cwd: '../apps/api',
      url: 'http://localhost:4000/api/health',
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: 'npm run build && npm run start',
      cwd: '../apps/web',
      url: process.env.E2E_WEB_URL || 'http://localhost:3000',
      reuseExistingServer: true,
      timeout: 300_000,
    },
  ],
});
