import { describe, expect, it } from 'vitest';
import { centerProfile, groundProfile, profileChecks, runChecks } from '../src/import/inspect';
import { buildReport, formatReportLines, reportRows } from '../src/import/report';
import type { Profile } from '../src/import/types';

const profile = (patch: Partial<Profile> = {}, dims: Partial<Profile['dims']> = {}): Profile => ({
  v: 1,
  title: 'Проверка',
  body: 'hatch',
  layout: 'front',
  driver: 'l',
  frame: { yaw: 0, scale: 1, offset: [0, 0, 0] },
  dims: { L: 4.32, W: 1.76, H: 1.42, xFront: 2.16, xRear: -2.16, axleF: 1.345, axleR: -1.345, track: 0.76, wheelR: 0.32, ...dims },
  lines: {
    bumperFront: 1.94, cowl: 0.62, doorFront: 0.56, roofFront: -0.05, doorSplit: -0.42, roofRear: -1.32,
    doorRear: -1.26, trunkFront: -1.95, bumperRear: -1.99, sill: 0.26, belt: 0.9, bumperTopF: 0.5,
    bumperTopR: 0.45, hoodHw: 0.72, trunkHw: 0.55,
  },
  paint: ['Body'],
  provenance: { dimensions: 'document', dimensionsConfidence: 'medium', panelBoundaries: 'auto', panelBoundariesConfidence: 'low' },
  parts: {
    p0: { n: 'Body', k: 'paint', m: 'Body' },
    p1: { n: 'Hood', k: 'paint', m: 'Body' },
    p2: { n: 'Door L', k: 'paint', m: 'Body' },
    p3: { n: 'Door R', k: 'paint', m: 'Body' },
    p4: { n: 'Glass F', k: 'glass', m: 'Glass' },
    p5: { n: 'Glass R', k: 'glass', m: 'Glass' },
    p6: { n: 'Wheel FL', k: 'wheel', m: 'Tire' },
    p7: { n: 'Wheel FR', k: 'wheel', m: 'Tire' },
    p8: { n: 'Wheel RL', k: 'wheel', m: 'Tire' },
    p9: { n: 'Wheel RR', k: 'wheel', m: 'Tire' },
    p10: { n: 'Interior', k: 'int', m: 'Fabric' },
    p11: { n: 'Spare', k: 'hide', m: 'Spare' },
  },
  ...patch,
});

const boxOf = (min: [number, number, number], max: [number, number, number]) => ({ min, max });

const byId = (list: { id: string; level: string; title: string; hint?: string; action?: string }[]) =>
  Object.fromEntries(list.map((item) => [item.id, item]));

describe('проверки модели', () => {
  it('здоровая разметка проходит без предупреждений', () => {
    const checks = runChecks(profile(), boxOf([-2.16, 0, -0.88], [2.16, 1.42, 0.88]));
    expect(checks.filter((check) => check.level !== 'ok')).toEqual([]);
    expect(checks.length).toBeGreaterThanOrEqual(10);
  });

  it('подсказывает про дюймы, сантиметры и миллиметры', () => {
    const inches = byId(profileChecks(profile({}, { L: 170, xFront: 85, xRear: -85 })))['length'];
    expect(inches.level).toBe('warn');
    expect(inches.hint).toMatch(/дюймах/);
    expect(inches.hint).toMatch(/4\.32 м/);

    const cm = byId(profileChecks(profile({}, { L: 432, xFront: 216, xRear: -216 })))['length'];
    expect(cm.hint).toMatch(/сантиметрах/);

    const mm = byId(profileChecks(profile({}, { L: 4320, xFront: 2160, xRear: -2160 })))['length'];
    expect(mm.hint).toMatch(/миллиметрах/);
  });

  it('ловит колёса, стёкла и панели', () => {
    const checks = byId(profileChecks(profile({
      parts: { p0: { n: 'Body', k: 'paint', m: 'Body' } },
      provenance: { dimensions: 'auto', dimensionsConfidence: 'low', panelBoundaries: 'auto', panelBoundariesConfidence: 'low' },
    })));
    expect(checks.wheels.level).toBe('warn');
    expect(checks.wheels.title).toMatch(/Колёса не найдены/);
    expect(checks.glass.title).toMatch(/Стёкла не найдены/);
    expect(checks.panels.title).toMatch(/мало \(1\)/);
    expect(checks.provenance.level).toBe('warn');
    expect(profileChecks(profile({ provenance: { dimensions: 'document', dimensionsConfidence: 'medium', panelBoundaries: 'auto', panelBoundariesConfidence: 'low' } })).find((c) => c.id === 'provenance')?.level).toBe('ok');
  });

  it('геометрия: земля, габариты и симметрия с быстрыми исправлениями', () => {
    const checks = byId(runChecks(profile(), boxOf([-2.1, 0.2, -0.8], [2.1, 1.5, 0.4])));
    expect(checks.ground.level).toBe('warn');
    expect(checks.ground.title).toMatch(/висит над землёй/);
    expect(checks.ground.action).toBe('ground');
    expect(checks.symmetry.level).toBe('warn');
    expect(checks.symmetry.action).toBe('center');

    const patched = groundProfile(profile(), boxOf([-2.1, 0.2, -0.8], [2.1, 1.5, 0.4]));
    expect(patched?.frame.offset[1]).toBeCloseTo(-0.2, 6);
    expect(profile().frame.offset[1]).toBe(0); // исходный профиль не меняется
    expect(groundProfile(profile(), boxOf([-2.1, 0.001, -0.8], [2.1, 1.5, 0.4]))).toBeNull();

    const centered = centerProfile(profile(), boxOf([-2.1, 0, -0.7], [2.1, 1.4, 0.5]));
    expect(centered?.frame.offset[2]).toBeCloseTo(0.1, 6);
    expect(centerProfile(profile(), boxOf([-2.1, 0, -0.88], [2.1, 1.4, 0.88]))).toBeNull();
  });

  it('без bbox геометрических проверок нет', () => {
    expect(runChecks(profile(), null).some((check) => check.id === 'ground')).toBe(false);
    const bad = byId(runChecks(profile(), boxOf([-2.5, 0, -0.9], [2.6, 1.5, 0.9])))['size'];
    expect(bad.level).toBe('warn');
    expect(bad.title).toMatch(/Габариты модели и разметки расходятся/);
  });
});

describe('отчёт об импорте', () => {
  it('собирает сводку и строки для интерфейса и CLI', () => {
    const report = buildReport({ srcTris: 200_000, tris: 130_000, parts: 12, bytes: 3 * 1024 * 1024 }, profile({
      panelRegions: [{ zone: 'door_fl', projection: 'side', points: [[0, 0], [1, 0], [1, 1]] }],
      hinges: { door_fl: { x: 0.5 } },
      credits: { author: 'Иван', license: 'CC BY 4.0', source: 'https://example.com' },
    }), ['Геометрия была сжата Draco и распакована при импорте.']);

    expect(report.removed).toBe(70_000);
    expect(report.removedPercent).toBeCloseTo(35, 6);
    expect(report.hidden).toBe(1);
    expect(report.masks).toBe(1);
    expect(report.hinges).toBe(1);
    expect(report.wheelbase).toBeCloseTo(2.69, 6);
    expect(report.kinds.find((k) => k.kind === 'wheel')?.count).toBe(4);

    const rows = reportRows(report);
    expect(rows[0].value).toMatch(/200\s*000 → 130\s*000/);
    expect(rows.map((row) => row.label)).toContain('Атрибуция');
    expect(formatReportLines(report).length).toBe(rows.length);
    expect(formatReportLines(report).join('\n')).toMatch(/Треугольники: /);
  });

  it('не показывает раздел атрибуции без данных и переживает нулевую статистику', () => {
    const report = buildReport({ srcTris: 0, tris: 0, parts: 1, bytes: 0 }, profile(), []);
    expect(report.removedPercent).toBe(0);
    expect(reportRows(report).some((row) => row.label === 'Атрибуция')).toBe(false);
    expect(buildReport({ srcTris: 10, tris: 12, parts: 1, bytes: 0 }, profile(), []).removed).toBe(0);
  });
});
