import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { IdbStorage, MemoryStorage } from '../src/core/db';
import { Store } from '../src/core/store';
import { applyPreset, deletePreset, loadPresets, makePreset, presetFromJson, PRESETS_KEY, PRESET_LIMIT, presetToJson, sanitizePresets, savePreset } from '../src/import/presets';
import type { Profile } from '../src/import/types';

const profile = (patch: Partial<Profile> = {}): Profile => ({
  v: 1,
  title: 'Машина',
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
  parts: { p0: { n: 'Body', k: 'paint', m: 'Body' }, p1: { n: 'Hood', k: 'paint', m: 'Body' } },
  ...patch,
});

const makeStore = (kind: 'mem' | 'idb'): Promise<Store> | Store =>
  kind === 'mem' ? new Store(new MemoryStorage()) : IdbStorage.open().then((st) => new Store(st));

describe.each(['mem', 'idb'] as const)('пресеты разметки (%s)', (kind) => {
  it('сохраняются, читаются по одному и удаляются', async () => {
    const store = await makeStore(kind);
    const a = makePreset(profile({ title: 'A' }), '  BMW 116i  ', 1000, 'p1');
    const b = makePreset(profile({ title: 'B', body: 'sedan' }), 'Solaris', 2000, 'p2');
    let list = await savePreset(store, a);
    expect(list.map((p) => p.id)).toEqual(['p1']);
    expect(list[0].name).toBe('BMW 116i');
    list = await savePreset(store, b);
    expect(list.map((p) => p.id)).toEqual(['p2', 'p1']);
    expect((await loadPresets(store)).length).toBe(2);

    // повторное сохранение того же id заменяет, а не дублирует
    list = await savePreset(store, { ...b, name: 'Solaris II' });
    expect(list.map((p) => p.name)).toEqual(['Solaris II', 'BMW 116i']);

    list = await deletePreset(store, 'p2');
    expect(list.map((p) => p.id)).toEqual(['p1']);
    expect((await loadPresets(store)).length).toBe(1);
  });

  it('ограничивает количество и отбрасывает мусор', async () => {
    const store = await makeStore(kind);
    for (let i = 0; i < PRESET_LIMIT + 5; i++) await savePreset(store, makePreset(profile(), `Прессет ${i}`, i, `id-${i}`));
    const list = await loadPresets(store);
    expect(list.length).toBe(PRESET_LIMIT);
    expect(list[0].name).toBe(`Прессет ${PRESET_LIMIT + 4}`);

    await store.setMeta(PRESETS_KEY, [{ id: 'x', profile: { title: 'битый' } }, { id: '' }, null, 'строка']);
    expect(await loadPresets(store)).toEqual([]);
    expect(sanitizePresets('мусор')).toEqual([]);
  });
});

describe('применение и файлы пресетов', () => {
  it('переносит разметку на другую модель, сохраняя её габариты и детали', () => {
    const target = profile({
      title: 'Обновлённый файл',
      body: 'sedan',
      layout: 'rear',
      frame: { yaw: 90, scale: 0.9, offset: [1, 2, 3] },
      dims: { ...profile().dims, L: 4.5, axleF: 1.4, axleR: -1.4 },
      parts: { p0: { n: 'Body', k: 'trim', m: 'Body' }, p1: { n: 'Hood', k: 'paint', m: 'Body' }, p9: { n: 'Chrome', k: 'trim', m: 'Chrome' } },
      hinges: { door_fl: { x: 0.5, y: 0.8, z: 0.7 } },
      panelRegions: [{ zone: 'door_fl', projection: 'side', points: [[0, 0], [1, 0], [1, 1]], minAbsZ: 0.6, kinds: ['paint'] }],
      interior: 'fill',
    });
    const preset = profile({
      body: 'hatch',
      layout: 'front',
      driver: 'r',
      dims: { ...profile().dims, L: 4.32 },
      lines: { ...profile().lines, cowl: 0.7, belt: 1.0 },
      parts: { p0: { n: 'Body', k: 'paint', m: 'Body' }, p1: { n: 'Hood', k: 'glass', m: 'Body' }, p2: { n: 'Roof', k: 'paint', m: 'Roof' } },
      hinges: { hood: { x: 1.2, y: 0.9, z: 0 } },
      panelRegions: [{ zone: 'trunk', projection: 'top', points: [[0, 0], [0.4, 0], [0.4, 0.4]], kinds: ['paint'] }],
      interior: 'none',
      paint: ['Body', 'Roof'],
    });

    const { profile: result, changes } = applyPreset(target, preset);
    // правила перенесены
    expect(result.body).toBe('hatch');
    expect(result.layout).toBe('front');
    expect(result.driver).toBe('r');
    expect(result.lines.cowl).toBeCloseTo(0.7 * (4.5 / 4.32), 3);
    expect(result.hinges).toEqual({ hood: { x: 1.2, y: 0.9, z: 0 } });
    expect(result.panelRegions?.length).toBe(1);
    expect(result.panelRegions?.[0].zone).toBe('trunk');
    expect(result.interior).toBe('none');
    expect(result.parts.p0).toMatchObject({ k: 'paint', u: 1 });
    expect(result.parts.p1).toMatchObject({ k: 'glass', u: 1 });
    expect(result.parts.p9.k).toBe('trim'); // чужая деталь не тронута
    expect(result.paint).toEqual(['Body']);
    // своё осталось своим
    expect(result.frame).toEqual(target.frame);
    expect(result.dims.L).toBe(4.5);
    expect(result.title).toBe('Обновлённый файл');
    // исходный профиль не мутирован
    expect(target.body).toBe('sedan');
    expect(changes.length).toBeGreaterThan(3);
  });

  it('сообщает, когда переносить нечего', () => {
    const same = profile();
    const { changes } = applyPreset(same, profile());
    expect(changes).toEqual(['разметка уже совпадает с пресетом']);

    const { changes: empty } = applyPreset(same, profile({ parts: { p0: { n: 'Чужое', k: 'hide', m: 'Other' } }, paint: ['Other'], panelRegions: undefined, hinges: undefined, lines: same.lines }));
    expect(empty.join(' ')).toMatch(/не найдены в этой модели/);
  });

  it('переживает выгрузку и загрузку JSON', () => {
    const preset = makePreset(profile({ body: 'coupe' }), 'Купе', 1234, 'p1');
    const text = presetToJson(preset);
    const back = presetFromJson(text);
    expect(back.name).toBe('Купе');
    expect(back.profile.body).toBe('coupe');
    expect(back.profile.dims.L).toBe(4.32);
    expect(back.id).not.toBe(preset.id); // копия, а не тот же пресет

    expect(() => presetFromJson('не json')).toThrow(/не JSON-файл/);
    expect(() => presetFromJson('{"format":"other"}')).toThrow(/не похож на пресет/);
    expect(() => presetFromJson('{"format":"shtbox-preset","profile":{}}')).toThrow(/Некорректный профиль/);
  });
});
