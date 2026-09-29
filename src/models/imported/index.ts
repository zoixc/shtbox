/**
 * Модели, собранные из пользовательского GLB: загрузка пакета, сборка и регистрация в реестре.
 */
import { Group, Object3D } from 'three';
import { parseProfile } from '../../import/profile';
import type { Profile } from '../../import/types';
import { zonesFor } from '../../import/zoneset';
import { BMW116I_SPEC } from '../hatch/bmw116i';
import { mergeRigs } from '../hatch/hybrid';
import { buildSedan } from '../sedan/build';
import type { CarModelDef, ModelRig, TaskTemplate } from '../types';
import { buildImportedParts } from './rig';

/** Процедурный шаблон (BMW 116i): колёсная база, высота и ширина — для подгонки. */
const TEMPLATE = { wheelbase: 2.69, H: 1.421, W: 1.765 };
/** Узлы «начинки», которые при заднем расположении двигателя зеркалятся по оси автомобиля. */
const MIRROR = ['engine_bay', 'trunk_bay', 'engine', 'gearbox', 'cooling', 'battery', 'electrics', 'exhaust', 'fuel_tank'];

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

/** Собирает модель: детали из файла + процедурная начинка для недостающих узлов. */
export function createImportedRig(scene: Object3D, pr: Profile, color: string): ModelRig {
  const parts = buildImportedParts(scene, pr, color);
  const missing = new Set(parts.zones.filter((z) => !z.virtual && !parts.covered.has(z.id)).map((z) => z.id));
  if (!missing.size) return parts.rig;
  const proc = buildSedan(BMW116I_SPEC, color);
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

export const GENERIC_MAINTENANCE: TaskTemplate[] = [
  { zoneId: 'engine', title: 'Замена моторного масла и масляного фильтра', everyKm: 10000, everyMonths: 12, notes: 'Ориентир — уточняйте по сервисной книжке вашего автомобиля.' },
  { zoneId: 'engine', title: 'Воздушный фильтр двигателя', everyKm: 20000, everyMonths: 24 },
  { zoneId: 'engine', title: 'Свечи зажигания', everyKm: 40000, everyMonths: 48 },
  { zoneId: 'cooling', title: 'Замена охлаждающей жидкости', everyKm: 90000, everyMonths: 48 },
  { zoneId: 'gearbox', title: 'Замена масла в КПП', everyKm: 60000, everyMonths: 60 },
  { zoneId: 'brakes_f', title: 'Передние колодки и диски: осмотр', everyKm: 15000, everyMonths: 12 },
  { zoneId: 'brakes_r', title: 'Задние колодки и диски: осмотр', everyKm: 30000, everyMonths: 24 },
  { zoneId: 'general', title: 'Замена тормозной жидкости', everyMonths: 24 },
  { zoneId: 'susp_f', title: 'Диагностика подвески и рулевого', everyKm: 15000, everyMonths: 12 },
  { zoneId: 'battery', title: 'Проверка аккумулятора и клемм', everyMonths: 12 },
  { zoneId: 'wheel_fl', title: 'Ротация колёс / шиномонтаж (сезонная смена)', everyMonths: 6 },
  { zoneId: 'floor', title: 'Салонный фильтр', everyKm: 15000, everyMonths: 12 },
  { zoneId: 'general', title: 'Антикор / обработка кузова', everyMonths: 24 },
];

/** Описание модели в реестре. `load` отдаёт байты пакета (из /models/ или из IndexedDB). */
export function defineImportedModel(d: {
  id: string;
  name: string;
  description: string;
  shape: Pick<Profile, 'body' | 'layout'>;
  defaultColor?: string;
  maintenance?: TaskTemplate[];
  load: () => Promise<ArrayBuffer>;
}): CarModelDef {
  return {
    id: d.id,
    name: d.name,
    description: d.description,
    defaultColor: d.defaultColor ?? '#b9bec6',
    zones: zonesFor(d.shape.body, d.shape.layout),
    defaultMaintenance: d.maintenance ?? GENERIC_MAINTENANCE,
    create: async (color) => {
      const pkg = await parsePackage(await d.load());
      return createImportedRig(pkg.scene, pkg.profile, color);
    },
  };
}
