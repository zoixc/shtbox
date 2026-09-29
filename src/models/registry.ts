import type { CarModelDef, GltfModelDef } from './types';
import { bmw116i, bmw116iLite } from './hatch/bmw116i';
import { solaris } from './sedan/solaris';
import { defineImportedModel } from './imported/define';

/**
 * Реестр моделей автомобилей. Чтобы добавить новую модель:
 *  1. создать CarModelDef (зоны, регламент, фабрика create() → ModelRig);
 *  2. добавить её в этот список.
 * Данные пользователя ссылаются на модель по id, а на узлы — по zoneId,
 * поэтому новые модели ничего не ломают в уже сохранённых записях.
 */
/** Обёртка для моделей из glTF: `defineGltfModel({ ...описание, url: '/models/my-car.glb' })`. */
export const defineGltfModel = (d: GltfModelDef): CarModelDef => ({
  ...d,
  create: async (color) => (await import('./gltf')).loadGltfRig(d.url, d.zones, color),
});

const fetchPkg = (url: string) => async () => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Не удалось загрузить модель (${r.status})`);
  return r.arrayBuffer();
};

const porsche930 = defineImportedModel({
  id: 'coupe-porsche-930',
  name: 'Porsche 911 Turbo (930, 1975)',
  description: 'Купе с задним расположением двигателя. Кузов цельный — двери не открываются. Модель: Lexyc16, CC BY 4.0.',
  shape: { body: 'coupe', layout: 'rear' },
  defaultColor: '#8a9099',
  load: fetchPkg('/models/porsche-930.glb'),
});
const porsche4s = defineImportedModel({
  id: 'coupe-porsche-4s',
  name: 'Porsche 911 Carrera 4S',
  description: 'Купе с задним расположением двигателя. Кузов цельный — двери не открываются. Модель: Karol Miklas, CC BY-SA 4.0.',
  shape: { body: 'coupe', layout: 'rear' },
  defaultColor: '#a3161f',
  load: fetchPkg('/models/porsche-4s.glb'),
});

const models: CarModelDef[] = [bmw116i, solaris, bmw116iLite, porsche4s, porsche930];

/** Модели пользователя (из IndexedDB) — добавляются во время работы. */
const extra: CarModelDef[] = [];
export const registerModel = (def: CarModelDef): void => {
  const i = extra.findIndex((m) => m.id === def.id);
  if (i >= 0) extra[i] = def;
  else extra.push(def);
};
export const unregisterModel = (id: string): void => {
  const i = extra.findIndex((m) => m.id === id);
  if (i >= 0) extra.splice(i, 1);
};
export const hasModel = (id: string): boolean => models.some((m) => m.id === id) || extra.some((m) => m.id === id);
export const listModels = (): readonly CarModelDef[] => [...models, ...extra];
export const getModel = (id: string): CarModelDef => extra.find((m) => m.id === id) ?? models.find((m) => m.id === id) ?? models[0];
