import { analyze } from './analyze';
import type { AnalyzeHint } from './analyze';
import { splitGlb } from './container';
import { readModel, writePackage } from './glb';
import type { AvgColor } from './glb';
import { simplifyParts, triCount } from './simplify';
import type { Profile, RawPart } from './types';

/** Автор/лицензия из метаданных исходного файла (Sketchfab кладёт их в asset.extras). */
export function guessCredits(data: Uint8Array): Profile['credits'] | undefined {
  try {
    const a = (splitGlb(data).json.asset ?? {}) as { copyright?: string; extras?: Record<string, unknown> };
    const e = a.extras ?? {};
    const s = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 300) : undefined);
    const credits = { author: s(e.author) ?? s(a.copyright), license: s(e.license), source: s(e.source) };
    return credits.author || credits.license || credits.source ? credits : undefined;
  } catch {
    return undefined;
  }
}

export const DEFAULT_BUDGET = 130_000;

export interface ImportOptions {
  title: string;
  credits?: Profile['credits'];
  budget?: number;
  avgColor?: AvgColor;
  hint?: AnalyzeHint;
  onProgress?: (stage: string, frac: number) => void;
}

export interface ImportResult {
  glb: Uint8Array;
  profile: Profile;
  warnings: string[];
  /** упрощённые детали (для повторного анализа без перечитывания файла) */
  parts: RawPart[];
  stats: { srcTris: number; tris: number; parts: number; bytes: number };
}

/** Полный путь «чужой GLB → пакет модели» (GLB + профиль). */
export async function processModel(data: Uint8Array, o: ImportOptions): Promise<ImportResult> {
  const prog = o.onProgress ?? (() => {});
  prog('Чтение файла', 0);
  const { parts, tris: srcTris, warnings } = await readModel(data, o.avgColor);
  prog('Анализ', 0.25);
  const first = analyze(parts, o.title, o.hint);
  const live = parts.filter((p) => first.parts[p.id].k !== 'hide');
  prog('Упрощение', 0.35);
  const simp: RawPart[] = await simplifyParts(live, o.budget ?? DEFAULT_BUDGET, (d, t) => prog('Упрощение', 0.35 + 0.45 * (d / t)));
  prog('Разметка', 0.85);
  const profile = analyze(simp, o.title, o.hint);
  const credits = o.credits ?? guessCredits(data);
  if (credits) profile.credits = credits;
  prog('Упаковка', 0.92);
  const glb = await writePackage(simp, profile);
  prog('Готово', 1);
  return { glb, profile, warnings, parts: simp, stats: { srcTris, tris: triCount(simp), parts: simp.length, bytes: glb.byteLength } };
}
