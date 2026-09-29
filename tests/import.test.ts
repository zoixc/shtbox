import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { patchProfile, splitGlb } from '../src/import/container';
import { guessCredits } from '../src/import/pipeline';
import { transformed, xform } from '../src/import/frame';
import { parseProfile } from '../src/import/profile';
import { remapZone } from '../src/import/partition';
import { facingOf, zonesFor } from '../src/import/zoneset';
import type { Profile } from '../src/import/types';

const pkg = () => new Uint8Array(readFileSync('public/models/porsche-930.glb'));
const profileOf = (glb: Uint8Array): Profile => parseProfile((splitGlb(glb).json.extras as { shtbox: unknown }).shtbox);

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

describe('profile / container', () => {
  it('демо-пакет читается и проходит валидацию', () => {
    const p = profileOf(pkg());
    expect(p.body).toBe('coupe');
    expect(p.layout).toBe('rear');
    expect(p.paint.length).toBeGreaterThan(0);
    expect(Object.keys(p.parts).length).toBeGreaterThan(5);
    expect(p.dims.L).toBeGreaterThan(4);
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
  });
  it('patchProfile подменяет только разметку и сохраняет геометрию', () => {
    const src = pkg();
    const p = profileOf(src);
    const edited: Profile = { ...p, layout: 'front', lines: { ...p.lines, cowl: p.lines.cowl + 0.1 }, credits: { author: 'Тест', license: 'CC0' } };
    const out = patchProfile(src, edited);
    const a = splitGlb(src);
    const b = splitGlb(out);
    expect(Buffer.from(b.bin!).equals(Buffer.from(a.bin!))).toBe(true);
    expect(b.json.meshes).toEqual(a.json.meshes);
    const q = profileOf(out);
    expect(q.layout).toBe('front');
    expect(q.lines.cowl).toBeCloseTo(p.lines.cowl + 0.1, 6);
    expect(q.credits?.author).toBe('Тест');
    expect(guessCredits(out)?.author).toBe('Тест — CC0');
    // повторная правка не копит мусор и остаётся корректным GLB
    expect(profileOf(patchProfile(out, p)).layout).toBe('rear');
  });
  it('splitGlb отвергает не-GLB', () => {
    expect(() => splitGlb(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toThrow();
  });
});
