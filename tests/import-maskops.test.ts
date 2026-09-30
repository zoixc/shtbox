import { describe, expect, it } from 'vitest';
import {
  MAX_POINTS, circleRing, cleanRing, intersectRegions, mergeRegions, regionCompatible, ringArea,
  simplifyRing, simplifyToLimit, strokeRing, subtractRegion, thinPoints,
} from '../src/import/maskOps';
import type { PanelRegion } from '../src/import/types';

const region = (points: [number, number][], patch: Partial<PanelRegion> = {}): PanelRegion =>
  ({ zone: 'door_fl', projection: 'side', side: 'left', points, ...patch });

const square = (min: number, size: number): [number, number][] => [
  [min, min], [min + size, min], [min + size, min + size], [min, min + size],
];

const areaOf = (r: PanelRegion | undefined): number => (r ? ringArea(r.points) : 0);

describe('маски панелей: булевы операции', () => {
  it('объединяет пересекающиеся контуры', () => {
    const result = mergeRegions(region(square(0, 1)), region(square(0.5, 1)));
    expect(result).not.toBeNull();
    expect(areaOf(result!.region)).toBeCloseTo(1.75, 2);
    expect(result!.parts).toBe(1);
    expect(result!.holes).toBe(0);
    expect(result!.region.points.length).toBeLessThanOrEqual(MAX_POINTS);
    expect(result!.region.zone).toBe('door_fl');
  });

  it('объединяет непересекающиеся контуры и предупреждает о нескольких частях', () => {
    const result = mergeRegions(region(square(0, 1)), region(square(5, 2)));
    expect(result!.parts).toBe(2);
    expect(areaOf(result!.region)).toBeCloseTo(4, 2); // остаётся крупнейшая часть
  });

  it('вычитает контур и сообщает об отверстии', () => {
    const corner = subtractRegion(region(square(0, 1)), region(square(-0.5, 1)));
    expect(areaOf(corner!.region)).toBeCloseTo(0.75, 2);
    expect(corner!.holes).toBe(0);

    const hole = subtractRegion(region(square(0, 1)), region(square(0.4, 0.2)));
    expect(hole!.holes).toBe(1);
    expect(areaOf(hole!.region)).toBeCloseTo(1, 2); // внешняя обводка сохранена
  });

  it('пересекает контуры', () => {
    const both = intersectRegions(region(square(0, 1)), region(square(0.5, 1)));
    expect(areaOf(both!.region)).toBeCloseTo(0.25, 2);
    expect(intersectRegions(region(square(0, 1)), region(square(5, 1)))).toBeNull();
  });

  it('не смешивает разные панели, стороны и типы поверхностей', () => {
    const a = region(square(0, 1));
    expect(regionCompatible(a, region(square(0, 1)))).toBe(true);
    expect(regionCompatible(a, region(square(0, 1), { zone: 'door_fr' }))).toBe(false);
    expect(regionCompatible(a, region(square(0, 1), { side: 'right' }))).toBe(false);
    expect(regionCompatible(a, region(square(0, 1), { projection: 'top' }))).toBe(false);
    expect(regionCompatible(a, region(square(0, 1), { kinds: ['paint'] }))).toBe(false);
    expect(mergeRegions(a, region(square(0, 1), { zone: 'hood' }))).toBeNull();
  });
});

describe('маски панелей: чистка и упрощение контура', () => {
  it('убирает повторы и замыкание', () => {
    const ring: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 0]];
    expect(cleanRing(ring)).toEqual([[0, 0], [1, 0], [1, 1]]);
    expect(cleanRing(ring, 5)).toEqual([[0, 0]]);
  });

  it('упрощает контур, выбрасывая точки на прямой', () => {
    const squareWithMidpoints: [number, number][] = [[0, 0], [0.5, 0], [1, 0], [1, 0.5], [1, 1], [0.5, 1], [0, 1], [0, 0.5]];
    const simplified = simplifyRing(squareWithMidpoints, 0.01);
    expect(simplified.length).toBeLessThanOrEqual(5);
    expect(ringArea(simplified)).toBeCloseTo(1, 2);
    expect(simplifyRing(squareWithMidpoints, 0)).toEqual(squareWithMidpoints);
  });

  it('укладывает контур в лимит профиля, сохраняя форму', () => {
    const big = circleRing([0, 0], 1);
    const dense: [number, number][] = Array.from({ length: 200 }, (_, i) => {
      const angle = (i / 200) * Math.PI * 2;
      return [Math.cos(angle), Math.sin(angle)];
    });
    const limited = simplifyToLimit(dense, MAX_POINTS, 0.01);
    expect(big.length).toBeLessThanOrEqual(MAX_POINTS);
    expect(limited.length).toBeLessThanOrEqual(MAX_POINTS);
    expect(ringArea(limited)).toBeGreaterThan(Math.PI * 0.9);
    expect(ringArea(limited)).toBeLessThan(Math.PI * 1.1);
  });
});

describe('маски панелей: кисть', () => {
  it('строит полосу вдоль жеста с кругами на концах', () => {
    const ring = strokeRing([[0, 0], [0.5, 0], [1, 0]], 0.1);
    expect(ring).not.toBeNull();
    expect(ring!.length).toBeGreaterThanOrEqual(4);
    const bounds = ring!.reduce((acc, [x, y]) => ({ minX: Math.min(acc.minX, x), maxX: Math.max(acc.maxX, x), minY: Math.min(acc.minY, y), maxY: Math.max(acc.maxY, y) }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
    expect(bounds.minX).toBeCloseTo(-0.1, 2);
    expect(bounds.maxX).toBeCloseTo(1.1, 2);
    expect(ringArea(ring!)).toBeGreaterThan(0.2);
    expect(ringArea(ring!)).toBeLessThan(0.32);
  });

  it('одна точка — круг, пустой жест — ничего', () => {
    const dot = strokeRing([[1, 1]], 0.05);
    expect(ringArea(dot!)).toBeCloseTo(ringArea(circleRing([1, 1], 0.05)), 6);
    expect(strokeRing([], 0.1)).toBeNull();
    expect(strokeRing([[0, 0], [1, 0]], 0)).toBeNull();
  });

  it('прореживает длинный жест, сохраняя концы', () => {
    const stroke: [number, number][] = Array.from({ length: 500 }, (_, i) => [i / 100, 0]);
    const thinned = thinPoints(stroke, 90);
    expect(thinned.length).toBe(90);
    expect(thinned[0]).toEqual([0, 0]);
    expect(thinned[89]).toEqual([4.99, 0]);
    expect(thinPoints(stroke.slice(0, 10), 90)).toHaveLength(10);
  });
});
