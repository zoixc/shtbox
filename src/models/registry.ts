import type { CarModelDef, GltfModelDef } from './types';
import { bmw116i } from './hatch/bmw116i';
import { solaris } from './sedan/solaris';

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

const models: CarModelDef[] = [solaris, bmw116i];

export const listModels = (): readonly CarModelDef[] => models;
export const getModel = (id: string): CarModelDef => models.find((m) => m.id === id) ?? models[0];
