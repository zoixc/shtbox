/// <reference lib="webworker" />
/**
 * Web Worker импорта: тяжёлая обработка (разбор GLB, упрощение, анализ) не блокирует интерфейс.
 * Держит упрощённые детали в памяти, чтобы пересчитывать разметку (ориентация, тип кузова…) мгновенно.
 */
import { analyze } from './analyze';
import type { AnalyzeHint } from './analyze';
import type { AvgColor } from './glb';
import { readModel } from './glb';
import { processModel } from './pipeline';
import type { Profile, RawPart } from './types';

export type WorkerReq =
  | { type: 'import'; id: number; data: ArrayBuffer; title: string; hint?: AnalyzeHint; preserveTextures?: boolean }
  | { type: 'load'; id: number; data: ArrayBuffer }
  | { type: 'analyze'; id: number; title: string; hint: AnalyzeHint };

export type WorkerRes =
  | { type: 'progress'; id: number; stage: string; frac: number }
  | { type: 'done'; id: number; glb?: Uint8Array; profile?: Profile; stats?: { srcTris: number; tris: number; parts: number; bytes: number }; warnings?: string[] }
  | { type: 'error'; id: number; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;
let parts: RawPart[] = [];

/** Средний цвет текстуры (sRGB 0..1): уменьшаем до 8×8 на OffscreenCanvas. */
const avgColor: AvgColor = async (bytes, mime) => {
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') return null;
  const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
  try {
    const c = new OffscreenCanvas(8, 8);
    const g = c.getContext('2d');
    if (!g) return null;
    g.drawImage(bmp, 0, 0, 8, 8);
    const d = g.getImageData(0, 0, 8, 8).data;
    let r = 0, gr = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 8) continue;
      r += d[i];
      gr += d[i + 1];
      b += d[i + 2];
      n++;
    }
    return n ? [r / n / 255, gr / n / 255, b / n / 255] : null;
  } finally {
    bmp.close();
  }
};

const post = (m: WorkerRes, transfer: Transferable[] = []) => ctx.postMessage(m, transfer);

ctx.onmessage = async (e: MessageEvent<WorkerReq>) => {
  const m = e.data;
  try {
    if (m.type === 'import') {
      const r = await processModel(new Uint8Array(m.data), {
        title: m.title,
        hint: m.hint,
        avgColor,
        preserveTextures: m.preserveTextures,
        onProgress: (stage, frac) => post({ type: 'progress', id: m.id, stage, frac }),
      });
      parts = r.parts;
      post({ type: 'done', id: m.id, glb: r.glb, profile: r.profile, stats: r.stats, warnings: r.warnings }, [r.glb.buffer as ArrayBuffer]);
    } else if (m.type === 'load') {
      const r = await readModel(new Uint8Array(m.data));
      parts = r.parts;
      post({ type: 'done', id: m.id });
    } else {
      if (!parts.length) throw new Error('Модель не загружена в обработчик');
      post({ type: 'done', id: m.id, profile: analyze(parts, m.title, m.hint) });
    }
  } catch (err) {
    post({ type: 'error', id: m.id, message: err instanceof Error ? err.message : String(err) });
  }
};
