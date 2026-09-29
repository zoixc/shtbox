/** Сварка вершин и упрощение сеток (meshoptimizer, wasm). Без DOM. */
import { MeshoptSimplifier } from 'meshoptimizer';
import type { RawPart } from './types';

/** Сваривает вершины с одинаковыми позицией и нормалью, выбрасывает вырожденные треугольники. */
export function weld(p: RawPart): RawPart {
  const n = p.pos.length / 3;
  const map = new Map<string, number>();
  const remap = new Uint32Array(n);
  const pos: number[] = [];
  const nor: number[] = [];
  for (let v = 0; v < n; v++) {
    const key = `${Math.round(p.pos[v * 3] * 1e5)},${Math.round(p.pos[v * 3 + 1] * 1e5)},${Math.round(p.pos[v * 3 + 2] * 1e5)},${Math.round(p.nor[v * 3] * 50)},${Math.round(p.nor[v * 3 + 1] * 50)},${Math.round(p.nor[v * 3 + 2] * 50)}`;
    let id = map.get(key);
    if (id === undefined) {
      id = pos.length / 3;
      map.set(key, id);
      pos.push(p.pos[v * 3], p.pos[v * 3 + 1], p.pos[v * 3 + 2]);
      nor.push(p.nor[v * 3], p.nor[v * 3 + 1], p.nor[v * 3 + 2]);
    }
    remap[v] = id;
  }
  const idx: number[] = [];
  for (let t = 0; t < p.idx.length; t += 3) {
    const a = remap[p.idx[t]], b = remap[p.idx[t + 1]], c = remap[p.idx[t + 2]];
    if (a !== b && b !== c && a !== c) idx.push(a, b, c);
  }
  return { ...p, pos: Float32Array.from(pos), nor: Float32Array.from(nor), idx: Uint32Array.from(idx) };
}

function compact(p: RawPart, indices: Uint32Array): RawPart {
  const map = new Map<number, number>();
  const pos: number[] = [];
  const nor: number[] = [];
  const idx = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i];
    let id = map.get(v);
    if (id === undefined) {
      id = pos.length / 3;
      map.set(v, id);
      pos.push(p.pos[v * 3], p.pos[v * 3 + 1], p.pos[v * 3 + 2]);
      nor.push(p.nor[v * 3], p.nor[v * 3 + 1], p.nor[v * 3 + 2]);
    }
    idx[i] = id;
  }
  return { ...p, pos: Float32Array.from(pos), nor: Float32Array.from(nor), idx };
}

export const triCount = (parts: RawPart[]) => parts.reduce((s, p) => s + p.idx.length / 3, 0);

/**
 * Сварка + упрощение до бюджета треугольников (равномерная доля; мелкие детали не трогаем).
 * Границы меша фиксируются, поэтому панели не «расползаются».
 */
export async function simplifyParts(parts: RawPart[], budget: number, onProgress?: (done: number, total: number) => void): Promise<RawPart[]> {
  await MeshoptSimplifier.ready;
  const welded = parts.map(weld);
  const total = triCount(welded);
  const ratio = Math.min(1, budget / Math.max(1, total));
  const out: RawPart[] = [];
  let i = 0;
  for (const p of welded) {
    const tris = p.idx.length / 3;
    if (ratio >= 1 || tris < 400) out.push(p);
    else {
      const target = Math.max(3, Math.floor(tris * ratio)) * 3;
      const [res] = MeshoptSimplifier.simplifyWithAttributes(p.idx, p.pos, 3, p.nor, 3, [0.6, 0.6, 0.6], null, target, 0.02, ['LockBorder']);
      out.push(compact(p, res));
    }
    onProgress?.(++i, welded.length);
    if (i % 8 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  return out;
}
