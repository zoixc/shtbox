import { effect, signal } from '@preact/signals';
import { Store } from './core/store';
import { openStorage } from './core/db';
import type { IssueKind, Spot } from './core/types';
import type { Layer } from './models/types';
import { getModel } from './models/registry';

export let store: Store;

export async function initStore(): Promise<Store> {
  store = new Store(await openStorage());
  await store.init();
  // статусы ТО зависят от «сегодня»
  setInterval(() => store.refreshToday(), 60_000);
  document.addEventListener('visibilitychange', () => store.refreshToday());
  return store;
}

export type SidebarTab = 'zone' | 'tasks' | 'issues' | 'log';

/** Черновик нового/редактируемого дефекта (управляет формой и превью на 3D-модели). */
export interface Draft {
  editId?: string;
  zoneId: string;
  kind: IssueKind;
  title: string;
  notes: string;
  priority: 0 | 1 | 2;
  cost: string;
  spot?: Spot;
}

export const ui = {
  layer: signal<Layer>('body'),
  selectedZone: signal<string | null>(null),
  tab: signal<SidebarTab>('zone'),
  openZones: signal<string[]>([]),
  draft: signal<Draft | null>(null),
  placing: signal(false),
  /** радиус метки на кузове, м */
  radius: signal(0.08),
  dialog: signal<null | 'car-new' | 'car-edit' | 'backup' | 'help'>(null),
  toast: signal<{ text: string; kind: 'ok' | 'err' } | null>(null),
  sheetOpen: signal(true),
  /** временный цвет кузова (предпросмотр в диалоге автомобиля) */
  previewColor: signal<string | null>(null),
};

let toastTimer = 0;
export function toast(text: string, kind: 'ok' | 'err' = 'ok'): void {
  ui.toast.value = { text, kind };
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (ui.toast.value = null), 3500);
}

export async function guard<T>(p: Promise<T>): Promise<T | undefined> {
  try {
    return await p;
  } catch (e) {
    toast(e instanceof Error ? e.message : 'Ошибка', 'err');
    return undefined;
  }
}

/** Активная модель автомобиля (по modelId активной машины). */
export function activeModel() {
  return getModel(store.activeCar.value?.modelId ?? '');
}

export function zoneLabel(id: string): string {
  return activeModel().zones.find((z) => z.id === id)?.label ?? id;
}

/** Выбрать узел (из списка/бейджа/3D). Переключает слой и открывает родителя при необходимости. */
export function selectZone(id: string | null): void {
  ui.selectedZone.value = id;
  if (id) {
    ui.tab.value = 'zone';
    ui.sheetOpen.value = true;
    const z = activeModel().zones.find((x) => x.id === id);
    if (z && !z.virtual) {
      if (ui.layer.value !== z.layer && !(z.layer === 'body' && ui.layer.value === 'body')) ui.layer.value = z.layer;
      if (z.requiresOpen && !ui.openZones.value.includes(z.requiresOpen)) viewerCommands.setOpen?.(z.requiresOpen, true);
    }
  }
  // при смене узла незавершённый черновик другого узла сбрасываем
  const d = ui.draft.peek();
  if (d && id !== d.zoneId && !ui.placing.peek()) ui.draft.value = null;
}

/** Императивные команды во Viewer (устанавливаются ViewerPane). */
export const viewerCommands: {
  setOpen?: (zone: string, open: boolean) => void;
  toggleOpen?: (zone: string) => void;
  setAllOpen?: (open: boolean) => void;
  view?: (preset: string) => void;
  openable?: () => { id: string; label: string }[];
} = {};

// Esc отменяет режим расстановки метки
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && ui.placing.value) ui.placing.value = false;
  });
}
void effect;

/** Смена слоя пользователем: сбрасываем выбор узла из другого слоя. */
export function setLayer(l: Layer): void {
  ui.layer.value = l;
  const id = ui.selectedZone.value;
  if (id) {
    const z = activeModel().zones.find((x) => x.id === id);
    if (z && !z.virtual && z.layer !== l) ui.selectedZone.value = null;
  }
}
