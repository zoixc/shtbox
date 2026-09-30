/**
 * Отмена/возврат правок разметки и черновик мастера импорта.
 *
 * Разметка живёт только в состоянии компонента, поэтому:
 *  - история хранится снимками `Profile` (их не много: лимит `HISTORY_LIMIT`, снимок — сотни байт);
 *  - черновик пишется в IndexedDB (`meta`, ключ `import.draft`) с задержкой, чтобы не писать
 *    на каждое нажатие клавиши; в черновике нет GLB — только разметка и внешний вид;
 *  - восстановление возможно, только если выбран тот же исходник (отпечаток `sourceKey`).
 *
 * Черновик не входит в резервные копии и не уходит на сервер синхронизации: `meta` из них исключён.
 */
import type { Store } from '../core/store';
import { isPaintFinish, type PaintFinish } from '../data/paintFinish';
import { parseProfile } from './profile';
import type { Profile } from './types';

export const DRAFT_KEY = 'import.draft';
/** Поза открытых для проверки панелей — тоже в `meta`, чтобы не уходить на сервер. */
export const POSE_KEY = 'import.pose';
export const HISTORY_LIMIT = 60;

export interface History<T> {
  /** Запоминает состояние до правки; новая правка после отмены обрезает «будущее». */
  push(previous: T): void;
  /** Возвращает предыдущее состояние (или null, если истории нет). */
  undo(current: T): T | null;
  redo(current: T): T | null;
  reset(): void;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly depth: number;
}

export function createHistory<T>(limit = HISTORY_LIMIT): History<T> {
  let past: T[] = [];
  let future: T[] = [];
  return {
    push(previous) {
      past.push(previous);
      if (past.length > limit) past.shift();
      future = [];
    },
    undo(current) {
      const previous = past.pop();
      if (previous === undefined) return null;
      future.push(current);
      return previous;
    },
    redo(current) {
      const next = future.pop();
      if (next === undefined) return null;
      past.push(current);
      return next;
    },
    reset() {
      past = [];
      future = [];
    },
    get canUndo() {
      return past.length > 0;
    },
    get canRedo() {
      return future.length > 0;
    },
    get depth() {
      return past.length;
    },
  };
}

export interface ImportDraft {
  /** Отпечаток выбранных файлов: черновик применяется только к тому же исходнику. */
  source: string;
  savedAt: number;
  name: string;
  profile: Profile;
  color: string;
  colorCode: string;
  finish: PaintFinish | null;
}

/** Отпечаток набора файлов: имена + размеры, порядок не важен. */
export function sourceKey(files: readonly { name: string; size: number }[]): string {
  const text = files
    .map((file) => `${file.name.toLowerCase()}:${file.size}`)
    .sort()
    .join('|');
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  return hash.toString(36);
}

/** Данные из IndexedDB не считаем доверенными: всё проверяем и обрезаем. */
function sanitizeDraft(raw: unknown): ImportDraft | null {
  if (!raw || typeof raw !== 'object') return null;
  const draft = raw as Record<string, unknown>;
  if (typeof draft.source !== 'string' || !draft.source || typeof draft.savedAt !== 'number' || !Number.isFinite(draft.savedAt)) return null;
  let profile: Profile;
  try {
    profile = parseProfile(draft.profile);
  } catch {
    return null;
  }
  const color = typeof draft.color === 'string' && /^#[0-9a-f]{6}$/i.test(draft.color) ? draft.color.toLowerCase() : '#b9bec6';
  const colorCode = typeof draft.colorCode === 'string' ? draft.colorCode.trim().slice(0, 24) : '';
  const name = typeof draft.name === 'string' && draft.name.trim() ? draft.name.trim().slice(0, 80) : profile.title;
  return {
    source: draft.source.slice(0, 200),
    savedAt: draft.savedAt,
    name,
    profile,
    color,
    colorCode,
    finish: isPaintFinish(draft.finish) ? draft.finish : null,
  };
}

export async function saveDraft(store: Store, draft: ImportDraft): Promise<void> {
  await store.setMeta(DRAFT_KEY, draft);
}

export async function loadDraft(store: Store): Promise<ImportDraft | null> {
  try {
    return sanitizeDraft(await store.getMeta<unknown>(DRAFT_KEY));
  } catch {
    return null;
  }
}

export async function clearDraft(store: Store): Promise<void> {
  await store.setMeta(DRAFT_KEY, null);
}

/** Запоминает, какие панели были открыты для проверки зазоров (не влияет на модель). */
export async function savePose(store: Store, zones: readonly string[]): Promise<void> {
  await store.setMeta(POSE_KEY, zones.slice(0, 40));
}

export async function loadPose(store: Store): Promise<string[]> {
  try {
    const raw = await store.getMeta<unknown>(POSE_KEY);
    return Array.isArray(raw) ? raw.filter((z): z is string => typeof z === 'string').slice(0, 40) : [];
  } catch {
    return [];
  }
}
