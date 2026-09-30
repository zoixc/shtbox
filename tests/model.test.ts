import { describe, expect, it } from 'vitest';
import { Box3, Group, Vector3 } from 'three';
import type { Mesh, MeshPhysicalMaterial } from 'three';
import { readFile } from 'node:fs/promises';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createBmw116i, mergeRigs } from '../src/models/hatch/hybrid';
import { BMW116I_SPEC, bmw116iLite } from '../src/models/hatch/bmw116i';
import { BMW116I_E81_DIMENSIONS, BMW116I_E81_SPEC, BMW116I_E81_ZONES } from '../src/models/hatch/bmw116i-e81';
import { fitProcedural } from '../src/models/imported';
import { buildSedan } from '../src/models/sedan/build';
import type { ModelRig } from '../src/models/types';
import type { Profile } from '../src/import/types';
import { getModel, listModels } from '../src/models/registry';
import { BodyLoft, buildGrid, buildStations, pchip } from '../src/models/sedan/loft';
import { SOLARIS_I_DIMENSIONS, SOLARIS_SPEC } from '../src/models/sedan/solaris';

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

  it('models the first-generation Solaris to its published 2011–2014 dimensions', () => {
    expect(SOLARIS_SPEC.style).toBe('solaris-i-2011');
    const bodyGrid = buildGrid(
      new BodyLoft(SOLARIS_SPEC.body),
      buildStations(SOLARIS_SPEC.xFront, SOLARIS_SPEC.xRear, Object.values(SOLARIS_SPEC.x)),
    );
    const bodyBounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
    for (let i = 0; i < bodyGrid.pos.length; i += 3) {
      bodyBounds.minX = Math.min(bodyBounds.minX, bodyGrid.pos[i]);
      bodyBounds.maxX = Math.max(bodyBounds.maxX, bodyGrid.pos[i]);
      bodyBounds.minY = Math.min(bodyBounds.minY, bodyGrid.pos[i + 1]);
      bodyBounds.maxY = Math.max(bodyBounds.maxY, bodyGrid.pos[i + 1]);
      bodyBounds.minZ = Math.min(bodyBounds.minZ, bodyGrid.pos[i + 2]);
      bodyBounds.maxZ = Math.max(bodyBounds.maxZ, bodyGrid.pos[i + 2]);
    }
    expect(bodyBounds.maxX - bodyBounds.minX).toBeCloseTo(SOLARIS_I_DIMENSIONS.length, 6);
    expect(bodyBounds.maxY).toBeCloseTo(SOLARIS_I_DIMENSIONS.height, 4);
    expect(bodyBounds.minY).toBeCloseTo(SOLARIS_I_DIMENSIONS.groundClearance, 4);
    expect(bodyBounds.maxZ - bodyBounds.minZ).toBeCloseTo(SOLARIS_I_DIMENSIONS.width, 4);
    const fullRig = buildSedan(SOLARIS_SPEC, '#b9bec6');
    const fullSize = new Box3().setFromObject(fullRig.root).getSize(new Vector3());
    expect(fullSize.x).toBeLessThan(SOLARIS_I_DIMENSIONS.length + 0.01);
    fullRig.dispose();
    expect(SOLARIS_SPEC.xFront - SOLARIS_SPEC.xRear).toBeCloseTo(SOLARIS_I_DIMENSIONS.length, 6);
    expect(SOLARIS_SPEC.frontAxleX - SOLARIS_SPEC.rearAxleX).toBeCloseTo(SOLARIS_I_DIMENSIONS.wheelbase, 6);
    expect(SOLARIS_SPEC.xFront - SOLARIS_SPEC.frontAxleX).toBeCloseTo(SOLARIS_I_DIMENSIONS.frontOverhang, 6);
    expect(SOLARIS_SPEC.rearAxleX - SOLARIS_SPEC.xRear).toBeCloseTo(SOLARIS_I_DIMENSIONS.rearOverhang, 6);
    expect(SOLARIS_SPEC.trackHalf * 2).toBeCloseTo((SOLARIS_I_DIMENSIONS.frontTrack + SOLARIS_I_DIMENSIONS.rearTrack) / 2, 6);
    expect(SOLARIS_SPEC.frontTrackHalf! * 2).toBeCloseTo(SOLARIS_I_DIMENSIONS.frontTrack, 6);
    expect(SOLARIS_SPEC.rearTrackHalf! * 2).toBeCloseTo(SOLARIS_I_DIMENSIONS.rearTrack, 6);
    expect(SOLARIS_SPEC.wheelR).toBeCloseTo((15 * 25.4 + 2 * 185 * 0.65) / 2000, 6);
  });

  it('models the E81 BMW Lite as a three-door 116i with the published envelope', () => {
    expect(bmw116iLite.name).toContain('E81');
    expect(bmw116iLite.zones).toEqual(BMW116I_E81_ZONES);
    expect(bmw116iLite.defaultMaintenance?.[0].notes).toContain('N43');
    expect(bmw116iLite.defaultMaintenance?.find((task) => task.title === 'Замена масла в КПП')?.notes).not.toContain('ZF 8HP');
    expect(BMW116I_SPEC.frontAxleX).toBeCloseTo(1.345, 6); // the detailed F20 hybrid spec is unchanged
    expect(BMW116I_E81_SPEC.style).toBe('bmw-e81-2009');
    expect(BMW116I_E81_SPEC.sideDoors).toBe(3);
    expect(BMW116I_E81_SPEC.tail).toBe('hatch');
    expect(BMW116I_E81_ZONES.some((zone) => zone.id === 'door_rl' || zone.id === 'door_rr')).toBe(false);
    const bodyGrid = buildGrid(
      new BodyLoft(BMW116I_E81_SPEC.body),
      buildStations(BMW116I_E81_SPEC.xFront, BMW116I_E81_SPEC.xRear, Object.values(BMW116I_E81_SPEC.x)),
    );
    const bodyBounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
    for (let i = 0; i < bodyGrid.pos.length; i += 3) {
      bodyBounds.minX = Math.min(bodyBounds.minX, bodyGrid.pos[i]);
      bodyBounds.maxX = Math.max(bodyBounds.maxX, bodyGrid.pos[i]);
      bodyBounds.minY = Math.min(bodyBounds.minY, bodyGrid.pos[i + 1]);
      bodyBounds.maxY = Math.max(bodyBounds.maxY, bodyGrid.pos[i + 1]);
      bodyBounds.minZ = Math.min(bodyBounds.minZ, bodyGrid.pos[i + 2]);
      bodyBounds.maxZ = Math.max(bodyBounds.maxZ, bodyGrid.pos[i + 2]);
    }
    expect(bodyBounds.maxX - bodyBounds.minX).toBeCloseTo(BMW116I_E81_DIMENSIONS.length, 6);
    expect(bodyBounds.maxY).toBeCloseTo(BMW116I_E81_DIMENSIONS.height, 4);
    expect(bodyBounds.minY).toBeCloseTo(BMW116I_E81_DIMENSIONS.groundClearance, 4);
    expect(bodyBounds.maxZ - bodyBounds.minZ).toBeCloseTo(BMW116I_E81_DIMENSIONS.width, 4);
    expect(BMW116I_E81_SPEC.frontAxleX - BMW116I_E81_SPEC.rearAxleX).toBeCloseTo(BMW116I_E81_DIMENSIONS.wheelbase, 6);
    expect(BMW116I_E81_SPEC.xFront - BMW116I_E81_SPEC.xRear).toBeCloseTo(BMW116I_E81_DIMENSIONS.length, 6);
    expect(BMW116I_E81_SPEC.frontTrackHalf! * 2).toBeCloseTo(BMW116I_E81_DIMENSIONS.frontTrack, 6);
    expect(BMW116I_E81_SPEC.rearTrackHalf! * 2).toBeCloseTo(BMW116I_E81_DIMENSIONS.rearTrack, 6);
    expect(BMW116I_E81_SPEC.wheelR).toBeCloseTo((16 * 25.4 + 2 * 195 * 0.55) / 2000, 6);

    const rig = buildSedan(BMW116I_E81_SPEC, '#e6e9ec');
    expect([...rig.openables.keys()].sort()).toEqual(['door_fl', 'door_fr', 'hood', 'trunk']);
    expect(rig.pick.get('door_rr')).toBeUndefined();
    expect(rig.pick.get('door_rl')).toBeUndefined();
    expect(rig.pick.get('seat_r')).toHaveLength(5); // two rear positions: cushion, backrest, base and two headrests
    const quarter = rig.pick.get('quarter_rr') ?? [];
    expect(quarter.some((object) => (object as Mesh).isMesh && ((object as Mesh).material as MeshPhysicalMaterial).opacity === 0.78)).toBe(true); // fixed, non-opening quarter glass
    const fullSize = new Box3().setFromObject(rig.root).getSize(new Vector3());
    expect(fullSize.x).toBeLessThan(BMW116I_E81_DIMENSIONS.length + 0.01);
    rig.dispose();
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

/** fetch() для пакетов из public/ (в Node относительные URL не работают). */
function stubFetch() {
  (globalThis as Record<string, unknown>).self ??= globalThis;
  (globalThis as Record<string, unknown>).createImageBitmap ??= async () => ({ width: 2, height: 2, close() {} });
  (globalThis as Record<string, unknown>).fetch = async (u: string) => {
    const b = await readFile(new URL(`../public${u}`, import.meta.url));
    return { ok: true, status: 200, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
  };
}

describe('model registry contract', () => {
  it('ships only the maintained built-in models; extra models remain user-imported', () => {
    expect(listModels().map((model) => model.id)).toEqual(['hatch-bmw116i', 'sedan-solaris', 'hatch-bmw116i-lite']);
  });

  it('does not display an unrelated built-in when a saved model id is unavailable', async () => {
    const missing = getModel('legacy-model-not-installed');
    expect(missing.id).toBe('legacy-model-not-installed');
    expect(missing.zones).toEqual([]);
    const rig = await missing.create('#ffffff');
    expect(rig.root.children).toHaveLength(0);
    rig.dispose();
  });

  for (const def of listModels()) {
    it(`${def.id}: every zone has 3D geometry, paintable zones have paint meshes`, async () => {
      stubFetch();
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

describe('imported-model bay fit', () => {
  it('keeps generated bay floors inside the body cross-section', () => {
    const rig = buildSedan(BMW116I_SPEC, '#ffffff');
    const loft = new BodyLoft(BMW116I_SPEC.body);
    const engineFloor = rig.pick.get('engine_bay')?.find((o) => (o as Mesh).name === 'engine_bay:floor') as Mesh;
    const trunkFloor = rig.pick.get('trunk_bay')?.find((o) => (o as Mesh).name === 'trunk_bay:floor') as Mesh;
    const shelf = rig.pick.get('trunk_bay')?.find((o) => (o as Mesh).name === 'trunk_bay:shelf') as Mesh;
    for (const floor of [engineFloor, trunkFloor, shelf]) {
      expect(floor).toBeTruthy();
      const p = floor.geometry.getAttribute('position');
      for (let i = 0; i < p.count; i++) expect(Math.abs(p.getZ(i))).toBeLessThanOrEqual(loft.sideZ(p.getX(i), p.getY(i)) + 1e-5);
    }
    rig.dispose();
  });

  it('mirrors and removes every generated bay surface according to its zone', () => {
    const proc = buildSedan(BMW116I_SPEC, '#ffffff');
    const trunkBay = proc.pick.get('trunk_bay')!;
    expect(trunkBay).toHaveLength(4); // bulkhead, shelf, floor, spare wheel
    const rearProfile = {
      layout: 'rear',
      dims: { L: 4.45, W: 1.83, H: 1.33, xFront: 2.2, xRear: -2.2, axleF: 1.18, axleR: -1.18, track: 0.75, wheelR: 0.33 },
    } as unknown as Profile;
    fitProcedural(proc, rearProfile, new Set(['trunk_bay']));
    expect(proc.anchors.get('trunk_bay')!.position.x).toBeGreaterThan(0);
    for (const o of trunkBay) {
      let p = o.parent;
      let mirrored = false;
      while (p) {
        if (p.scale.x === -1) mirrored = true;
        p = p.parent;
      }
      expect(mirrored).toBe(true);
    }

    const emptyRig = (): ModelRig => ({
      root: new Group(), paint: new Map(), pick: new Map(), openables: new Map(), anchors: new Map(), facing: new Map(), shell: [],
      setColor: () => {}, bounds: { center: [0, 0, 0], radius: 1 }, dispose: () => {},
    });
    const defaultMerge = mergeRigs(emptyRig(), buildSedan(BMW116I_SPEC, '#ffffff'), new Set(['engine_bay']));
    expect(defaultMerge.root.getObjectByName('engine_bay:bulkhead')).toBeTruthy();
    defaultMerge.dispose();

    const merged = mergeRigs(emptyRig(), proc, new Set(['engine_bay']), new Set(['engine_bay:bulkhead']));
    const visible = new Set<object>();
    merged.root.traverse((o) => visible.add(o));
    expect(trunkBay.some((o) => visible.has(o))).toBe(false);
    expect(merged.root.getObjectByName('engine_bay:bulkhead')).toBeUndefined();
    expect(merged.root.getObjectByName('engine_bay:floor')).toBeTruthy();
    expect(merged.pick.has('trunk_bay')).toBe(false);
    merged.dispose();
  });
});

describe('procedural exhaust side', () => {
  it('keeps the default exhaust on +Z and mirrors it to −Z when requested', () => {
    for (const side of [1, -1] as const) {
      const spec = side === 1 ? BMW116I_SPEC : { ...BMW116I_SPEC, exhaustSide: -1 as const };
      const rig = buildSedan(spec, '#ffffff');
      expect(side * rig.anchors.get('exhaust')!.position.z).toBeGreaterThan(0);
      for (const part of rig.pick.get('exhaust') ?? []) {
        const bounds = new Box3().setFromObject(part);
        if (side === 1) expect(bounds.min.z).toBeGreaterThan(0);
        else expect(bounds.max.z).toBeLessThan(0);
      }
      rig.dispose();
    }
  });
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
    const paintMesh = rig.paint.values().next().value as Mesh | undefined;
    const paintMaterial = paintMesh?.material as MeshPhysicalMaterial | undefined;
    // у гибридного BMW кузов из GLB окрашен пресетом «матовый» (см. FINISH в paintMaterial.ts)
    expect(paintMaterial?.roughness).toBeCloseTo(0.78);
    expect(paintMaterial?.metalness).toBeCloseTo(0.02);
    expect(paintMaterial?.clearcoat).toBeCloseTo(0.06);

    // В кузовной модели выпуск на левой стороне (−Z); wall-bulkheads шаблона не должны выходить за неё.
    expect(rig.anchors.get('exhaust')!.position.z).toBeLessThan(0);
    const exhaust = rig.pick.get('exhaust') ?? [];
    expect(exhaust).toHaveLength(2);
    for (const part of exhaust) expect(new Box3().setFromObject(part).max.z).toBeLessThan(0);
    expect(rig.root.getObjectByName('engine_bay:bulkhead')).toBeUndefined();
    expect(rig.root.getObjectByName('trunk_bay:bulkhead')).toBeUndefined();
    expect(rig.root.getObjectByName('engine_bay:floor')).toBeTruthy();
    expect(rig.root.getObjectByName('trunk_bay:floor')).toBeTruthy();
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
