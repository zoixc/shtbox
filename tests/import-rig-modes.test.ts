import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { Box3, Vector3 } from 'three';
import { analyze } from '../src/import/analyze';
import { readModel, writePackage } from '../src/import/glb';
import { createImportedRig, INTERIOR_ZONES, parsePackage } from '../src/models/imported';
import type { InteriorMode, Profile, RawPart } from '../src/import/types';
import type { ModelRig } from '../src/models/types';

/** GLTFLoader в Node требует заглушки декодера картинок (как в tests/model.test.ts). */
function stubs() {
  (globalThis as Record<string, unknown>).self ??= globalThis;
  (globalThis as Record<string, unknown>).createImageBitmap ??= async () => ({ width: 2, height: 2, close() {} });
}

interface Fixture {
  parts: RawPart[];
  profile: Profile;
}

async function analyzed(): Promise<Fixture> {
  stubs();
  const buf = await readFile(new URL('../public/models/bmw116i.glb', import.meta.url));
  const data = new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const { parts } = await readModel(data);
  return { parts, profile: analyze(parts, 'BMW 116i') };
}

/** Путь мастера: профиль → пакет → сцена, имена деталей которой совпадают с профилем. */
async function rigOf(fx: Fixture, interior: InteriorMode): Promise<ModelRig> {
  const glb = await writePackage(fx.parts, { ...fx.profile, interior });
  const data = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer;
  const { scene, profile } = await parsePackage(data);
  expect(profile.interior).toBe(interior); // режим салона переживает запись и чтение пакета
  return createImportedRig(scene, profile, '#e6e9ec');
}

const interiorZones = (rig: ModelRig) => [...rig.pick.keys()].filter((z) => INTERIOR_ZONES.has(z)).sort();
const vertices = (rig: ModelRig, zone: string) =>
  (rig.pick.get(zone) ?? []).reduce(
    (n, o) => n + ((o as { geometry?: { attributes?: { position?: { count: number } } } }).geometry?.attributes?.position?.count ?? 0),
    0,
  );

describe('салон импортированной модели', () => {
  it('детали салона из модели попадают в узлы салона', async () => {
    const fx = await analyzed();
    expect(Object.values(fx.profile.parts).filter((p) => p.k === 'int').length).toBeGreaterThan(5);
    const rig = await rigOf(fx, 'fill');
    const zones = interiorZones(rig);
    expect(zones.length).toBeGreaterThan(2);
    for (const zone of zones) expect(rig.pick.get(zone)!.length).toBeGreaterThan(0);
  });

  it('«только модель» оставляет модельный салон, «процедурный» заменяет, «без салона» убирает', async () => {
    const fx = await analyzed();
    const modelRig = await rigOf(fx, 'model');
    const fillRig = await rigOf(fx, 'fill');
    const templateRig = await rigOf(fx, 'template');
    const noneRig = await rigOf(fx, 'none');

    // Модельный салон: узлы салона есть, а «достроить» не выдумывает лишнего поверх него.
    const model = interiorZones(modelRig);
    expect(model.length).toBeGreaterThan(2);
    expect(interiorZones(fillRig)).toEqual(model);
    // «Без салона» — узлов салона нет вовсе.
    expect(interiorZones(noneRig)).toEqual([]);
    // «Заменить процедурным» — те же узлы, но уже другие детали.
    const template = interiorZones(templateRig);
    expect(template.length).toBeGreaterThan(2);
    for (const zone of model) {
      if (!template.includes(zone)) continue;
      expect(vertices(templateRig, zone), zone).not.toBe(vertices(modelRig, zone));
    }
  });

  it('если в модели салона нет, «достроить» подставляет процедурный, а «только модель» — нет', async () => {
    const fx = await analyzed();
    // Прячем всё, что распознано как салон: модель без салона.
    const bare: Profile = {
      ...fx.profile,
      parts: Object.fromEntries(Object.entries(fx.profile.parts).map(([id, i]) => [id, i.k === 'int' ? { ...i, k: 'hide' as const } : i])),
    };
    const fillRig = await rigOf({ ...fx, profile: bare }, 'fill');
    const modelRig = await rigOf({ ...fx, profile: bare }, 'model');

    expect(interiorZones(fillRig)).toEqual([...INTERIOR_ZONES].sort());
    expect(interiorZones(modelRig)).toEqual([]);
  });
});

describe('петли кузовных панелей', () => {
  it('петля двери стоит на передней кромке панели, а правки из профиля её двигают', async () => {
    const fx = await analyzed();
    const door = (await rigOf(fx, 'model')).openables.get('door_fl')!;
    expect(Math.abs(door.axis.y)).toBeCloseTo(1, 5); // вертикальная ось шарнира
    expect(door.pivot.position.x).toBeGreaterThan(0);

    const manual = { ...fx.profile, hinges: { door_fl: { x: 0.1, y: 0.5, z: -0.85, axis: 'z' as const, angle: 0.8 } } };
    const door2 = (await rigOf({ ...fx, profile: manual }, 'model')).openables.get('door_fl')!;
    expect(door2.pivot.position.x).toBeCloseTo(0.1, 5);
    expect(door2.pivot.position.y).toBeCloseTo(0.5, 5);
    expect(door2.pivot.position.z).toBeCloseTo(-0.85, 5);
    expect(Math.abs(door2.axis.z)).toBeCloseTo(1, 5);
    expect(door2.angle).toBeCloseTo(0.8, 5);
  });

  it('дверь, найденная отдельной деталью, открывается целиком и по своим кромкам', async () => {
    const fx = await analyzed();
    const rig = await rigOf(fx, 'model');
    const door = rig.openables.get('door_fl')!;
    const parts = rig.pick.get('door_fl')!;
    expect(parts.length).toBeGreaterThan(0);
    for (const part of parts) expect(part.parent?.parent).toBe(door.pivot);
    // панель целиком уходит в шарнир: это кромка двери, а не весь борт кузова
    const box = new Box3();
    for (const part of parts) box.expandByObject(part);
    const size = box.getSize(new Vector3());
    expect(size.x).toBeGreaterThan(0.8);
    expect(size.x).toBeLessThan(1.4);
    // петля — на передней кромке панели
    expect(door.pivot.position.x).toBeCloseTo(box.max.x, 2);
  });
});
