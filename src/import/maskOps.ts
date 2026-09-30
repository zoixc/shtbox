/**
 * Операции над масками панелей (P1, п. 8).
 *
 * Маски — это 2D-контуры в координатах кузова (`Profile.panelRegions`, проекции «сбоку» X/Y и «сверху» X/Z).
 * Здесь собраны булевы операции, чистка контура и «кисть»:
 *  - булевы операции и объединение кругов/полос делает `polygon-clipping` (MIT, алгоритм Мартинеса);
 *  - результат укладывается в формат профиля: одна внешняя обводка не длиннее `MAX_POINTS`, без дырок —
 *    если операция дала отверстие или несколько частей, об этом сообщает `MaskOpResult` (дырки наш профиль
 *    не умеет, поэтому берётся крупнейшая часть с внешней обводкой);
 *  - «кисть» — это полоса вдоль жеста плюс круги на концах, объединённые тем же `union`.
 *
 * Модуль без three.js и DOM, проверяется тестами (`tests/import-maskops.test.ts`).
 */
import * as pc from 'polygon-clipping';
import type { PanelRegion } from './types';

export type Point = [number, number];
/** Кольцо без повторения первой точки в конце. */
export type Ring = Point[];

/** Профиль хранит не больше 64 точек на маску (`parseProfile`). */
export const MAX_POINTS = 64;
/** Кольцо «кисти» строится многоугольниками: 12 сторон достаточно для радиуса ~10 см. */
const CIRCLE_SEGMENTS = 12;

export interface MaskOpResult {
  region: PanelRegion;
  /** Сколько отдельных частей получилось: в профиль попадает крупнейшая. */
  parts: number;
  /** Сколько отверстий пришлось отбросить (профиль их не поддерживает). */
  holes: number;
}

const clone = (region: PanelRegion, points: Ring): PanelRegion => ({ ...region, points: points.map(([x, y]) => [x, y] as Point) });

export function pointsBounds(points: readonly Point[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/** Удвоенная площадь контура (знак — направление обхода). */
export function ringArea2(ring: readonly Point[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum;
}

export const ringArea = (ring: readonly Point[]): number => Math.abs(ringArea2(ring)) / 2;

/** Похожи ли маски настолько, что их можно объединять (одна панель, одна проекция, одна сторона). */
export function regionCompatible(a: PanelRegion, b: PanelRegion): boolean {
  return a.projection === b.projection && a.zone === b.zone && (a.side ?? 'both') === (b.side ?? 'both')
    && JSON.stringify([...(a.kinds ?? ['paint', 'glass', 'trim'])].sort()) === JSON.stringify([...(b.kinds ?? ['paint', 'glass', 'trim'])].sort());
}

const asPolygon = (region: PanelRegion): pc.Polygon => [region.points.map(([x, y]) => [x, y] as pc.Pair)];

const op = (subject: PanelRegion, clip: PanelRegion, kind: 'union' | 'intersection' | 'difference'): pc.MultiPolygon | null => {
  if (!regionCompatible(subject, clip)) return null;
  const a = asPolygon(subject);
  const b = asPolygon(clip);
  return kind === 'union' ? pc.union(a, b) : kind === 'intersection' ? pc.intersection(a, b) : pc.difference(a, b);
};

/** Превращает результат polygon-clipping в маску профиля: крупнейшая часть, внешняя обводка, ≤64 точки. */
export function regionFromMulti(multi: pc.MultiPolygon, template: PanelRegion, tolerance = 0.01): MaskOpResult | null {
  if (!multi.length) return null;
  const sorted = [...multi].sort((a, b) => ringArea(b[0] as Ring) - ringArea(a[0] as Ring));
  const [outer, ...rest] = sorted;
  const holes = rest.length + (sorted[0].length - 1);
  const simplified = simplifyToLimit(cleanRing(outer[0] as Ring), MAX_POINTS, tolerance);
  if (simplified.length < 3 || ringArea(simplified) < 1e-6) return null;
  return { region: clone(template, simplified), parts: multi.length, holes };
}

const viaOp = (a: PanelRegion, b: PanelRegion, kind: 'union' | 'intersection' | 'difference'): MaskOpResult | null => {
  const multi = op(a, b, kind);
  return multi ? regionFromMulti(multi, a) : null;
};

export const mergeRegions = (a: PanelRegion, b: PanelRegion): MaskOpResult | null => viaOp(a, b, 'union');
export const intersectRegions = (a: PanelRegion, b: PanelRegion): MaskOpResult | null => viaOp(a, b, 'intersection');
export const subtractRegion = (a: PanelRegion, b: PanelRegion): MaskOpResult | null => viaOp(a, b, 'difference');

/** Убирает повторяющиеся и почти совпадающие точки. */
export function cleanRing(ring: readonly Point[], epsilon = 1e-4): Ring {
  const out: Ring = [];
  for (const [x, y] of ring) {
    const last = out[out.length - 1];
    if (last && Math.hypot(last[0] - x, last[1] - y) < epsilon) continue;
    out.push([x, y]);
  }
  const first = out[0];
  const last = out[out.length - 1];
  if (out.length > 1 && first && last && Math.hypot(first[0] - last[0], first[1] - last[1]) < epsilon) out.pop();
  return out;
}

/** Упрощение Дугласа—Пекера: выбрасывает точки, лежащие близко к отрезку. */
export function simplifyRing(ring: readonly Point[], tolerance: number): Ring {
  if (ring.length <= 3 || tolerance <= 0) return ring.map(([x, y]) => [x, y]);
  const keep = new Array<boolean>(ring.length).fill(false);
  keep[0] = true;
  keep[ring.length - 1] = true;
  const stack: [number, number][] = [[0, ring.length - 1]];
  while (stack.length) {
    const [from, to] = stack.pop() as [number, number];
    let index = -1;
    let max = tolerance;
    for (let i = from + 1; i < to; i++) {
      const d = pointSegmentDistance(ring[i], ring[from], ring[to]);
      if (d > max) {
        max = d;
        index = i;
      }
    }
    if (index > 0) {
      keep[index] = true;
      stack.push([from, index], [index, to]);
    }
  }
  const out = ring.filter((_, i) => keep[i]).map(([x, y]) => [x, y] as Point);
  return out.length >= 3 ? out : ring.map(([x, y]) => [x, y]);
}

/** Упрощает контур так, чтобы он уложился в лимит точек профиля. */
export function simplifyToLimit(ring: readonly Point[], limit = MAX_POINTS, tolerance = 0.01): Ring {
  let current = cleanRing(ring);
  let tol = tolerance;
  while (current.length > limit && tol < 4) {
    current = simplifyRing(current, tol);
    tol *= 1.6;
  }
  if (current.length <= limit) return current;
  // страховка: прореживаем по кругу, сохраняя форму
  const step = Math.ceil(current.length / limit);
  return current.filter((_, i) => i % step === 0).slice(0, limit);
}

function pointSegmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq < 1e-12) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Круг как многоугольник (для «кисти»). */
export function circleRing(center: Point, radius: number): Ring {
  const out: Ring = [];
  for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
    const angle = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
    out.push([center[0] + Math.cos(angle) * radius, center[1] + Math.sin(angle) * radius]);
  }
  return out;
}

/**
 * «Кисть»: полоса вдоль жеста плюс круги в точках жеста, объединённые в один контур.
 * Жест прореживается до `MAX_STROKE`, чтобы объединение оставалось быстрым даже на длинном движении.
 */
export function strokeRing(stroke: readonly Point[], radius: number, maxStroke = 90): Ring | null {
  const points = thinPoints(stroke, maxStroke);
  if (!points.length || radius <= 0) return null;
  if (points.length === 1) return circleRing(points[0], radius);
  const pieces: pc.Polygon[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[i + 1];
    const length = Math.hypot(bx - ax, by - ay);
    if (length < 1e-6) continue;
    const nx = (-(by - ay) / length) * radius;
    const ny = ((bx - ax) / length) * radius;
    pieces.push([[[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny]]]);
  }
  for (const point of points) pieces.push([circleRing(point, radius)]);
  if (!pieces.length) return null;
  const merged = pc.union(pieces[0], ...pieces.slice(1));
  if (!merged.length) return null;
  const largest = [...merged].sort((a, b) => ringArea(b[0] as Ring) - ringArea(a[0] as Ring))[0];
  return simplifyToLimit(cleanRing(largest[0] as Ring), MAX_POINTS, Math.max(0.005, radius / 4));
}

/** Прореживает жест, сохраняя крайние точки. */
export function thinPoints(points: readonly Point[], limit: number): Ring {
  if (points.length <= limit) return points.map(([x, y]) => [x, y]);
  const step = (points.length - 1) / (limit - 1);
  const out: Ring = [];
  for (let i = 0; i < limit; i++) out.push([...points[Math.round(i * step)] as Point]);
  return out;
}
