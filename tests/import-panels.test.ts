import { describe, expect, it } from 'vitest';
import { analyze } from '../src/import/analyze';
import { detectPanels, trimmedBox } from '../src/import/seams';
import { parseProfile } from '../src/import/profile';
import { bboxOf } from '../src/import/frame';
import type { Kind, Profile, RawPart } from '../src/import/types';

/** Деталь-параллелепипед: 12 треугольников, как у настоящей панели. */
function box(id: string, material: string, min: [number, number, number], max: [number, number, number], o: { alpha?: number; name?: string } = {}): RawPart {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const v = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const faces = [
    [0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6], [0, 4, 5], [0, 5, 1],
    [3, 2, 6], [3, 6, 7], [0, 3, 7], [0, 7, 4], [1, 5, 6], [1, 6, 2],
  ];
  const pos = new Float32Array(faces.flat().flatMap((i) => v[i]));
  const nor = new Float32Array(pos.length);
  const idx = new Uint32Array(pos.length / 3).map((_, i) => i);
  return {
    id, name: o.name ?? id, material, alpha: o.alpha ?? 1, emissive: false,
    color: [0.5, 0.5, 0.5], metallic: 0, roughness: 0.8, pos, nor, idx,
  };
}

/**
 * Синтетический седан 4.1 м с отдельными мешами дверей, капота, крышки и бамперов —
 * ровно тот случай, ради которого нужен поиск настоящих кромок панелей.
 */
function sedanParts(): RawPart[] {
  return [
    box('p0', 'BODY', [-2.0, 0.35, -0.9], [2.0, 1.78, 0.9]),
    box('p1', 'BODY', [-0.35, 0.35, -0.9], [0.75, 1.0, -0.78]), // дверь передняя левая
    box('p2', 'BODY', [-0.35, 0.35, 0.78], [0.75, 1.0, 0.9]),   // дверь передняя правая
    box('p3', 'BODY', [-1.35, 0.35, -0.9], [-0.3, 1.0, -0.78]), // дверь задняя левая
    box('p4', 'BODY', [-1.35, 0.35, 0.78], [-0.3, 1.0, 0.9]),   // дверь задняя правая
    box('p5', 'BODY', [0.82, 1.32, -0.75], [2.0, 1.42, 0.75]),   // капот
    box('p6', 'BODY', [-2.0, 1.32, -0.7], [-1.45, 1.4, 0.7]),   // крышка багажника
    box('p7', 'BODY', [1.88, 0.35, -0.85], [2.05, 0.62, 0.85]), // бампер передний
    box('p8', 'BODY', [-2.05, 0.35, -0.85], [-1.86, 0.62, 0.85]), // бампер задний
    box('p9', 'GLASS', [-1.45, 1.42, -0.65], [-1.1, 1.75, 0.65], { alpha: 0.35 }), // заднее стекло
    box('p10', 'GLASS', [0.62, 1.42, -0.65], [1.05, 1.78, 0.65], { alpha: 0.35 }), // лобовое
    box('p11', 'GLASS', [-0.25, 1.42, -0.82], [0.6, 1.72, -0.75], { alpha: 0.35 }), // окно передней двери
    box('p12', 'GLASS', [-0.25, 1.42, 0.75], [0.6, 1.72, 0.82], { alpha: 0.35 }),
    box('p13', 'GLASS', [-1.3, 1.42, -0.82], [-0.45, 1.72, -0.75], { alpha: 0.35 }), // окно задней двери
    box('p14', 'GLASS', [-1.3, 1.42, 0.75], [-0.45, 1.72, 0.82], { alpha: 0.35 }),
    box('p15', 'Tire', [0.98, 0, -0.88], [1.63, 0.65, -0.66]),   // колёса
    box('p16', 'Tire', [0.98, 0, 0.66], [1.63, 0.65, 0.88]),
    box('p17', 'Tire', [-1.63, 0, -0.88], [-0.98, 0.65, -0.66]),
    box('p18', 'Tire', [-1.63, 0, 0.66], [-0.98, 0.65, 0.88]),
    box('p19', 'Interior', [-1.2, 0.4, -0.7], [0.3, 0.95, 0.7], { name: 'Seats' }),
    box('p20', 'Trim', [-0.1, 1.05, -0.2], [0.35, 1.3, 0.2], { name: 'Object_7' }),
    box('p21', '11_-_Default', [-2.0, -4.5, -0.5], [-1.6, -4.2, 0.5]), // посторонний объект сцены
  ];
}

const kindsOf = (p: Profile): Map<string, Kind> => new Map(Object.entries(p.parts).map(([id, i]) => [id, i.k]));

describe('устойчивые габариты сцены', () => {
  it('объект, вынесенный из облака, не растягивает коробку', () => {
    const parts = sedanParts();
    const all = trimmedBox(parts.map((p) => bboxOf(p.pos)));
    expect(all.min[1]).toBeGreaterThan(-1);
    expect(all.max[1]).toBeLessThan(2);
  });
});

describe('авторазбор панелей', () => {
  const parts = sedanParts();
  const profile = analyze(parts, 'Синтетический седан');

  it('размеры и тип кузова по колёсам и стёклам', () => {
    expect(profile.dims.L).toBeGreaterThan(4);
    expect(profile.dims.L).toBeLessThan(4.4);
    expect(profile.dims.H).toBeGreaterThan(1.6);
    expect(profile.dims.H).toBeLessThan(2.0);
    expect(profile.body).toBe('sedan');
    expect(profile.paint).toContain('BODY');
  });

  it('двери, капот, крышка и бамперы закреплены за узлами по кромкам мешей', () => {
    for (const [id, zone] of [
      ['p1', 'door_fl'], ['p2', 'door_fr'], ['p3', 'door_rl'], ['p4', 'door_rr'],
      ['p5', 'hood'], ['p6', 'trunk'], ['p7', 'bumper_f'], ['p8', 'bumper_r'],
    ] as const) {
      expect(profile.parts[id].z, `${id} → ${zone}`).toBe(zone);
      expect(profile.parts[id].b).toBe(1);
    }
  });

  it('линии совпадают с настоящими кромками дверей и капота', () => {
    expect(profile.lines.doorFront).toBeCloseTo(0.75, 1);
    expect(profile.lines.doorRear).toBeCloseTo(-1.35, 1);
    expect(profile.lines.doorSplit).toBeCloseTo(-0.325, 1);
    expect(profile.lines.cowl).toBeCloseTo(0.82, 1);
    expect(profile.lines.trunkFront).toBeCloseTo(-2.0, 1);
    expect(profile.lines.sill).toBeCloseTo(0.35, 1);
  });

  it('салон находится по материалу и по положению внутри кабины', () => {
    const kinds = kindsOf(profile);
    expect(kinds.get('p19')).toBe('int');
    expect(kinds.get('p20')).toBe('int');
    expect(profile.autoNotes?.some((n) => n.includes('Салон'))).toBe(true);
  });

  it('посторонний объект сцены скрывается и не влияет на разметку', () => {
    expect(kindsOf(profile).get('p21')).toBe('hide');
    expect(profile.dims.H).toBeLessThan(2.1);
  });

  it('подсказки авторазбора попадают в профиль и переживают сериализацию', () => {
    const parsed = parseProfile(JSON.parse(JSON.stringify(profile)));
    expect(parsed.autoNotes?.length).toBeGreaterThan(1);
    expect(parsed.parts.p1.z).toBe('door_fl');
    expect(parsed.parts.p1.b).toBe(1);
    expect(parsed.lines.doorSplit).toBeCloseTo(profile.lines.doorSplit, 4);
  });

  it('поиск можно выключить: остаются только линии по стёклам', () => {
    const plain = analyze(sedanParts(), 'Без поиска панелей', { panels: false });
    expect(plain.parts.p1.z).toBeUndefined();
    expect(plain.parts.p5.b).toBeUndefined();
  });
});

describe('detectPanels на синтетике', () => {
  const parts = sedanParts();
  const kinds = new Map<string, Kind>(parts.map((p) => [p.id, 'paint']));

  it('находит пары дверей и края по кромкам', () => {
    const found = detectPanels({
      parts,
      hidden: new Set(['p0', 'p9', 'p10', 'p11', 'p12', 'p13', 'p14', 'p15', 'p16', 'p17', 'p18', 'p19', 'p20', 'p21']),
      kinds,
      toCar: (b) => b,
      dims: { L: 4.1, W: 1.8, H: 1.75, xFront: 2.05, xRear: -2.05, axleF: 1.3, axleR: -1.3, track: 0.77, wheelR: 0.32 },
      lines: {
        bumperFront: 1.9, cowl: 1.05, doorFront: 0.75, roofFront: 0.62, doorSplit: -0.325, roofRear: -1.1,
        doorRear: -1.35, trunkFront: -2.0, bumperRear: -1.9, sill: 0.35, belt: 1.42, bumperTopF: 0.62,
        bumperTopR: 0.62, hoodHw: 0.75, trunkHw: 0.7,
      },
      sideGlass: { xMin: -1.3, xMax: 0.6 },
    });
    const zones = found.panels.map((p) => p.zone);
    expect(zones).toEqual(expect.arrayContaining(['door_fl', 'door_fr', 'door_rl', 'door_rr', 'hood', 'trunk']));
    expect(found.lines.doorSplit).toBeCloseTo(-0.325, 2);
    expect(found.lines.hoodHw).toBeCloseTo(0.75, 2);
  });
});
