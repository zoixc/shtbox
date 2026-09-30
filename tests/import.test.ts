import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { patchProfile, splitGlb } from '../src/import/container';
import { guessCredits } from '../src/import/pipeline';
import { transformed, xform } from '../src/import/frame';
import { parseProfile } from '../src/import/profile';
import { makeZoner, remapZone } from '../src/import/partition';
import { facingOf, zonesFor } from '../src/import/zoneset';
import type { Profile } from '../src/import/types';

const pkg = () => new Uint8Array(readFileSync('public/models/bmw116i.glb'));
const testProfile = (): Profile => ({
  v: 1,
  title: 'Test hatchback',
  body: 'hatch',
  layout: 'front',
  driver: 'l',
  frame: { yaw: 0, scale: 1, offset: [0, 0, 0] },
  dims: { L: 4.32, W: 1.76, H: 1.42, xFront: 2.16, xRear: -2.16, axleF: 1.345, axleR: -1.345, track: 0.76, wheelR: 0.32 },
  lines: {
    bumperFront: 1.94, cowl: 0.62, doorFront: 0.56, roofFront: -0.05, doorSplit: -0.42, roofRear: -1.32,
    doorRear: -1.26, trunkFront: -1.95, bumperRear: -1.99, sill: 0.26, belt: 0.9, bumperTopF: 0.5,
    bumperTopR: 0.45, hoodHw: 0.72, trunkHw: 0.55,
  },
  paint: ['Body'],
  parts: { p0: { n: 'Body', k: 'paint', m: 'Body' } },
});
const profileOf = (glb: Uint8Array): Profile => {
  const raw = (splitGlb(glb).json.extras as { shtbox?: unknown } | undefined)?.shtbox;
  return raw ? parseProfile(raw) : testProfile();
};

describe('zoneset', () => {
  it('седан → полный набор, id уникальны', () => {
    const z = zonesFor('sedan', 'front');
    expect(new Set(z.map((x) => x.id)).size).toBe(z.length);
    expect(z.map((x) => x.id)).toEqual(expect.arrayContaining(['hood', 'trunk', 'door_fl', 'door_rr', 'rear_glass', 'engine_bay']));
  });
  it('купе без задних дверей, хэтчбек без заднего стекла', () => {
    const c = zonesFor('coupe', 'front').map((x) => x.id);
    expect(c).not.toContain('door_rl');
    expect(c).toContain('door_fr');
    expect(zonesFor('hatch', 'front').map((x) => x.id)).not.toContain('rear_glass');
  });
  it('задний мотор: моторный отсек открывается через крышку, багажник — через капот', () => {
    const z = Object.fromEntries(zonesFor('coupe', 'rear').map((x) => [x.id, x]));
    expect(z.engine_bay.requiresOpen).toBe('trunk');
    expect(z.trunk_bay.requiresOpen).toBe('hood');
    const f = Object.fromEntries(zonesFor('coupe', 'front').map((x) => [x.id, x]));
    expect(f.engine_bay.requiresOpen).toBe('hood');
  });
  it('направления бейджей', () => {
    expect(facingOf('hood', 'sedan')).toEqual([0, 1, 0]);
    expect(facingOf('door_fl', 'sedan')?.[2]).toBe(-1);
    expect(facingOf('door_fr', 'sedan')?.[2]).toBe(1);
  });
  it('remapZone: у купе задние двери → передние', () => {
    expect(remapZone('door_rl', 'coupe')).toBe('door_fl');
    expect(remapZone('door_rl', 'sedan')).toBe('door_rl');
  });
});

describe('frame', () => {
  it('поворот на 180° и масштаб', () => {
    const t = xform({ yaw: 180, scale: 2, offset: [1, 0, 0] });
    const p = t(1, 1, 0.5);
    expect(p[0]).toBeCloseTo(-1, 5);
    expect(p[1]).toBeCloseTo(2, 5);
    expect(p[2]).toBeCloseTo(-1, 5);
  });
  it('transformed согласован с xform', () => {
    const f = { yaw: 90, scale: 0.5, offset: [0, 1, 2] as [number, number, number] };
    const out = transformed(new Float32Array([1, 2, 3]), f);
    expect([...out]).toEqual(xform(f)(1, 2, 3).map((v) => Math.fround(v)));
  });
});

describe('generic panel regions', () => {
  it('routes side and top projections while rejecting points outside the hand-authored masks', () => {
    const profile = testProfile();
    profile.panelRegions = [
      {
        zone: 'door_fl', projection: 'side', side: 'left', minAbsZ: 0.5, kinds: ['paint', 'trim'],
        points: [[-0.75, 0.33], [0.5, 0.33], [0.5, 0.88], [-0.75, 0.88]],
      },
      {
        zone: 'hood', projection: 'top', minNormalY: 0.16, kinds: ['paint'],
        points: [[0.8, -0.45], [1.95, -0.45], [1.95, 0.45], [0.8, 0.45]],
      },
    ];
    const normalized = parseProfile(profile);
    const zoner = makeZoner(normalized);

    expect(zoner.paint([0, 0.62, -0.7], [0, 0, -1])).toBe('door_fl');
    expect(zoner.trim([0, 0.62, -0.7], [0, 0, -1])).toBe('door_fl');
    expect(zoner.paint([0, 0.62, -0.25], [0, 0, -1])).not.toBe('door_fl');
    expect(zoner.paint([1.2, 0.85, 0], [0, 1, 0])).toBe('hood');
    expect(zoner.paint([1.2, 0.85, 0.7], [0, 1, 0])).not.toBe('hood');
    expect(normalized.panelRegions).toEqual(profile.panelRegions);
  });
});

describe('profile / container', () => {
  it('базовый профиль проходит валидацию и содержит размеры модели', () => {
    const p = parseProfile(profileOf(pkg()));
    expect(p.body).toBe('hatch');
    expect(p.layout).toBe('front');
    expect(p.paint.length).toBeGreaterThan(0);
    expect(Object.keys(p.parts).length).toBeGreaterThan(0);
    expect(p.dims.L).toBeGreaterThan(4);
    expect(p.provenance).toEqual({ dimensions: 'auto', dimensionsConfidence: 'low', panelBoundaries: 'auto', panelBoundariesConfidence: 'low' });
  });
  it('parseProfile отвергает мусор и подделку', () => {
    const good = profileOf(pkg());
    expect(() => parseProfile(null)).toThrow();
    expect(() => parseProfile({ ...good, v: 2 })).toThrow();
    expect(() => parseProfile({ ...good, body: 'truck' })).toThrow();
    expect(() => parseProfile({ ...good, frame: { ...good.frame, yaw: 45 } })).toThrow();
    expect(() => parseProfile({ ...good, parts: { '../x': { n: 'a', k: 'paint', m: 'm' } } })).toThrow();
    expect(() => parseProfile({ ...good, parts: { p1: { n: 'a', k: 'evil', m: 'm' } } })).toThrow();
    expect(() => parseProfile({ ...good, lines: { ...good.lines, cowl: 'NaN' } })).toThrow();
    expect(() => parseProfile({ ...good, panelRegions: [{ zone: 'door_fl', projection: 'side', points: [[0, 0], [1, 0]] }] })).toThrow();
    expect(() => parseProfile({ ...good, panelRegions: [{ zone: 'door_fl', projection: 'side', side: 'up', points: [[0, 0], [1, 0], [0, 1]] }] })).toThrow();
    expect(() => parseProfile({ ...good, panelRegions: [{ zone: '', projection: 'side', points: [[0, 0], [1, 0], [0, 1]] }] })).toThrow();
    expect(() => parseProfile({ ...good, provenance: { dimensions: 'guess', panelBoundaries: 'oem' } })).toThrow();
    const olderProvenance = parseProfile({ ...good, provenance: { dimensions: 'oem', panelBoundaries: 'document' } });
    expect(olderProvenance.provenance?.dimensionsConfidence).toBe('high');
    expect(olderProvenance.provenance?.panelBoundariesConfidence).toBe('medium');
  });
  it('patchProfile подменяет только разметку и сохраняет геометрию', () => {
    const src = pkg();
    const p = profileOf(src);
    const edited: Profile = { ...p, layout: 'rear', lines: { ...p.lines, cowl: p.lines.cowl + 0.1 }, credits: { author: 'Тест', license: 'CC0' }, provenance: { dimensions: 'document', dimensionsConfidence: 'high', panelBoundaries: 'manual', panelBoundariesConfidence: 'medium', reference: 'CoC №123' } };
    const out = patchProfile(src, edited);
    const a = splitGlb(src);
    const b = splitGlb(out);
    expect(Buffer.from(b.bin!).equals(Buffer.from(a.bin!))).toBe(true);
    expect(b.json.meshes).toEqual(a.json.meshes);
    const q = profileOf(out);
    expect(q.layout).toBe('rear');
    expect(q.lines.cowl).toBeCloseTo(p.lines.cowl + 0.1, 6);
    expect(q.credits?.author).toBe('Тест');
    expect(q.provenance).toEqual({ dimensions: 'document', dimensionsConfidence: 'high', panelBoundaries: 'manual', panelBoundariesConfidence: 'medium', reference: 'CoC №123' });
    expect(guessCredits(out)?.author).toBe('Тест — CC0');
    // повторная правка не копит мусор и остаётся корректным GLB
    expect(profileOf(patchProfile(out, p)).layout).toBe('front');
  });
  it('splitGlb отвергает не-GLB', () => {
    expect(() => splitGlb(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toThrow();
  });
});
