/**
 * Логика 3D-редактора разметки (P1, п. 7): пределы значений, подтягивание при перетаскивании гизмо,
 * зеркалирование панелей на другую сторону и «поза» открытых панелей.
 *
 * Здесь нет three.js — только числа и структуры из `types.ts`, поэтому модуль проверяется тестами
 * (`tests/import-gizmo.test.ts`). Визуальную часть (TransformControls) держит `src/view3d/importGizmo.ts`.
 *
 * Система координат модели: X — вперёд, Y — вверх, Z — вбок; `dims` в метрах.
 */
import type { Dims, HingeOverride, Lines, PanelRegion } from './types';

export type LineKind = 'x' | 'y' | 'w';

/** Тип координаты для каждой линии реза: X — вдоль кузова, Y — высота, W — половина ширины. */
export const LINE_KIND: Record<keyof Lines, LineKind> = {
  bumperFront: 'x',
  cowl: 'x',
  doorFront: 'x',
  roofFront: 'x',
  doorSplit: 'x',
  roofRear: 'x',
  doorRear: 'x',
  trunkFront: 'x',
  bumperRear: 'x',
  sill: 'y',
  belt: 'y',
  bumperTopF: 'y',
  bumperTopR: 'y',
  hoodHw: 'w',
  trunkHw: 'w',
};

export const LINE_KIND_LABEL: Record<LineKind, string> = {
  x: 'вдоль кузова',
  y: 'по высоте',
  w: 'по ширине',
};

/** Круглые скобки диапазона для каждого типа линии. */
export function lineLimits(dims: Dims): Record<LineKind, [number, number]> {
  return { x: [dims.xRear, dims.xFront], y: [0, dims.H], w: [0.15, Math.max(0.16, dims.W / 2)] };
}

/** Пределы координаты петли по оси. */
export function hingeLimits(dims: Dims, axis: 'x' | 'y' | 'z'): [number, number] {
  if (axis === 'x') return [dims.xRear, dims.xFront];
  if (axis === 'y') return [0, dims.H];
  return [-dims.W / 2, dims.W / 2];
}

export const round3 = (value: number): number => Math.round(value * 1000) / 1000;

export function clampTo([lo, hi]: [number, number], value: number): number {
  if (!Number.isFinite(value)) return lo;
  return Math.min(hi, Math.max(lo, value));
}

/** Значение линии из точки на модели: X — вперёд, Y — вверх, W — расстояние от оси. */
export function lineValueFromPoint(key: keyof Lines, point: readonly [number, number, number]): number {
  const kind = LINE_KIND[key];
  return kind === 'x' ? point[0] : kind === 'y' ? point[1] : Math.abs(point[2]);
}

/** Ось, вдоль которой тянут линию: W тянется вбок (по Z), но значение берётся по модулю. */
export function lineDragAxis(key: keyof Lines): 'x' | 'y' | 'z' {
  const kind = LINE_KIND[key];
  return kind === 'x' ? 'x' : kind === 'y' ? 'y' : 'z';
}

/** Готовое значение линии после перетаскивания: подтягивается к пределам и округляется до миллиметра. */
export function dragLine(key: keyof Lines, value: number, dims: Dims): number {
  return round3(clampTo(lineLimits(dims)[LINE_KIND[key]], value));
}

/** Патч петли после перетаскивания по оси: одна координата, в пределах кузова. */
export function dragHinge(axis: 'x' | 'y' | 'z', value: number, dims: Dims): HingeOverride {
  return { [axis]: round3(clampTo(hingeLimits(dims, axis), value)) } as HingeOverride;
}

/**
 * Плоскости-подсказки для линии реза: одна плоскость (X/Y) или две симметричные (W).
 * Размеры и положение — в системе автомобиля, для полупрозрачного «стекла» в 3D.
 */
export function lineGuideBoxes(key: keyof Lines, value: number, dims: Dims): { size: [number, number, number]; pos: [number, number, number] }[] {
  const midX = (dims.xFront + dims.xRear) / 2;
  if (LINE_KIND[key] === 'x') return [{ size: [0.01, dims.H, dims.W], pos: [value, dims.H / 2, 0] }];
  if (LINE_KIND[key] === 'y') return [{ size: [dims.L, 0.01, dims.W], pos: [midX, value, 0] }];
  return [value, -value].map((z) => ({ size: [dims.L, dims.H, 0.01], pos: [midX, dims.H / 2, z] }));
}

/** Второй элемент пары имеет смысл только для симметричных линий ширины. */
export const lineGuidesAreSymmetric = (key: keyof Lines): boolean => LINE_KIND[key] === 'w';

/**
 * Парная панель: `door_fl` ↔ `door_fr`, `door_rl` ↔ `door_rr`, `sill_l` ↔ `sill_r`
 * (те же окончания, что и у `facingOf` в `zoneset.ts`). У симметричных узлов (капот, крышка) пары нет.
 */
const MIRROR_PAIRS: Record<string, string> = {
  door_fl: 'door_fr', door_fr: 'door_fl', door_rl: 'door_rr', door_rr: 'door_rl',
  sill_l: 'sill_r', sill_r: 'sill_l',
};

export function mirrorZone(zone: string): string | null {
  return MIRROR_PAIRS[zone] ?? null;
}

/** Петля на другую сторону: Z меняет знак, угол открытия — тоже (створка открывается в другую сторону). */
export function mirrorHinge(zone: string, hinge: HingeOverride): HingeOverride | null {
  if (!mirrorZone(zone)) return null;
  const out: HingeOverride = {};
  for (const key of ['x', 'y', 'z', 'angle'] as const) {
    const value = hinge[key];
    if (value === undefined) continue;
    out[key] = key === 'z' || key === 'angle' ? round3(-value) : value;
  }
  if (hinge.axis !== undefined) out.axis = hinge.axis;
  return Object.keys(out).length ? out : null;
}

/** Маска на другую сторону: у боковой проекции контур тот же, у верхней Z меняет знак. */
export function mirrorRegion(region: PanelRegion): PanelRegion | null {
  if (region.side === 'both') return null;
  return {
    ...region,
    side: region.side === 'left' ? 'right' : region.side === 'right' ? 'left' : 'both',
    points: region.projection === 'top' ? region.points.map(([x, z]) => [x, -z] as [number, number]) : region.points.map(([x, y]) => [x, y] as [number, number]),
  };
}

/** Есть ли у узла `zone` маски, которые можно зеркалить. */
export const hasMirrorableRegions = (regions: PanelRegion[] | undefined, zone: string): boolean =>
  (regions ?? []).some((region) => region.zone === zone && region.side !== 'both');

/**
 * «Поза» открытых панелей: какие узлы были открыты для проверки зазоров.
 * Хранится отдельно от разметки (не влияет на модель), поэтому её можно сбросить.
 */
export function normalizePose(open: readonly string[], known: readonly string[]): string[] {
  const allowed = new Set(known);
  return [...new Set(open)].filter((zone) => allowed.has(zone)).sort();
}

export const poseEquals = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((zone, index) => zone === b[index]);
