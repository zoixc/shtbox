import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { IdbStorage, MemoryStorage } from '../src/core/db';
import { addMonths } from '../src/core/dates';
import { dueInfo } from '../src/core/maintenance';
import { Store } from '../src/core/store';
import { ValidationError, parseBackup, parseBackupText } from '../src/core/validation';
import type { MaintenanceTask } from '../src/core/types';

const task = (o: Partial<MaintenanceTask> = {}): MaintenanceTask => ({
  id: 't1', carId: 'c1', zoneId: 'engine', title: 'Масло', notes: '', createdAt: 0, ...o,
});

describe('maintenance', () => {
  it('addMonths clamps to end of month', () => {
    expect(addMonths('2025-01-31', 1)).toBe('2025-02-28');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2025-11-15', 3)).toBe('2026-02-15');
  });
  it('unknown when never done', () => {
    expect(dueInfo(task({ everyKm: 10000 }), 5000, '2026-01-01').state).toBe('unknown');
  });
  it('by mileage', () => {
    const t = task({ everyKm: 10000, lastKm: 100000 });
    expect(dueInfo(t, 102000, '2026-01-01').state).toBe('ok');
    expect(dueInfo(t, 109200, '2026-01-01').state).toBe('soon');
    const d = dueInfo(t, 110500, '2026-01-01');
    expect(d.state).toBe('overdue');
    expect(d.leftKm).toBe(-500);
  });
  it('by time, whichever comes first', () => {
    const t = task({ everyKm: 15000, lastKm: 0, everyMonths: 12, lastDate: '2025-01-10' });
    expect(dueInfo(t, 100, '2025-06-01').state).toBe('ok');
    expect(dueInfo(t, 100, '2025-12-30').state).toBe('soon');
    const d = dueInfo(t, 100, '2026-02-01');
    expect(d.state).toBe('overdue');
    expect(d.nextDate).toBe('2026-01-10');
  });
});

describe('validation', () => {
  const base = { app: 'shtbox', version: 1, exportedAt: 'x' };
  it('rejects foreign files', () => {
    expect(() => parseBackup({ app: 'other' })).toThrow(ValidationError);
    expect(() => parseBackupText('{nope')).toThrow(ValidationError);
    expect(() => parseBackup([])).toThrow(ValidationError);
  });
  it('sanitizes and drops orphans', () => {
    const b = parseBackup({
      ...base,
      cars: [{ id: 'c1', name: '  Solaris  ', modelId: 'sedan-solaris', color: 'javascript:alert(1)', mileage: -5, evil: 1 }],
      issues: [
        { id: 'i1', carId: 'c1', zoneId: 'hood', kind: 'rust', title: 'x', spot: { p: [0, 1, 2], n: [0, 1, 0], r: 0.1 } },
        { id: 'i2', carId: 'nope', zoneId: 'hood', kind: 'rust', title: 'orphan' },
      ],
    });
    expect(b.cars[0].name).toBe('Solaris');
    expect(b.cars[0].color).toBe('#c9ccd1');
    expect(b.cars[0].mileage).toBe(0);
    expect('evil' in b.cars[0]).toBe(false);
    expect(b.issues).toHaveLength(1);
    expect(b.issues[0].spot?.r).toBe(0.1);
  });
  it('rejects bad ids / kinds', () => {
    expect(() => parseBackup({ ...base, cars: [{ id: '<img>', name: 'a', modelId: 'm' }] })).toThrow(ValidationError);
    expect(() =>
      parseBackup({ ...base, cars: [{ id: 'c', name: 'a', modelId: 'm' }], issues: [{ id: 'i', carId: 'c', zoneId: 'z', kind: 'zzz', title: 't' }] }),
    ).toThrow(ValidationError);
  });
});

describe('store', () => {
  async function fresh(kind: 'mem' | 'idb' = 'mem') {
    const s = new Store(kind === 'mem' ? new MemoryStorage() : await IdbStorage.open());
    await s.init();
    await s.addCar({ name: 'Solaris', modelId: 'sedan-solaris', mileage: 50000 });
    return s;
  }

  it('completing an issue writes an immutable journal entry and bumps mileage', async () => {
    const s = await fresh();
    const i = await s.addIssue({ zoneId: 'door_fl', kind: 'rust', title: 'Ржавчина на пороге двери', cost: 3000 });
    expect(s.zoneSummary.value.get('door_fl')?.open).toBe(1);
    await s.completeIssue(i.id, { date: '2026-05-01', mileage: 51000 });
    expect(s.zoneSummary.value.get('door_fl')).toBeUndefined();
    expect(s.carLogs.value).toHaveLength(1);
    expect(s.carLogs.value[0]).toMatchObject({ kind: 'bodywork', cost: 3000, mileage: 51000, zoneId: 'door_fl' });
    expect(s.activeCar.value?.mileage).toBe(51000);
    await s.reopenIssue(i.id);
    expect(s.carLogs.value).toHaveLength(0);
    expect(s.issues.value[0].status).toBe('open');
  });

  it('completing a task moves lastKm/lastDate and updates status', async () => {
    const s = await fresh();
    const t = await s.addTask({ zoneId: 'engine', title: 'Масло', everyKm: 10000, lastKm: 38000 });
    expect(s.taskDue.value.get(t.id)?.state).toBe('overdue');
    await s.completeTask(t.id, { date: '2026-05-01', cost: 4500 });
    expect(s.taskDue.value.get(t.id)?.state).toBe('ok');
    expect(s.tasks.value[0]).toMatchObject({ lastKm: 50000, lastDate: '2026-05-01' });
    const log = s.carLogs.value[0];
    expect(log.kind).toBe('maintenance');
    await s.deleteLog(log.id);
    expect(s.carLogs.value).toHaveLength(0);
  });

  it('persists to IndexedDB and reloads', async () => {
    const s = await fresh('idb');
    await s.addIssue({ zoneId: 'hood', kind: 'chip', title: 'Скол' });
    const s2 = new Store(await IdbStorage.open());
    await s2.init();
    expect(s2.cars.value).toHaveLength(1);
    expect(s2.issues.value[0].title).toBe('Скол');
  });

  it('export → import(replace) roundtrip', async () => {
    const s = await fresh();
    await s.addIssue({ zoneId: 'hood', kind: 'dent', title: 'Вмятина', spot: { p: [1, 1, 0], n: [0, 1, 0], r: 0.08 } });
    const json = JSON.stringify(s.exportBackup());
    const s2 = new Store(new MemoryStorage());
    await s2.init();
    await s2.importBackup(parseBackupText(json), 'replace');
    expect(s2.cars.value).toHaveLength(1);
    expect(s2.issues.value[0].spot?.r).toBe(0.08);
  });

  it('deleting a car cascades', async () => {
    const s = await fresh();
    await s.addIssue({ zoneId: 'hood', kind: 'todo', title: 'x' });
    await s.deleteCar(s.cars.value[0].id);
    expect(s.issues.value).toHaveLength(0);
    expect(s.activeCar.value).toBeUndefined();
  });
});
