/** CLI: GLB → пакет shtbox (.glb + разметка). Запуск: `npm run import:model -- in.glb out.glb [--title X] [--hint '{"layout":"rear"}'] [--author A --license L --source URL]` */
import { readFileSync, writeFileSync } from 'node:fs';
import { processModel } from './pipeline';
import type { AnalyzeHint } from './analyze';

const args = process.argv.slice(2);
const pos = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1] ?? '').startsWith('--'));
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
if (pos.length < 2) {
  console.error('Использование: npm run import:model -- <in.glb> <out.glb> [--title X] [--hint JSON] [--author A] [--license L] [--source URL] [--budget N]');
  process.exit(2);
}
const [src, out] = pos;
const hint = opt('hint') ? (JSON.parse(opt('hint')!) as AnalyzeHint) : undefined;
const credits = opt('author') || opt('license') || opt('source') ? { author: opt('author'), license: opt('license'), source: opt('source') } : undefined;
const t = Date.now();
const r = await processModel(new Uint8Array(readFileSync(src)), {
  title: opt('title') ?? src.replace(/^.*[\\/]/, '').replace(/\.glb$/i, ''),
  hint,
  credits,
  budget: opt('budget') ? Number(opt('budget')) : undefined,
});
writeFileSync(out, r.glb);
const p = r.profile;
console.log(`${out}: ${(r.stats.bytes / 1048576).toFixed(2)} МБ, ${r.stats.srcTris} → ${r.stats.tris} тр., деталей ${r.stats.parts}, ${Date.now() - t} мс`);
console.log(`кузов: ${p.body}, двигатель: ${p.layout}, руль: ${p.driver}, краска: ${p.paint.join(', ') || '—'}, размеры: ${p.dims.L.toFixed(2)}×${p.dims.W.toFixed(2)}×${p.dims.H.toFixed(2)} м`);
for (const w of r.warnings) console.warn('⚠', w);
