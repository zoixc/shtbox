import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { IdbStorage, MemoryStorage } from '../src/core/db';
import { Store } from '../src/core/store';
import { clearDraft, createHistory, DRAFT_KEY, HISTORY_LIMIT, loadDraft, saveDraft, sourceKey } from '../src/import/history';
import type { Profile } from '../src/import/types';

/** Валидная разметка минимального размера: `parseProfile` проверяет каждое поле. */
const profileOf = (title: string): Profile => ({
  v: 1,
  title,
  body: 'hatch',
  layout: 'front',
  driver: 'l',
  frame: { yaw: 0, scale: 1, offset: [0, 0, 0] },
  dims: { L: 4.32, W: 1.76, H: 1.42, xFront: 2.16, xRear: -2.16, axleF: 1.345, axleR: -1.345, track: 0.76, wheelR: 0.32 },
  lines: {
    bumperFront: 1.94, cowl: 0.62, doorFront: 0.56, roofFront: -0.05, doorSplit: -0.42, roofRear: -1.32,
    doorRear: -1.26, trunkFront: -1.95, bumperRear: -1.99, sill: 0.26, belt: 0.9, bumperTopF: 0.5,
    bumperTopR: 0.45, hoodHw: 0.72, trunkHw: 0.55,
  },
  paint: ['Body'],
  parts: { p0: { n: 'Body', k: 'paint', m: 'Body' } },
});

const makeStore = (kind: 'mem' | 'idb'): Promise<Store> | Store =>
  kind === 'mem' ? new Store(new MemoryStorage()) : IdbStorage.open().then((st) => new Store(st));

describe.each(['mem', 'idb'] as const)('история правок и черновик (%s)', (kind) => {
  it('отменяет и возвращает состояния, лимит и сброс работают', () => {
    const history = createHistory<number>(3);
    expect([history.canUndo, history.canRedo, history.depth]).toEqual([false, false, 0]);

    history.push(1);
    history.push(2);
    expect(history.undo(3)).toBe(2);
    expect(history.undo(2)).toBe(1);
    expect(history.canUndo).toBe(false);
    expect(history.undo(1)).toBeNull();

    // после новой правки «будущее» обрезается
    history.push(1);
    expect(history.canRedo).toBe(false);
    expect(history.redo(2)).toBeNull();

    for (let i = 0; i < 10; i++) history.push(i);
    expect(history.depth).toBe(3);
    expect(history.undo(10)).toBe(9);
    expect(history.redo(9)).toBe(10);

    history.reset();
    expect([history.canUndo, history.canRedo]).toEqual([false, false]);
  });

  it('пишет и читает черновик, отбрасывая мусор', async () => {
    const store = await makeStore(kind);
    const draft = {
      source: 'abc',
      savedAt: 1_700_000_000_000,
      name: 'BMW',
      profile: profileOf('BMW 116i'),
      color: '#B9BEC6',
      colorCode: '475',
      finish: 'metallic' as const,
    };
    await saveDraft(store, draft);
    const loaded = await loadDraft(store);
    // parseProfile нормализует профиль (добавляет provenance), поэтому сверяем по полям
    expect(loaded).toMatchObject({ ...draft, color: '#b9bec6', profile: { title: 'BMW 116i', v: 1, body: 'hatch' } });

    // битые отметки времени и профили не восстанавливаются
    await store.setMeta(DRAFT_KEY, { source: 'abc', savedAt: 'вчера', profile: profileOf('x') });
    expect(await loadDraft(store)).toBeNull();
    await store.setMeta(DRAFT_KEY, { source: 'abc', savedAt: 1, profile: { title: 'x' } });
    expect(await loadDraft(store)).toBeNull();

    // цвет/код/покрытие из хранилища тоже проверяются
    await store.setMeta(DRAFT_KEY, { source: 'abc', savedAt: 1, profile: profileOf('x'), color: 'нет', finish: 'мокрый' });
    const repaired = await loadDraft(store);
    expect(repaired).toMatchObject({ color: '#b9bec6', colorCode: '', finish: null, name: 'x' });
    expect(repaired?.profile.title).toBe('x');

    await clearDraft(store);
    expect(await loadDraft(store)).toBeNull();
  });

  it('отпечаток исходника не зависит от порядка файлов', () => {
    const a = sourceKey([{ name: 'Model.GLTF', size: 10 }, { name: 'mesh.bin', size: 20 }]);
    const b = sourceKey([{ name: 'mesh.bin', size: 20 }, { name: 'model.gltf', size: 10 }]);
    expect(a).toBe(b);
    expect(sourceKey([{ name: 'model.gltf', size: 11 }, { name: 'mesh.bin', size: 20 }])).not.toBe(a);
    expect(HISTORY_LIMIT).toBeGreaterThanOrEqual(20);
  });

  it('черновик не переживает сохранение модели', async () => {
    const store = await makeStore(kind);
    await saveDraft(store, {
      source: 'x', savedAt: Date.now(), name: 'x', profile: profileOf('x'),
      color: '#b9bec6', colorCode: '', finish: null,
    });
    expect(await loadDraft(store)).not.toBeNull();
    await clearDraft(store);
    expect(await loadDraft(store)).toBeNull();
  });
});
