import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 4173;
const SYNC_PORT = 8081;
const dataDir = mkdtempSync(join(tmpdir(), 'shtbox-sync-'));

/**
 * E2E на собранной prod-версии (строгий CSP, service worker) + локальный сервер синхронизации.
 * WebGL — программный (SwiftShader), поэтому тесты неторопливые. Свой Chromium: PW_CHROMIUM=/path/to/chrome.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1100, height: 700 },
    locale: 'ru-RU',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      executablePath: process.env.PW_CHROMIUM || undefined,
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--ignore-gpu-blocklist',
        ...(process.env.PW_CHROMIUM_ARGS ? process.env.PW_CHROMIUM_ARGS.split(' ') : []),
      ],
    },
  },
  webServer: [
    {
      command: `npm run build && npx vite preview --port ${PORT} --strictPort --host 127.0.0.1`,
      url: `http://127.0.0.1:${PORT}/`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
    {
      command: 'node server/sync-server.mjs',
      env: { PORT: String(SYNC_PORT), DATA_DIR: dataDir },
      url: `http://127.0.0.1:${SYNC_PORT}/healthz`,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
