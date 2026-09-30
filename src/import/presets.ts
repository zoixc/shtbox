/**
 * Пресеты разметки (P1): сохранить разметку одной модели без GLB и применить её к другой модели
 * той же машины — например, когда пришла обновлённая версия файла или модель скачана заново.
 *
 * Пресет — это профиль (`Profile`) без геометрии: тип кузова, линии, петли, маски, типы деталей
 * и список окрашиваемых материалов. Из целевой модели берутся её собственные рамка, габариты и
 * детали, поэтому применение безопасно: ничего не «приклеивается» от чужого файла.
 *
 * Хранение — `meta` в IndexedDB: пресеты локальны для устройства, не входят в резервные копии
 * и не уходят на сервер синхронизации.
 */
import { uid } from '../core/id';
import type { Store } from '../core/store';
import { parseProfile } from './profile';
import type { PartInfo, Profile } from './types';

export const PRESETS_KEY = 'import.presets';
/** Больше сорока пресетов пользователю не нужно, а `meta` — не файловое хранилище. */
export const PRESET_LIMIT = 40;

export interface Preset {
  id: string;
  name: string;
  created: number;
  profile: Profile;
}

const key = (part: PartInfo): string => `${part.m.toLowerCase()}\u0000${part.n.toLowerCase()}`;

/** Короткое имя пресета из названия модели: без пути, лишних пробелов и слишком длинное не бывает. */
export function presetName(raw: string): string {
  const name = raw.replace(/\s+/g, ' ').trim().slice(0, 60);
  return name || 'Разметка без названия';
}

export function makePreset(profile: Profile, name: string, created = Date.now(), id = uid()): Preset {
  return { id, name: presetName(name), created, profile };
}

/** Данные из IndexedDB не считаем доверенными: каждый профиль проверяется `parseProfile`. */
export function sanitizePresets(raw: unknown): Preset[] {
  if (!Array.isArray(raw)) return [];
  const out: Preset[] = [];
  for (const item of raw.slice(0, PRESET_LIMIT)) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== 'string' || !record.id) continue;
    try {
      out.push({
        id: record.id.slice(0, 64),
        name: presetName(typeof record.name === 'string' ? record.name : ''),
        created: typeof record.created === 'number' && Number.isFinite(record.created) ? record.created : Date.now(),
        profile: parseProfile(record.profile),
      });
    } catch {
      // повреждённый пресет пропускаем, остальные остаются рабочими
    }
  }
  return out;
}

export async function loadPresets(store: Store): Promise<Preset[]> {
  try {
    return sanitizePresets(await store.getMeta<unknown>(PRESETS_KEY));
  } catch {
    return [];
  }
}

/** Добавляет пресет (свежие — первыми) и возвращает новый список. */
export async function savePreset(store: Store, preset: Preset): Promise<Preset[]> {
  const list = [preset, ...(await loadPresets(store)).filter((item) => item.id !== preset.id)].slice(0, PRESET_LIMIT);
  await store.setMeta(PRESETS_KEY, list);
  return list;
}

export async function deletePreset(store: Store, id: string): Promise<Preset[]> {
  const list = (await loadPresets(store)).filter((item) => item.id !== id);
  await store.setMeta(PRESETS_KEY, list);
  return list;
}

export interface ApplyResult {
  profile: Profile;
  /** Человекочитаемый список изменений — показывается пользователю. */
  changes: string[];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Применяет разметку пресета к целевой модели: переносятся «правила» (тип кузова, ориентация,
 * линии, петли, маски, салон, типы деталей по материалу и имени, окрашиваемые материалы).
 * Рамка, габариты, детали и атрибуция остаются от цели.
 */
export function applyPreset(base: Profile, preset: Profile): ApplyResult {
  const next = structuredClone(base);
  const changes: string[] = [];

  if (next.body !== preset.body) changes.push(`тип кузова: ${next.body} → ${preset.body}`);
  if (next.layout !== preset.layout) changes.push(`компоновка: ${next.layout} → ${preset.layout}`);
  if (next.driver !== preset.driver) changes.push(`сторона руля: ${next.driver} → ${preset.driver}`);
  next.body = preset.body;
  next.layout = preset.layout;
  next.driver = preset.driver;

  if (!same(base.lines, preset.lines)) {
    // Линии — в метрах системы автомобиля, поэтому при другой длине их полезно подогнать по масштабу.
    const k = base.dims.L > 0 && preset.dims.L > 0 ? base.dims.L / preset.dims.L : 1;
    if (Math.abs(k - 1) > 0.01) changes.push(`линии кузова подогнаны по длине (×${k.toFixed(3)})`);
    else changes.push('линии кузова');
    for (const name of Object.keys(next.lines) as (keyof typeof next.lines)[]) {
      next.lines[name] = Number((preset.lines[name] * k).toFixed(3));
    }
  }

  if (preset.hinges && !same(base.hinges, preset.hinges)) {
    changes.push(`петли: ${Object.keys(preset.hinges).length}`);
    next.hinges = structuredClone(preset.hinges);
  }
  if (preset.panelRegions?.length) {
    const k = base.dims.L > 0 && preset.dims.L > 0 ? base.dims.L / preset.dims.L : 1;
    next.panelRegions = preset.panelRegions.map((region) => ({
      ...structuredClone(region),
      minAbsZ: region.minAbsZ === undefined ? undefined : Number((region.minAbsZ * k).toFixed(3)),
      points: region.points.map(([x, y]) => [Number((x * k).toFixed(3)), Number((y * k).toFixed(3))] as [number, number]),
    }));
    changes.push(`маски панелей: ${next.panelRegions.length}`);
  }
  if (preset.interior && preset.interior !== base.interior) {
    changes.push(`салон: ${preset.interior}`);
    next.interior = preset.interior;
  }

  // Типы деталей переносим по «материал + имя»: id деталей у разных файлов не совпадают.
  const presetParts = new Map(Object.values(preset.parts).map((part) => [key(part), part]));
  let partChanges = 0;
  for (const part of Object.values(next.parts)) {
    const from = presetParts.get(key(part));
    if (!from) continue;
    if (from.k !== part.k) {
      part.k = from.k;
      part.u = 1;
      delete part.confidence;
      partChanges++;
    }
    if (from.z && from.z !== part.z) {
      part.z = from.z;
      part.u = 1;
      partChanges++;
    }
  }
  if (partChanges) changes.push(`типы деталей: ${partChanges}`);

  const materials = new Set(Object.values(next.parts).map((part) => part.m));
  const paint = preset.paint.filter((name) => materials.has(name));
  if (paint.length && !same([...base.paint].sort(), [...paint].sort())) {
    changes.push(`окрашиваемые материалы: ${paint.length}`);
    next.paint = paint;
  } else if (preset.paint.length && !paint.length) {
    changes.push('окрашиваемые материалы пресета не найдены в этой модели — оставлены прежние');
  }

  if (!changes.length) changes.push('разметка уже совпадает с пресетом');
  return { profile: next, changes };
}

/** Выгрузка пресета в JSON (для переноса на другое устройство). */
export function presetToJson(preset: Preset): string {
  return JSON.stringify({ format: 'shtbox-preset', version: 1, name: preset.name, created: preset.created, profile: preset.profile }, null, 2);
}

/** Чтение пресета из JSON: формат проверяется, профиль санитизируется `parseProfile`. */
export function presetFromJson(text: string): Preset {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Это не JSON-файл пресета разметки');
  }
  const record = raw as Record<string, unknown>;
  if (!record || typeof record !== 'object' || record.format !== 'shtbox-preset') {
    throw new Error('Файл не похож на пресет разметки shtbox');
  }
  return makePreset(parseProfile(record.profile), typeof record.name === 'string' ? record.name : '', typeof record.created === 'number' ? record.created : Date.now(), uid());
}
