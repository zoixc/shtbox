/**
 * Подготовка собственной модели из командной строки (то же, что делает мастер в приложении):
 *   npm run import:model -- модель.glb пакет.glb [--title Имя] [--hint '{"layout":"rear","yaw":180}'] [--author …] [--license …]
 * Результат — «пакет» (.glb с разметкой в extras.shtbox): его можно загрузить в мастере или положить в public/models/ и
 * зарегистрировать в src/models/registry.ts (см. docs/ADDING_MODELS.md).
 */
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

/**
 * Basis Universal поставляется в three.js UMD-скриптом без ES-экспортов: Vite сам подставляет
 * CJS-совместимость, а esbuild в CLI — нет, поэтому добавляем `export default BASIS` на лету.
 */
const basisTranscoder = {
  name: 'shtbox-basis-transcoder',
  setup(build) {
    build.onResolve({ filter: /libs\/basis\/basis_transcoder\.js$/ }, (args) => ({ path: args.path, namespace: 'basis-module' }));
    build.onLoad({ filter: /.*/, namespace: 'basis-module' }, (args) => {
      const file = require.resolve(args.path);
      const source = readFileSync(file, 'utf8').replace(/\nif \(typeof exports === 'object'[\s\S]*$/, '');
      return { contents: `${source}\nexport default BASIS;\n`, loader: 'js', resolveDir: root };
    });
  },
};

/** Подменяет vite-импорты `?url`: esbuild должен отдать путь к ассету (wasm), а не собрать его. */
const urlAssets = {
  name: 'vite-url-assets',
  setup(build) {
    build.onResolve({ filter: /\?url$/ }, (args) => ({
      path: args.path.replace(/\?url$/, ''),
      namespace: 'url-asset',
    }));
    build.onLoad({ filter: /.*/, namespace: 'url-asset' }, (args) => ({
      contents: `export default ${JSON.stringify(pathToFileURL(require.resolve(args.path)).href)};`,
      loader: 'js',
    }));
  },
};
const dir = mkdtempSync(join(tmpdir(), 'shtbox-import-'));
const bundle = join(dir, 'cli.mjs');
try {
  await build({
    entryPoints: [join(root, 'src/import/cli.ts')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'error',
    // Обёртка emscripten внутри draco3dgltf в Node-режиме обращается к `require`, `__dirname` и
    // `__filename`; в ESM-бандле их нет, поэтому объявляем сами.
    banner: {
      js: [
        "import { createRequire as __cr } from 'node:module';",
        "import { fileURLToPath as __f } from 'node:url';",
        "import { dirname as __d } from 'node:path';",
        'const require = __cr(import.meta.url);',
        'const __filename = __f(import.meta.url);',
        'const __dirname = __d(__filename);',
      ].join(' '),
    },
    absWorkingDir: root,
    plugins: [basisTranscoder, urlAssets],
  });
  const r = spawnSync(process.execPath, [bundle, ...process.argv.slice(2)], { stdio: 'inherit', cwd: process.cwd() });
  process.exitCode = r.status ?? 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
