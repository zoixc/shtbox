import type { CarModelDef } from './types';
import { solaris } from './sedan/solaris';

/**
 * Реестр моделей автомобилей. Чтобы добавить новую модель:
 *  1. создать CarModelDef (зоны, регламент, фабрика create() → ModelRig);
 *  2. добавить её в этот список.
 * Данные пользователя ссылаются на модель по id, а на узлы — по zoneId,
 * поэтому новые модели ничего не ломают в уже сохранённых записях.
 */
const models: CarModelDef[] = [solaris];

export const listModels = (): readonly CarModelDef[] => models;
export const getModel = (id: string): CarModelDef => models.find((m) => m.id === id) ?? models[0];
