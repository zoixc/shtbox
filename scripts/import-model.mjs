/**
 * Подготовка собственной модели из командной строки (то же, что делает мастер в приложении):
 *   npm run import:model -- модель.glb пакет.glb [--title Имя] [--hint '{"layout":"rear","yaw":180}'] [--author …] [--license …]
 * Результат — «пакет» (.glb с разметкой в extras.shtbox): его можно загрузить в мастере или положить в public/models/ и
 * зарегистрировать в src/models/registry.ts (см. docs/ADDING_MODELS.md).
 */
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    absWorkingDir: root,
  });
  const r = spawnSync(process.execPath, [bundle, ...process.argv.slice(2)], { stdio: 'inherit', cwd: process.cwd() });
  process.exitCode = r.status ?? 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
