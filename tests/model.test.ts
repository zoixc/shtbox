import { describe, expect, it } from 'vitest';
import { Box3, Vector3 } from 'three';
import type { Mesh } from 'three';
import { readFile } from 'node:fs/promises';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createBmw116i } from '../src/models/hatch/hybrid';
import { listModels } from '../src/models/registry';
import { BodyLoft, buildGrid, buildStations, pchip } from '../src/models/sedan/loft';
import { SOLARIS_SPEC } from '../src/models/sedan/solaris';

describe('pchip', () => {
  it('is monotone and hits keys (descending x)', () => {
    const f = pchip([3, 2, 1, 0], [10, 10, 4, 0]);
    expect(f(3)).toBeCloseTo(10);
    expect(f(0)).toBeCloseTo(0);
    let prev = f(0);
    for (let x = 0.1; x <= 3; x += 0.1) {
      expect(f(x)).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = f(x);
    }
  });
});

describe('sedan loft', () => {
  it('has finite geometry and outward normals on top', () => {
    const loft = new BodyLoft(SOLARIS_SPEC.body);
    const g = buildGrid(loft, buildStations(2.2, -2.2, [1.98, 0.72, -0.32]));
    expect(g.pos.every(Number.isFinite)).toBe(true);
    expect(g.nrm.every(Number.isFinite)).toBe(true);
    // вершина на крыше — нормаль смотрит вверх
    const i = g.idx(-0.2);
    const top = (i * 49 + 24) * 3;
    expect(g.nrm[top + 1]).toBeGreaterThan(0.8);
  });
});

/** Загружает GLB с диска (в Node нет DOM-декодера картинок — подставляем заглушку). */
async function loadFromDisk(url: string) {
  (globalThis as Record<string, unknown>).self ??= globalThis;
  (globalThis as Record<string, unknown>).createImageBitmap ??= async () => ({ width: 2, height: 2, close() {} });
  const buf = await readFile(new URL(`../public${url}`, import.meta.url));
  const gltf = await new GLTFLoader().parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, '');
  return gltf.scene;
}

describe('model registry contract', () => {
  for (const def of listModels()) {
    it(`${def.id}: every zone has 3D geometry, paintable zones have paint meshes`, async () => {
      const rig = def.id === 'hatch-bmw116i' ? await createBmw116i(def.defaultColor, loadFromDisk) : await def.create(def.defaultColor);
      const ids = new Set(def.zones.map((z) => z.id));
      expect(ids.size).toBe(def.zones.length); // уникальные id
      for (const z of def.zones) {
        if (z.virtual) continue;
        expect(rig.pick.has(z.id), `pick:${z.id}`).toBe(true);
        expect(rig.anchors.has(z.id), `anchor:${z.id}`).toBe(true);
        if (z.paintable) expect(rig.paint.has(z.id), `paint:${z.id}`).toBe(true);
        if (z.openable) expect(rig.openables.has(z.id), `open:${z.id}`).toBe(true);
        if (z.requiresOpen) expect(def.zones.find((x) => x.id === z.requiresOpen)?.openable).toBe(true);
      }
      for (const m of rig.paint.values()) expect((m as Mesh).geometry.getAttribute('position').count).toBeGreaterThan(0);
      for (const t of def.defaultMaintenance) expect(ids.has(t.zoneId), `task zone ${t.zoneId}`).toBe(true);
      rig.dispose();
    });
  }
});

describe('BMW 116i: GLB + процедурные агрегаты', () => {
  it('бюджет файла и атрибуция в самом GLB', async () => {
    const buf = await readFile(new URL('../public/models/bmw116i.glb', import.meta.url));
    expect(buf.length).toBeLessThan(5_000_000);
    const jsonLen = buf.readUInt32LE(12);
    const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
    expect(json.asset.copyright).toMatch(/Peter Stephan.*CC-BY-4\.0/);
    expect(json.extensionsRequired).toBeUndefined(); // никаких spec-gloss
    expect(json.materials.length).toBeLessThan(30);
  });

  it('открываются капот, дверь хэтча и 4 двери; процедурной остаётся только «начинка»', async () => {
    const rig = await createBmw116i('#e6e9ec', loadFromDisk);
    expect([...rig.openables.keys()].sort()).toEqual(['door_fl', 'door_fr', 'door_rl', 'door_rr', 'hood', 'trunk']);
    // окрашиваемые детали — один меш на узел, в системе координат авто (метры)
    for (const m of rig.paint.values()) {
      const g = (m as Mesh).geometry;
      g.computeBoundingBox();
      expect(g.boundingBox!.getSize(new Vector3()).length()).toBeLessThan(6);
    }
    // габариты: ≈ 4.3 м в длину (по X), колёса на земле
    const box = new Box3().setFromObject(rig.root);
    const size = box.getSize(new Vector3());
    expect(size.x).toBeGreaterThan(4.1);
    expect(size.x).toBeLessThan(4.6);
    expect(box.min.y).toBeGreaterThan(-0.05);
    // двери открываются наружу: левая (−Z) уходит в −Z, правая — в +Z
    const fl = rig.openables.get('door_fl')!;
    const fr = rig.openables.get('door_fr')!;
    expect(Math.sign(fl.angle)).toBe(-1);
    expect(Math.sign(fr.angle)).toBe(1);
    expect(fl.pivot.position.z).toBeLessThan(0);
    rig.dispose();
  });
});
