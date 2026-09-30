import type { CarModelDef, GltfModelDef } from './types';
import { bmw116i, bmw116iLite } from './hatch/bmw116i';
import { solaris } from './sedan/solaris';

/**
 * Реестр моделей автомобилей. Чтобы добавить новую модель:
 *  1. создать CarModelDef (зоны, регламент, фабрика create() → ModelRig);
 *  2. добавить её в этот список.
 * Данные пользователя ссылаются на модель по id, а на узлы — по zoneId,
 * поэтому новые модели ничего не ломают в уже сохранённых записях. Для неизвестного id используется пустая
 * заглушка, а не случайно первый автомобиль из реестра.
 */
/** Обёртка для моделей из glTF: `defineGltfModel({ ...описание, url: '/models/my-car.glb' })`. */
export const defineGltfModel = (d: GltfModelDef): CarModelDef => ({
  ...d,
  create: async (color) => (await import('./gltf')).loadGltfRig(d.url, d.zones, color),
});

const models: CarModelDef[] = [bmw116i, solaris, bmw116iLite];

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

// Keep synced/older car records usable without silently showing an unrelated default vehicle.
const unavailableModels = new Map<string, CarModelDef>();
function unavailableModel(id: string): CarModelDef {
  let def = unavailableModels.get(id);
  if (def) return def;
  def = {
    id,
    name: 'Модель не загружена',
    description: 'Загрузите пакет этой модели, чтобы восстановить 3D-разметку. Записи автомобиля сохранены.',
    defaultColor: '#b9bec6',
    zones: [],
    defaultMaintenance: [],
    create: async () => {
      const { Group } = await import('three');
      const root = new Group();
      return {
        root,
        paint: new Map(),
        pick: new Map(),
        openables: new Map(),
        anchors: new Map(),
        facing: new Map(),
        shell: [],
        setColor: () => {},
        bounds: { center: [0, 0.7, 0], radius: 2.4 },
        dispose: () => {},
      };
    },
  };
  unavailableModels.set(id, def);
  return def;
}

export const getModel = (id: string): CarModelDef => extra.find((m) => m.id === id) ?? models.find((m) => m.id === id) ?? unavailableModel(id);
