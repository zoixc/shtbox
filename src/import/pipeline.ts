import { analyze } from './analyze';
import type { AnalyzeHint } from './analyze';
import { splitGlb } from './container';
import { readModel, writePackage } from './glb';
import type { AvgColor } from './glb';
import { simplifyParts, triCount } from './simplify';
import { optimizeTextures } from './texture-optimize';
import type { TextureEncoder, TextureStats } from './texture-optimize';
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
  preserveTextures?: boolean;
  /** Свой кодировщик текстур (тесты; по умолчанию — браузерный OffscreenCanvas). */
  textureEncoder?: TextureEncoder | null;
  onProgress?: (stage: string, frac: number) => void;
}

export interface ImportResult {
  glb: Uint8Array;
  profile: Profile;
  warnings: string[];
  /** упрощённые детали (для повторного анализа без перечитывания файла) */
  parts: RawPart[];
  stats: { srcTris: number; tris: number; parts: number; bytes: number; textures?: TextureStats };
}

const mib = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(2)} МБ`;

/** Полный путь «чужой GLB → пакет модели» (GLB + профиль). */
export async function processModel(data: Uint8Array, o: ImportOptions): Promise<ImportResult> {
  let lastStage = '';
  let lastFrac = -1;
  let lastAt = 0;
  const prog = (stage: string, frac: number) => {
    if (!o.onProgress) return;
    const now = Date.now();
    if (stage !== lastStage || frac >= 1 || frac - lastFrac >= 0.01 || now - lastAt >= 100) {
      lastStage = stage;
      lastFrac = frac;
      lastAt = now;
      o.onProgress(stage, Math.max(0, Math.min(1, frac)));
    }
  };
  prog('Чтение файла', 0);
  const read = await readModel(data, o.avgColor, {
    preserveTextures: o.preserveTextures,
    onProgress: (stage, frac) => prog(stage, 0.02 + 0.2 * frac),
  });
  const { parts, tris: srcTris } = read;
  const warnings = [...read.warnings];
  prog('Анализ', 0.24);
  const first = analyze(parts, o.title, o.hint);
  const live = parts.filter((p) => first.parts[p.id].k !== 'hide');
  const simplified = await simplifyParts(live, o.budget ?? DEFAULT_BUDGET, (stage, frac) => prog(stage, 0.28 + 0.52 * frac));
  warnings.push(...simplified.warnings);
  const simp: RawPart[] = simplified.parts;
  prog('Разметка', 0.82);
  const profile = analyze(simp, o.title, o.hint);
  const credits = o.credits ?? read.credits;
  if (credits) profile.credits = credits;
  prog('Текстуры', 0.9);
  const textures = o.preserveTextures ? await optimizeTextures(simp, { encoder: o.textureEncoder }) : null;
  if (textures?.converted) {
    warnings.push(
      `Текстуры цвета перекодированы (JPEG): ${mib(textures.before)} → ${mib(textures.after)}, ${textures.converted} шт.`,
    );
  }
  prog('Упаковка', 0.94);
  const glb = await writePackage(simp, profile);
  prog('Готово', 1);
  return {
    glb,
    profile,
    warnings: [...new Set(warnings)],
    parts: simp,
    stats: { srcTris, tris: triCount(simp), parts: simp.length, bytes: glb.byteLength, ...(textures?.converted ? { textures } : {}) },
  };
}
