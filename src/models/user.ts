/**
 * Модели пользователя: хранятся в IndexedDB на устройстве (`models` — небольшие записи с разметкой,
 * `modelfiles` — сам GLB-пакет). На сервер синхронизации не отправляются: он ограничен по размеру,
 * поэтому на втором устройстве модель подгружается файлом (см. «Модели» в меню).
 */
import type { Storage } from '../core/db';
import { parseProfile } from '../import/profile';
import type { BodyType, Profile } from '../import/types';
import { hasModel, registerModel, unregisterModel } from './registry';
import type { CarModelDef } from './types';
import { defineImportedModel } from './imported/define';

export const USER_PREFIX = 'user:';

export interface UserModelMeta {
  id: string;
  name: string;
  body: BodyType;
  layout: 'front' | 'rear';
  size: number;
  created: string;
  profile: Profile;
}

interface FileRec {
  id: string;
  glb: ArrayBuffer;
}

let metas: UserModelMeta[] = [];
export const userModels = (): readonly UserModelMeta[] => metas;
export const isUserModel = (id: string) => id.startsWith(USER_PREFIX);

async function define(st: Storage, m: UserModelMeta): Promise<CarModelDef> {
  return defineImportedModel({
    id: m.id,
    name: m.name,
    description: `Собственная модель. ${m.profile.credits?.author ? `Автор: ${m.profile.credits.author}. ` : ''}${m.profile.credits?.license ?? ''}`.trim(),
    shape: { body: m.body, layout: m.layout },
    profile: m.profile,
    load: async () => {
      const f = await st.get<FileRec>('modelfiles', m.id);
      if (!f) throw new Error('Файл модели не найден на этом устройстве');
      return f.glb;
    },
  });
}

/** При запуске: регистрирует сохранённые модели. Повреждённые записи пропускаются. */
export async function loadUserModels(st: Storage): Promise<void> {
  const all = await st.getAll<UserModelMeta>('models');
  metas = [];
  for (const m of all) {
    try {
      const profile = parseProfile(m.profile);
      const meta = { ...m, profile };
      registerModel(await define(st, meta));
      metas.push(meta);
    } catch (e) {
      console.warn('Пропущена повреждённая пользовательская модель', m.id, e);
    }
  }
}

export async function saveUserModel(st: Storage, meta: UserModelMeta, glb: Uint8Array): Promise<void> {
  const profile = parseProfile(meta.profile);
  const rec = { ...meta, profile, name: meta.name.trim().slice(0, 80) || profile.title, size: glb.byteLength };
  const buf = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer;
  await st.apply([
    { store: 'modelfiles', put: { id: rec.id, glb: buf } as { id: string } },
    { store: 'models', put: rec as unknown as { id: string } },
  ]);
  registerModel(await define(st, rec));
  metas = [...metas.filter((x) => x.id !== rec.id), rec];
}

export async function deleteUserModel(st: Storage, id: string): Promise<void> {
  await st.apply([
    { store: 'models', del: id },
    { store: 'modelfiles', del: id },
  ]);
  unregisterModel(id);
  metas = metas.filter((m) => m.id !== id);
}

export async function readUserModelFile(st: Storage, id: string): Promise<Uint8Array> {
  const f = await st.get<FileRec>('modelfiles', id);
  if (!f) throw new Error('Файл модели не найден');
  return new Uint8Array(f.glb.slice(0));
}

export { hasModel };
