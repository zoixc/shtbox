/**
 * CLI: модель → пакет shtbox (.glb + разметка). Тот же код, что и в браузере (`pipeline.ts`), поэтому
 * результат и отчёт совпадают с мастером импорта.
 *
 * Один файл:
 *   npm run import:model -- model.glb out.glb [--title X] [--hint '{"layout":"rear"}']
 *     [--author A --license L --source URL] [--budget N] [--keep-textures] [--preset] [--dry]
 * Партия (пункт 10 дорожной карты P1) — каталог или несколько файлов:
 *   npm run import:model -- ./models ./out
 *   → для каждой модели пишется `<имя>.glb` и `<имя>.preset.json` (разметка без геометрии),
 *     в конце — сводка: сколько моделей, суммарный объём и треугольники.
 *
 * Для `.gltf` рядом читаются все файлы каталога (`.bin` и текстуры) — как при выборе файлов в мастере.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { processModel } from './pipeline';
import { makePreset, presetToJson } from './presets';
import { buildReport, formatReportLines } from './report';
import { filesToGlb, type SourceFile } from './sources';
import type { AnalyzeHint } from './analyze';

const USAGE = [
  'Использование:',
  '  npm run import:model -- <in.glb|in.gltf|in.zip|каталог> <out.glb|каталог> [опции]',
  'Опции:',
  '  --title X        название модели (по умолчанию — имя файла)',
  '  --hint JSON      подсказки анализа, например {"layout":"rear","body":"hatch"}',
  '  --author A --license L --source URL   атрибуция из исходного файла',
  '  --budget N       бюджет треугольников (по умолчанию 130000)',
  '  --quality Q      качество JPEG для сохранённых текстур (браузерный мастер; в CLI не используется)',
  '  --keep-textures  сохранять встроенные текстуры цвета',
  '  --preset         рядом с пакетом писать пресет разметки <имя>.preset.json',
  '  --dry            только разобрать и показать отчёт, ничего не писать',
].join('\n');

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(['title', 'hint', 'author', 'license', 'source', 'budget', 'quality', 'out']);
const BOOL_FLAGS = new Set(['keep-textures', 'preset', 'dry']);

const flags = new Map<string, string | true>();
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg.startsWith('-')) {
    const name = arg.replace(/^--?/, '');
    if (!VALUE_FLAGS.has(name) && !BOOL_FLAGS.has(name)) {
      console.error(`Неизвестный ключ «${arg}».\n\n${USAGE}`);
      process.exit(2);
    }
    if (BOOL_FLAGS.has(name)) flags.set(name, true);
    else {
      const value = args[++i];
      if (value === undefined || value.startsWith('--')) {
        console.error(`Ключ «${arg}» требует значение.\n\n${USAGE}`);
        process.exit(2);
      }
      flags.set(name, value);
    }
    continue;
  }
  positional.push(arg);
}
const opt = (name: string): string | undefined => {
  const value = flags.get(name);
  return typeof value === 'string' ? value : undefined;
};
const has = (name: string): boolean => flags.get(name) === true;

if (positional.length < 2) {
  console.error(USAGE);
  process.exit(2);
}
const [src, dest] = positional;
const hint = opt('hint') ? (JSON.parse(opt('hint')!) as AnalyzeHint) : undefined;
const credits = opt('author') || opt('license') || opt('source')
  ? { author: opt('author'), license: opt('license'), source: opt('source') }
  : undefined;
const budget = opt('budget') ? Number(opt('budget')) : undefined;
const keepTextures = has('keep-textures');
const dry = has('dry');

/** Читает вход: одиночный файл или весь каталог рядом с `.gltf` (как выбор файлов в мастере). */
function readSources(path: string): SourceFile[] {
  const name = basename(path);
  if (!/\.gltf$/i.test(name)) return [{ name, bytes: new Uint8Array(readFileSync(path)) }];
  const dir = dirname(path);
  const files: SourceFile[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    try {
      if (!statSync(full).isFile()) continue;
      files.push({ name: entry, bytes: new Uint8Array(readFileSync(full)) });
    } catch {
      // нечитаемый файл пропускаем: конвертер сам скажет, какого ресурса не хватает
    }
  }
  return files;
}

interface Job {
  path: string;
  /** Куда писать пакет (`null` — только отчёт). */
  out: string | null;
  preset: string | null;
}

/** Собирает список задач: один файл или партия (каталог / несколько файлов). */
function plan(input: string, output: string): Job[] {
  const inputIsDir = existsSync(input) && statSync(input).isDirectory();
  // выход — каталог, если это каталог на входе или уже существующий каталог
  const outIsDir = inputIsDir || (existsSync(output) && statSync(output).isDirectory());
  const presetFor = (target: string): string | null =>
    has('preset') || outIsDir ? target.replace(/\.glb$/i, '') + '.preset.json' : null;

  const single = (path: string, target: string): Job => {
    // не затираем исходник, если каталог вывода совпал с каталогом входа
    const safe = target === path ? target.replace(/\.glb$/i, '.shtcar.glb') : target;
    return { path, out: dry ? null : safe, preset: dry ? null : presetFor(safe) };
  };

  if (inputIsDir) {
    if (!dry && !existsSync(output)) mkdirSync(output, { recursive: true });
    const models = readdirSync(input)
      .filter((name) => /\.(glb|gltf|zip)$/i.test(name))
      .sort();
    if (!models.length) {
      console.error(`В каталоге ${input} нет файлов .glb/.gltf/.zip`);
      process.exit(1);
    }
    return models.map((name) => single(join(input, name), join(output, `${name.replace(/\.(glb|gltf|zip)$/i, '')}.glb`)));
  }
  return [single(input, outIsDir ? join(output, `${basename(input).replace(/\.(glb|gltf|zip)$/i, '')}.glb`) : output)];
}

const jobs = plan(src, dest);
let failed = 0;
let totalBytes = 0;
let totalTris = 0;
const started = Date.now();

for (const job of jobs) {
  const label = basename(job.path);
  try {
    const converted = filesToGlb(readSources(job.path));
    for (const warning of converted.warnings) console.warn('⚠', warning);
    const r = await processModel(converted.glb, {
      title: opt('title') ?? converted.name ?? label.replace(/\.(glb|gltf|zip)$/i, ''),
      hint,
      credits,
      budget,
      preserveTextures: keepTextures,
    });
    if (job.out) writeFileSync(job.out, r.glb);
    if (job.preset && job.out) writeFileSync(job.preset, presetToJson(makePreset(r.profile, opt('title') ?? r.profile.title)));
    totalBytes += r.stats.bytes;
    totalTris += r.stats.tris;
    const p = r.profile;
    console.log(`\n=== ${label}${job.out ? ` → ${job.out}` : ' (только отчёт)'}`);
    console.log(`${(r.stats.bytes / 1048576).toFixed(2)} МБ, ${r.stats.srcTris} → ${r.stats.tris} тр., деталей ${r.stats.parts}`);
    console.log(`кузов: ${p.body}, двигатель: ${p.layout}, руль: ${p.driver}, краска: ${p.paint.join(', ') || '—'}, размеры: ${p.dims.L.toFixed(2)}×${p.dims.W.toFixed(2)}×${p.dims.H.toFixed(2)} м`);
    for (const line of formatReportLines(buildReport(r.stats, p, r.warnings))) console.log(line);
    for (const w of r.warnings) console.warn('⚠', w);
  } catch (error) {
    failed++;
    console.error(`✖ ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (jobs.length > 1 || dry) {
  console.log(
    `\nИтого: моделей ${jobs.length - failed}${failed ? ` (ошибок ${failed})` : ''}, ` +
      `${(totalBytes / 1048576).toFixed(2)} МБ, ${totalTris.toLocaleString('ru')} тр., ${Date.now() - started} мс` +
      `${dry ? ' — режим --dry, файлы не записаны' : ''}`,
  );
}
if (failed) process.exit(1);
