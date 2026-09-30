import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import preact from '@preact/preset-vite';
import { build as esbuild } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Жёсткая CSP только в production-сборке (dev-сервер Vite использует inline-скрипты для HMR). */
function csp(): Plugin {
  const policy = [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
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

/**
 * Basis Universal поставляется в three.js UMD-скриптом: в ESM-контексте он не экспортирует
 * транскодер (three объявлен как `"type": "module"`), поэтому модуль подменяется версией с
 * `export default BASIS`. Плагин работает и для сборки, и для worker-ов, и для vitest.
 */
function basisTranscoder(): Plugin {
  return {
    name: 'shtbox-basis-transcoder',
    enforce: 'pre',
    load(id) {
      if (!/\/libs\/basis\/basis_transcoder\.js$/.test(id)) return;
      // UMD-хвост (`module.exports = BASIS`) конфликтует с ESM-экспортом — отрезаем его.
      const source = readFileSync(id, 'utf8').replace(/\nif \(typeof exports === 'object'[\s\S]*$/, '');
      return { code: `${source}\nexport default BASIS;\n`, map: null };
    },
  };
}

/** Service worker пишется на TS (делит код расчёта ТО с приложением) и собирается esbuild в одиночный dist/sw.js без хэша. */
function serviceWorker(): Plugin {
  let root = process.cwd();
  let outDir = 'dist';
  return {
    name: 'shtbox-sw',
    apply: 'build',
    configResolved(c) {
      root = c.root;
      outDir = c.build.outDir;
    },
    async closeBundle() {
      await esbuild({
        entryPoints: [resolve(root, 'src/sw.ts')],
        outfile: resolve(root, outDir, 'sw.js'),
        bundle: true,
        minify: true,
        format: 'iife',
        target: 'es2020',
        legalComments: 'none',
      });
    },
  };
}

const bmwModelPath = resolve(process.cwd(), 'public/models/bmw116i.glb');
const bmwModelHash = createHash('sha256').update(readFileSync(bmwModelPath)).digest('hex');

export default defineConfig({
  define: { __BMW116I_MODEL_URL__: JSON.stringify(`/models/bmw116i.glb?v=${bmwModelHash}`) },
  plugins: [preact(), basisTranscoder(), csp(), serviceWorker()],
  // /sync → локальный сервер синхронизации (server/sync-server.mjs), как это делает nginx в Docker
  server: { host: '0.0.0.0', allowedHosts: true, proxy: { '/sync': 'http://127.0.0.1:8081' } },
  preview: { host: '0.0.0.0', allowedHosts: true, proxy: { '/sync': 'http://127.0.0.1:8081' } },
  build: { target: 'es2022', chunkSizeWarningLimit: 700 },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // UMD-обёртку Basis нужно пропустить через плагин, а не отдавать Node как ESM без экспортов.
    server: { deps: { inline: [/libs\/basis\/basis_transcoder\.js/] } },
  },
});
