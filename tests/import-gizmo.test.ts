import { describe, expect, it } from 'vitest';
import {
  LINE_KIND, clampTo, dragHinge, dragLine, hasMirrorableRegions, hingeLimits, lineDragAxis, lineGuideBoxes,
  lineLimits, lineValueFromPoint, mirrorHinge, mirrorRegion, mirrorZone, normalizePose, poseEquals, round3,
} from '../src/import/gizmo';
import type { Dims, Lines, PanelRegion } from '../src/import/types';

const dims: Dims = { L: 4.32, W: 1.76, H: 1.42, xFront: 2.16, xRear: -2.16, axleF: 1.345, axleR: -1.345, track: 0.76, wheelR: 0.32 };

const LINE_KEYS: (keyof Lines)[] = [
  'bumperFront', 'cowl', 'doorFront', 'roofFront', 'doorSplit', 'roofRear', 'doorRear', 'trunkFront', 'bumperRear',
  'sill', 'belt', 'bumperTopF', 'bumperTopR', 'hoodHw', 'trunkHw',
];

describe('3D-редактор разметки: значения и пределы', () => {
  it('знает тип координаты у каждой линии', () => {
    expect(Object.keys(LINE_KIND).sort()).toEqual([...LINE_KEYS].sort());
    expect(LINE_KIND.doorFront).toBe('x');
    expect(LINE_KIND.sill).toBe('y');
    expect(LINE_KIND.hoodHw).toBe('w');
  });

  it('подтягивает значения линий к габаритам и округляет до миллиметра', () => {
    expect(dragLine('doorFront', 9, dims)).toBe(2.16);
    expect(dragLine('doorFront', -9, dims)).toBe(-2.16);
    expect(dragLine('belt', -1, dims)).toBe(0);
    expect(dragLine('hoodHw', 5, dims)).toBe(0.88);
    expect(dragLine('hoodHw', -0.5, dims)).toBe(0.15);
    expect(dragLine('cowl', 0.61234, dims)).toBe(0.612);
    expect(lineLimits(dims).y).toEqual([0, 1.42]);
  });

  it('берёт значение линии из точки на модели', () => {
    expect(lineValueFromPoint('doorRear', [1.2, 0.5, -0.4])).toBe(1.2);
    expect(lineValueFromPoint('belt', [1.2, 0.9, -0.4])).toBe(0.9);
    expect(lineValueFromPoint('trunkHw', [1.2, 0.9, -0.55])).toBe(0.55);
    expect(lineDragAxis('doorRear')).toBe('x');
    expect(lineDragAxis('sill')).toBe('y');
    expect(lineDragAxis('hoodHw')).toBe('z');
  });

  it('строит плоскости-подсказки: тонкие вдоль своей оси, для ширины — две', () => {
    const x = lineGuideBoxes('cowl', 0.62, dims);
    expect(x).toHaveLength(1);
    expect(x[0].size[0]).toBeLessThan(0.02);
    expect(x[0].pos).toEqual([0.62, 0.71, 0]);
    const y = lineGuideBoxes('belt', 0.9, dims);
    expect(y[0].size[1]).toBeLessThan(0.02);
    expect(y[0].pos[1]).toBe(0.9);
    const w = lineGuideBoxes('hoodHw', 0.72, dims);
    expect(w.map((b) => b.pos[2])).toEqual([0.72, -0.72]);
    expect(w[0].size[2]).toBeLessThan(0.02);
  });

  it('подтягивает петлю по каждой оси', () => {
    expect(hingeLimits(dims, 'y')).toEqual([0, 1.42]);
    expect(dragHinge('y', -3, dims)).toEqual({ y: 0 });
    expect(dragHinge('z', 4, dims)).toEqual({ z: 0.88 });
    expect(dragHinge('x', -1.23456, dims)).toEqual({ x: -1.235 });
    expect(round3(1.23456)).toBe(1.235);
    expect(clampTo([0, 1], Number.NaN)).toBe(0);
  });
});

describe('3D-редактор разметки: зеркалирование панелей', () => {
  it('находит парный узел только у боковых панелей', () => {
    expect(mirrorZone('door_fl')).toBe('door_fr');
    expect(mirrorZone('door_rr')).toBe('door_rl');
    expect(mirrorZone('sill_l')).toBe('sill_r');
    expect(mirrorZone('hood')).toBeNull();
    expect(mirrorZone('trunk')).toBeNull();
    expect(mirrorZone('windshield')).toBeNull();
  });

  it('переносит петлю на другую сторону: Z и угол меняют знак', () => {
    expect(mirrorHinge('door_fl', { x: -0.4, y: 1.1, z: -0.83, angle: -1.15, axis: 'y' }))
      .toEqual({ x: -0.4, y: 1.1, z: 0.83, angle: 1.15, axis: 'y' });
    expect(mirrorHinge('hood', { x: 2, y: 0.7, z: 0, axis: 'z' })).toBeNull();
    expect(mirrorHinge('door_fl', {})).toBeNull();
  });

  it('переносит маску на другую сторону: боковая проекция без изменений, верхняя — Z зеркалится', () => {
    const side: PanelRegion = { zone: 'door_fl', projection: 'side', side: 'left', points: [[0.5, 0.3], [0.5, 0.9], [-0.5, 0.9]] };
    expect(mirrorRegion(side)).toEqual({ ...side, side: 'right' });
    const top: PanelRegion = { zone: 'door_fl', projection: 'top', side: 'left', points: [[0.5, 0.3], [0.5, 0.9], [-0.5, 0.9]] };
    expect(mirrorRegion(top)?.points).toEqual([[0.5, -0.3], [0.5, -0.9], [-0.5, -0.9]]);
    expect(mirrorRegion({ ...side, side: 'both' })).toBeNull();
    expect(hasMirrorableRegions([side], 'door_fl')).toBe(true);
    expect(hasMirrorableRegions([{ ...side, side: 'both' }], 'door_fl')).toBe(false);
    expect(hasMirrorableRegions([side], 'door_fr')).toBe(false);
  });
});

describe('3D-редактор разметки: поза открытых панелей', () => {
  it('чистит позу: только известные узлы, без повторов, в стабильном порядке', () => {
    expect(normalizePose(['trunk', 'door_fl', 'trunk', 'нет_такого'], ['trunk', 'door_fl', 'hood'])).toEqual(['door_fl', 'trunk']);
    expect(normalizePose([], ['hood'])).toEqual([]);
    expect(poseEquals(['door_fl'], ['door_fl'])).toBe(true);
    expect(poseEquals(['door_fl'], ['door_fr'])).toBe(false);
    expect(poseEquals(['door_fl'], ['door_fl', 'trunk'])).toBe(false);
  });
});
