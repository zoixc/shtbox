/**
 * Модели, собранные из пользовательского GLB: загрузка пакета, сборка и регистрация в реестре.
 */
import { Group, Object3D } from 'three';
import { parseProfile } from '../../import/profile';
import type { Profile } from '../../import/types';
import { BMW116I_SPEC } from '../hatch/bmw116i';
import { mergeRigs } from '../hatch/hybrid';
import { buildSedan } from '../sedan/build';
import type { ModelRig } from '../types';
import { buildImportedParts } from './rig';
import type { PaintFinish } from '../../view3d/paintMaterial';

/** Процедурный шаблон (BMW 116i): колёсная база, высота и ширина — для подгонки. */
const TEMPLATE = { wheelbase: 2.69, H: 1.421, W: 1.765 };
/** Узлы «начинки», которые при заднем расположении двигателя зеркалятся по оси автомобиля. */
const MIRROR = ['engine_bay', 'trunk_bay', 'engine', 'gearbox', 'cooling', 'battery', 'electrics', 'exhaust', 'fuel_tank'];
/** Узлы салона: их наполняет либо модель, либо процедурный шаблон (см. `Profile.interior`). */
export const INTERIOR_ZONES: ReadonlySet<string> = new Set([
  'dashboard', 'steering', 'console', 'seat_fl', 'seat_fr', 'seat_r', 'floor', 'headliner',
]);

/** Подгоняет процедурный шаблон под размеры модели (аффинно по осям) и при необходимости зеркалит агрегаты. */
export function fitProcedural(proc: ModelRig, pr: Profile, missing: ReadonlySet<string>): void {
  const D = pr.dims;
  if (pr.layout === 'rear') {
    for (const z of MIRROR) {
      if (!missing.has(z)) continue;
      for (const o of proc.pick.get(z) ?? []) {
        const parent = o.parent;
        if (!parent) continue;
        const w = new Group();
        w.name = `${z}:mirror`;
        w.scale.x = -1;
        parent.add(w);
        w.add(o);
      }
      const a = proc.anchors.get(z);
      if (a) a.position.x = -a.position.x;
      const f = proc.facing.get(z);
      if (f) proc.facing.set(z, [-f[0], f[1], f[2]]);
    }
  }
  proc.root.scale.set((D.axleF - D.axleR) / TEMPLATE.wheelbase, D.H / TEMPLATE.H, D.W / TEMPLATE.W);
  proc.root.position.x = (D.axleF + D.axleR) / 2;
}

/** Убирает из собранной модели узлы целиком (нужно для режимов салона). */
function dropZones(rig: ModelRig, zones: ReadonlySet<string>): void {
  for (const zone of zones) {
    for (const object of rig.pick.get(zone) ?? []) {
      object.removeFromParent();
      object.traverse((o) => {
        const mesh = o as { isMesh?: boolean; geometry?: { dispose(): void } };
        if (mesh.isMesh) mesh.geometry?.dispose();
      });
    }
    rig.pick.delete(zone);
    rig.paint.delete(zone);
    rig.anchors.delete(zone);
    rig.facing.delete(zone);
    rig.openables.delete(zone);
  }
  rig.shell = rig.shell.filter((o) => !zones.has(o.name));
}

/**
 * Собирает модель: детали из файла + процедурная начинка для недостающих узлов.
 * Что делать с салоном, решает `Profile.interior`:
 *  `fill` — салон из модели, недостающие узлы достраиваются (по умолчанию);
 *  `model` — только то, что есть в модели; `template` — заменить салон процедурным шаблоном;
 *  `none` — салон не нужен.
 */
export function createImportedRig(scene: Object3D, pr: Profile, color: string, finish?: PaintFinish): ModelRig {
  const parts = buildImportedParts(scene, pr, color, finish);
  const mode = pr.interior ?? 'fill';
  if (mode === 'template' || mode === 'none') dropZones(parts.rig, INTERIOR_ZONES);
  const missing = new Set(parts.zones.filter((z) => !z.virtual && !parts.covered.has(z.id)).map((z) => z.id));
  if (mode === 'template') for (const zone of INTERIOR_ZONES) if (parts.zones.some((z) => z.id === zone)) missing.add(zone);
  if (mode === 'model' || mode === 'none') for (const zone of INTERIOR_ZONES) missing.delete(zone);
  if (!missing.size) return parts.rig;
  const proc = buildSedan(BMW116I_SPEC, color, finish ?? pr.finish ?? 'satin');
  fitProcedural(proc, pr, missing);
  return mergeRigs(parts.rig, proc, missing);
}

export interface Package {
  scene: Object3D;
  profile: Profile;
}

/** Разбирает пакет модели (GLB с `extras.shtbox`). */
export async function parsePackage(data: ArrayBuffer): Promise<Package> {
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const gltf = await new Promise<{ scene: Object3D; parser: { json: { extras?: { shtbox?: unknown } } } }>((res, rej) =>
    new GLTFLoader().parse(data, '', (g) => res(g as never), rej),
  );
  const raw = gltf.parser.json.extras?.shtbox;
  if (!raw) throw new Error('В GLB нет разметки shtbox (это не пакет модели)');
  return { scene: gltf.scene, profile: parseProfile(raw) };
}

