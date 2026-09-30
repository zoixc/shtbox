/** Сварка вершин и упрощение сеток (meshoptimizer, wasm). Без DOM. */
import { MeshoptSimplifier } from 'meshoptimizer/simplifier';
import type { RawPart } from './types';

const POSITION_SCALE = 1e5;
const NORMAL_SCALE = 50;
const UV_SCALE = 1e5;
const YIELD_EVERY = 32_768;
const YIELD = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function mixHash(hash: number, value: number): number {
  // Смешиваем младшую и старшую половины округлённого числа. Коллизии проверяются точно ниже.
  const low = value >>> 0;
  const high = Math.floor(value / 0x1_0000_0000) >>> 0;
  hash = Math.imul(hash ^ low, 0x01000193);
  return Math.imul(hash ^ high, 0x01000193);
}

function sameKey(p: RawPart, vertex: number, key: readonly number[]): boolean {
  const i = vertex * 3;
  return (
    Math.round(p.pos[i] * POSITION_SCALE) === key[0] &&
    Math.round(p.pos[i + 1] * POSITION_SCALE) === key[1] &&
    Math.round(p.pos[i + 2] * POSITION_SCALE) === key[2] &&
    Math.round(p.nor[i] * NORMAL_SCALE) === key[3] &&
    Math.round(p.nor[i + 1] * NORMAL_SCALE) === key[4] &&
    Math.round(p.nor[i + 2] * NORMAL_SCALE) === key[5] &&
    (!p.uv || (Math.round(p.uv[vertex * 2] * UV_SCALE) === key[6] && Math.round(p.uv[vertex * 2 + 1] * UV_SCALE) === key[7]))
  );
}

/**
 * Сваривает вершины без строковых ключей: открытая hash-таблица на typed arrays снижает
 * нагрузку на GC и память. Нормали и UV участвуют в ключе, поэтому hard edges и UV-швы остаются.
 */
export async function weld(p: RawPart, onProgress?: (frac: number) => void): Promise<RawPart> {
  const n = p.pos.length / 3;
  if (!Number.isInteger(n) || p.nor.length !== p.pos.length || (p.uv && p.uv.length !== n * 2)) {
    throw new Error(`Повреждённая геометрия детали «${p.name}»`);
  }
  if (p.idx.length % 3 !== 0) throw new Error(`Неверный индексный буфер детали «${p.name}»`);
  if (!n) return p;

  let tableSize = 1;
  const targetSize = Math.max(2, n * 2);
  while (tableSize < targetSize) {
    tableSize *= 2;
    if (tableSize > 0x4000_0000) throw new Error('Слишком много вершин для безопасной сварки');
  }
  const table = new Uint32Array(tableSize); // zero = пусто, иначе исходный индекс + 1
  const remap = new Uint32Array(n);
  const firstVertex = new Uint32Array(n);
  const mask = tableSize - 1;
  let unique = 0;

  for (let start = 0; start < n; start += YIELD_EVERY) {
    const end = Math.min(n, start + YIELD_EVERY);
    for (let v = start; v < end; v++) {
      const i = v * 3;
      const key = [
        Math.round(p.pos[i] * POSITION_SCALE),
        Math.round(p.pos[i + 1] * POSITION_SCALE),
        Math.round(p.pos[i + 2] * POSITION_SCALE),
        Math.round(p.nor[i] * NORMAL_SCALE),
        Math.round(p.nor[i + 1] * NORMAL_SCALE),
        Math.round(p.nor[i + 2] * NORMAL_SCALE),
      ];
      if (p.uv) key.push(Math.round(p.uv[v * 2] * UV_SCALE), Math.round(p.uv[v * 2 + 1] * UV_SCALE));
      let hash = 0x811c9dc5;
      for (let k = 0; k < key.length; k++) hash = mixHash(hash, key[k]);
      let slot = hash & mask;
      let entry = table[slot];
      while (entry !== 0 && !sameKey(p, entry - 1, key)) {
        slot = (slot + 1) & mask;
        entry = table[slot];
      }
      if (entry !== 0) remap[v] = remap[entry - 1];
      else {
        table[slot] = v + 1;
        remap[v] = unique;
        firstVertex[unique++] = v;
      }
    }
    onProgress?.(end / n);
    if (end < n) await YIELD();
  }

  if (p.idx.some((v) => v >= n)) throw new Error(`Индекс за пределами детали «${p.name}»`);
  let validIndexCount = 0;
  let unchanged = unique === n;
  for (let t = 0; t < p.idx.length; t += 3) {
    const a = remap[p.idx[t]], b = remap[p.idx[t + 1]], c = remap[p.idx[t + 2]];
    if (a === b || b === c || a === c) unchanged = false;
    else validIndexCount += 3;
    if (a !== p.idx[t] || b !== p.idx[t + 1] || c !== p.idx[t + 2]) unchanged = false;
    if ((t / 3) % YIELD_EVERY === 0 && t > 0) await YIELD();
  }
  if (unchanged) return p;

  const pos = unique === n ? p.pos : new Float32Array(unique * 3);
  const nor = unique === n ? p.nor : new Float32Array(unique * 3);
  const uv = !p.uv ? undefined : unique === n ? p.uv : new Float32Array(unique * 2);
  if (unique !== n) {
    for (let id = 0; id < unique; id++) {
      const source = firstVertex[id];
      pos.set(p.pos.subarray(source * 3, source * 3 + 3), id * 3);
      nor.set(p.nor.subarray(source * 3, source * 3 + 3), id * 3);
      if (uv && p.uv) uv.set(p.uv.subarray(source * 2, source * 2 + 2), id * 2);
      if (id > 0 && id % YIELD_EVERY === 0) await YIELD();
    }
  }
  const idx = new Uint32Array(validIndexCount);
  let write = 0;
  for (let t = 0; t < p.idx.length; t += 3) {
    const a = remap[p.idx[t]], b = remap[p.idx[t + 1]], c = remap[p.idx[t + 2]];
    if (a === b || b === c || a === c) continue;
    idx[write++] = a;
    idx[write++] = b;
    idx[write++] = c;
    if (write > 0 && write % (YIELD_EVERY * 3) === 0) await YIELD();
  }
  return { ...p, pos, nor, uv, idx };
}

export const triCount = (parts: RawPart[]) => parts.reduce((sum, p) => sum + p.idx.length / 3, 0);

const SEMANTIC_PART = /wheel|tire|tyre|rim|brake|caliper|rotor|light|lamp|glass|window|windshield|door|hood|bonnet|trunk|boot|bumper|fender|mirror|seat|dashboard|steering|engine|exhaust|suspension|panel/i;
const BODY_PART = /body|shell|roof|frame|car|vehicle|exterior/i;

export function semanticPriority(p: RawPart): number {
  const label = `${p.name} ${p.material}`;
  if (SEMANTIC_PART.test(label)) return 2.4;
  if (BODY_PART.test(label)) return 1.5;
  return 1;
}

export interface TriangleTarget {
  id: string;
  tris: number;
  target: number;
  priority: number;
}

/** Распределяет общий предел с минимальным резервом на каждую деталь и весом за семантику. */
export function allocateTriangleTargets(parts: RawPart[], requestedBudget: number): TriangleTarget[] {
  const entries = parts
    .map((p) => ({ id: p.id, tris: Math.floor(p.idx.length / 3), priority: semanticPriority(p) }))
    .filter((p) => p.tris > 0);
  if (!entries.length) return [];
  if (!Number.isFinite(requestedBudget) || requestedBudget <= 0) throw new Error('Бюджет треугольников должен быть положительным числом');
  const budget = Math.min(triCount(parts), Math.floor(requestedBudget));
  if (budget < entries.length) {
    throw new Error(`Бюджет слишком мал: для сохранения ${entries.length} деталей нужно не менее ${entries.length} треугольников`);
  }
  const targets = entries.map((entry) => Math.min(entry.tris, entry.priority > 1 ? 24 : 8));
  const preferredTotal = targets.reduce((sum, value) => sum + value, 0);
  if (preferredTotal > budget) {
    for (let i = 0; i < targets.length; i++) targets[i] = 1;
    distribute(entries, targets, budget - entries.length, entries.map((entry) => Math.max(0, Math.min(entry.tris - 1, Math.min(entry.priority > 1 ? 24 : 8, entry.tris) - 1)) * entry.priority));
  } else {
    distribute(entries, targets, budget - preferredTotal, entries.map((entry, i) => Math.max(0, entry.tris - targets[i]) * entry.priority));
  }
  return entries.map((entry, i) => ({ ...entry, target: targets[i] }));
}

/** Weighted water-filling with integer largest-remainder shares; never allocates above source size. */
function distribute(entries: { tris: number }[], targets: number[], remaining: number, weights: number[]): void {
  let left = remaining;
  while (left > 0) {
    const active = entries.map((entry, i) => ({ i, cap: entry.tris - targets[i], weight: weights[i] })).filter((e) => e.cap > 0 && e.weight > 0);
    if (!active.length) return;
    const totalWeight = active.reduce((sum, e) => sum + e.weight, 0);
    const shares = active.map((e) => {
      const exact = (left * e.weight) / totalWeight;
      const whole = Math.min(e.cap, Math.floor(exact));
      return { ...e, whole, fraction: exact - Math.floor(exact) };
    });
    let used = 0;
    for (const share of shares) {
      if (!share.whole) continue;
      targets[share.i] += share.whole;
      used += share.whole;
    }
    left -= used;
    if (left <= 0) return;
    let fractional = 0;
    shares.sort((a, b) => b.fraction - a.fraction || b.weight - a.weight || a.i - b.i);
    for (const share of shares) {
      if (!left) break;
      if (share.cap <= share.whole) continue;
      targets[share.i]++;
      left--;
      fractional++;
    }
    if (!used && !fractional) return;
  }
}

async function compact(p: RawPart, indices: Uint32Array): Promise<RawPart> {
  const vertexMap = new Uint32Array(p.pos.length / 3); // zero = unused, otherwise compact index + 1
  const first = new Uint32Array(Math.min(indices.length, vertexMap.length));
  const idx = new Uint32Array(indices.length);
  let unique = 0;
  for (let i = 0; i < indices.length; i++) {
    const source = indices[i];
    if (source >= vertexMap.length) throw new Error(`Упрощённая сетка «${p.name}» содержит неверный индекс`);
    let mapped = vertexMap[source];
    if (mapped === 0) {
      mapped = ++unique;
      vertexMap[source] = mapped;
      first[mapped - 1] = source;
    }
    idx[i] = mapped - 1;
    if (i > 0 && i % (YIELD_EVERY * 3) === 0) await YIELD();
  }
  const pos = new Float32Array(unique * 3);
  const nor = new Float32Array(unique * 3);
  const uv = p.uv ? new Float32Array(unique * 2) : undefined;
  for (let i = 0; i < unique; i++) {
    const source = first[i];
    pos.set(p.pos.subarray(source * 3, source * 3 + 3), i * 3);
    nor.set(p.nor.subarray(source * 3, source * 3 + 3), i * 3);
    if (uv && p.uv) uv.set(p.uv.subarray(source * 2, source * 2 + 2), i * 2);
    if (i > 0 && i % YIELD_EVERY === 0) await YIELD();
  }
  return { ...p, pos, nor, uv, idx };
}

function attributesWithUv(p: RawPart): Float32Array {
  const attributes = new Float32Array(p.pos.length / 3 * 5);
  for (let v = 0; v < p.pos.length / 3; v++) {
    const i3 = v * 3, i5 = v * 5;
    attributes[i5] = p.nor[i3];
    attributes[i5 + 1] = p.nor[i3 + 1];
    attributes[i5 + 2] = p.nor[i3 + 2];
    attributes[i5 + 3] = p.uv?.[v * 2] ?? 0;
    attributes[i5 + 4] = p.uv?.[v * 2 + 1] ?? 0;
  }
  return attributes;
}

export interface SimplifyResult {
  parts: RawPart[];
  warnings: string[];
  requestedTris: number;
  actualTris: number;
}

/**
 * Сваривает одинаковые вершины и распределяет общий треугольный бюджет между всеми деталями.
 * Семантически важные детали получают больший резерв; у каждой оставляется как минимум один треугольник.
 * LockBorder продолжает защищать кромки панелей. Если топология не позволяет достичь цели, геометрия
 * не выкидывается: фактическое превышение выводится в предупреждение.
 */
export async function simplifyParts(
  parts: RawPart[],
  budget: number,
  onProgress?: (stage: string, frac: number) => void,
): Promise<SimplifyResult> {
  await MeshoptSimplifier.ready;
  const welded: RawPart[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = await weld(parts[i], (frac) => onProgress?.('Сварка вершин', 0.35 * (i + frac) / Math.max(1, parts.length)));
    welded.push(p);
    onProgress?.('Сварка вершин', 0.35 * ((i + 1) / Math.max(1, parts.length)));
    if (i + 1 < parts.length) await YIELD();
  }

  const sourceTris = triCount(welded);
  const requestedTris = Math.min(sourceTris, Math.floor(budget));
  if (sourceTris <= requestedTris || sourceTris === 0) {
    onProgress?.('Упрощение', 1);
    return { parts: welded, warnings: [], requestedTris, actualTris: sourceTris };
  }
  const simplifyAtBudget = async (targetBudget: number, progressStart: number, progressEnd: number, stage: string): Promise<RawPart[]> => {
    const targets = new Map(allocateTriangleTargets(welded, targetBudget).map((entry) => [entry.id, entry]));
    const output: RawPart[] = [];
    for (let i = 0; i < welded.length; i++) {
      const p = welded[i];
      const currentTris = p.idx.length / 3;
      const allocation = targets.get(p.id)?.target ?? currentTris;
      if (currentTris <= allocation || currentTris < 2) {
        output.push(p);
      } else {
        const targetIndices = Math.max(3, allocation * 3);
        const attrs = p.uv ? attributesWithUv(p) : p.nor;
        const [result] = MeshoptSimplifier.simplifyWithAttributes(
          p.idx,
          p.pos,
          3,
          attrs,
          p.uv ? 5 : 3,
          p.uv ? [0.6, 0.6, 0.6, 0.8, 0.8] : [0.6, 0.6, 0.6],
          null,
          targetIndices,
          0.02,
          ['LockBorder'],
        );
        output.push(result.length >= 3 ? await compact(p, result) : p);
      }
      const frac = (i + 1) / Math.max(1, welded.length);
      onProgress?.(stage, progressStart + (progressEnd - progressStart) * frac);
      if (i + 1 < welded.length) await YIELD();
    }
    return output;
  };

  let output = await simplifyAtBudget(requestedTris, 0.35, 0.68, 'Упрощение сеток');
  let actualTris = triCount(output);
  if (actualTris > requestedTris) {
    // meshoptimizer can keep small components/borders above a per-part target. Rebalance with modest
    // headroom before admitting failure; the 2% geometric-error ceiling and LockBorder remain unchanged.
    const nonEmptyParts = welded.filter((part) => part.idx.length >= 3).length;
    const retryFactors = [0.985, 0.95, 0.9];
    for (let i = 0; i < retryFactors.length && actualTris > requestedTris; i++) {
      const retryBudget = Math.max(nonEmptyParts, Math.floor(requestedTris * retryFactors[i]));
      const retried = await simplifyAtBudget(retryBudget, 0.68 + i * 0.1, 0.78 + i * 0.1, 'Подбор общего бюджета');
      const retriedTris = triCount(retried);
      if (retriedTris < actualTris) {
        output = retried;
        actualTris = retriedTris;
      }
    }
  }
  onProgress?.('Упрощение', 1);

  const warnings: string[] = [];
  if (actualTris > requestedTris) {
    warnings.push(`Целевой бюджет ${requestedTris.toLocaleString('ru')} треугольников не достигнут: топология не позволила безопасно упростить сетки ниже ${actualTris.toLocaleString('ru')}; детали с границами сохранены.`);
  }
  return { parts: output, warnings, requestedTris, actualTris };
}
