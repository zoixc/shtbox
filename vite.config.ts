import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import preact from '@preact/preset-vite';

/** Жёсткая CSP только в production-сборке (dev-сервер Vite использует inline-скрипты для HMR). */
function csp(): Plugin {
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  return {
    name: 'shtbox-csp',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace('<!--CSP-->', `<meta http-equiv="Content-Security-Policy" content="${policy}" />`),
  };
}

export default defineConfig({
  plugins: [preact(), csp()],
  // /sync → локальный сервер синхронизации (server/sync-server.mjs), как это делает nginx в Docker
  server: { host: '0.0.0.0', allowedHosts: true, proxy: { '/sync': 'http://127.0.0.1:8081' } },
  preview: { host: '0.0.0.0', allowedHosts: true, proxy: { '/sync': 'http://127.0.0.1:8081' } },
  build: { target: 'es2022', chunkSizeWarningLimit: 700 },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
